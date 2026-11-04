"""Resumable export with a SQLite manifest.

The manifest is the source of truth: a file is skipped only when the row is
done, the path exists and its size matches.  Downloads always write a temp
file and rename; a failure never overwrites a good file.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .events import json_safe

log = logging.getLogger("worker.export")

AREAS = ("photos", "hidden", "deleted", "notes", "drive", "contacts", "calendar", "reminders", "account")


def safe_name(value: Any, default: str = "unnamed") -> str:
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", str(value or ""))
    name = name.strip(" .")
    return name[:120] or default


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class Manifest:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS files (
                key TEXT PRIMARY KEY,
                area TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                sha256 TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'done',
                updated TEXT NOT NULL
            )"""
        )
        self.db.commit()

    def get(self, key: str):
        row = self.db.execute(
            "SELECT key, area, path, size, sha256, status FROM files WHERE key=?",
            (key,),
        ).fetchone()
        if not row:
            return None
        return dict(zip(("key", "area", "path", "size", "sha256", "status"), row))

    def needs(self, key: str, path: Path, size: int = 0) -> bool:
        row = self.get(key)
        if not row or row["status"] != "done":
            return True
        target = Path(row["path"])
        if not target.exists():
            return True
        actual = target.stat().st_size
        if size and actual != size:
            return True
        if row["sha256"] and file_sha256(target) != row["sha256"]:
            return True
        return False

    def mark(self, key: str, area: str, path: Path, size: int, sha: str, status: str = "done"):
        self.db.execute(
            """INSERT INTO files(key, area, path, size, sha256, status, updated)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET
                 area=excluded.area, path=excluded.path, size=excluded.size,
                 sha256=excluded.sha256, status=excluded.status, updated=excluded.updated""",
            (key, area, str(path), int(size), sha, status, datetime.now(timezone.utc).isoformat()),
        )
        self.db.commit()

    def summary(self) -> dict:
        rows = self.db.execute(
            "SELECT area, COUNT(*), COALESCE(SUM(size),0) FROM files WHERE status='done' GROUP BY area"
        ).fetchall()
        return {
            area: {"done": count, "bytes": size}
            for area, count, size in rows
        }


class Exporter:
    """One instance per export job; never share pyicloud across threads."""

    def __init__(self, ctx, *, export_dir: str, mode: str = "missing"):
        self.ctx = ctx
        self.mode = mode
        self.root = Path(export_dir) / safe_name(ctx.account.get("email", "account"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest = Manifest(self.root / "manifest.sqlite3")
        self.tasks: list[dict] = []
        self.done = 0
        self.failed = 0
        self.bytes = 0
        self.areas: dict[str, dict] = {
            area: {"done": 0, "total": 0, "bytes": 0} for area in AREAS
        }
        self._last_emit = 0.0

    # ------------------------------------------------------------- enumeration

    def add(
        self,
        *,
        area: str,
        key: str,
        path: Path,
        size: int,
        fetch: Callable[[], Any],
        kind: str = "stream",
    ):
        if not contained(self.root, path):
            path = self.root / safe_name(path.name)
        self.tasks.append(
            {
                "area": area,
                "key": key,
                "path": path,
                "size": int(size or 0),
                "fetch": fetch,
                "kind": kind,
            }
        )
        self.areas.setdefault(area, {"done": 0, "total": 0, "bytes": 0})
        self.areas[area]["total"] += 1

    def add_json(self, area: str, key: str, relpath: str, data: Any):
        path = self.root / relpath
        payload = json.dumps(json_safe(data), indent=2, ensure_ascii=False).encode("utf-8")
        self.add(
            area=area,
            key=key,
            path=path,
            size=len(payload),
            fetch=lambda payload=payload: payload,
            kind="bytes",
        )

    def enumerate_photos(self, api, seen: set[str]):
        try:
            albums = api.photos.albums
        except Exception:
            return
        plan = [
            ("hidden", "Hidden"),
            ("deleted", "Recently Deleted"),
            ("photos", "Library"),
        ]
        for area, album_name in plan:
            try:
                album = api.photos.albums[album_name]
            except Exception:
                continue
            self._add_album(api, album, area, album_name, seen)
        try:
            for album in albums:
                name = str(getattr(album, "name", "") or "album")
                if name in ("Hidden", "Recently Deleted", "Library"):
                    continue
                self._add_album(api, album, "photos", name, seen)
        except Exception:
            pass

    def _add_album(self, api, album, area: str, album_name: str, seen: set[str]):
        try:
            assets = list(album)
        except Exception:
            return
        for asset in assets:
            asset_id = str(getattr(asset, "id", "") or "")
            if not asset_id or asset_id in seen:
                continue
            seen.add(asset_id)
            try:
                versions = getattr(asset, "versions", {}) or {}
                original = versions.get("original") or {}
                url = original.get("url")
                if not url:
                    continue
                size = int(original.get("size") or getattr(asset, "size", 0) or 0)
                filename = safe_name(
                    original.get("filename") or getattr(asset, "filename", "") or asset_id,
                    f"{asset_id}.bin",
                )
                dest = self.root / "Photos" / safe_name(album_name) / f"{safe_name(asset_id[:8])}_{filename}"
                key = f"photo:{asset_id}"

                def fetch(url=url):
                    return api.session.get(url, stream=True, timeout=(20, 120))

                self.add(
                    area=area,
                    key=key,
                    path=dest,
                    size=size,
                    fetch=fetch,
                    kind="stream",
                )
            except Exception as error:
                log.info("photo enumerate failed: %s", type(error).__name__)

    def enumerate_notes(self, api):
        try:
            summaries = [s for s in api.notes.iter_all() if not getattr(s, "is_deleted", False)]
        except Exception:
            return
        for summary in summaries:
            note_id = str(getattr(summary, "id", "") or "")
            if not note_id:
                continue
            title = safe_name(getattr(summary, "title", "") or note_id)
            dest = self.root / "Notes" / "txt" / f"{safe_name(note_id[:8])}_{title}.txt"
            key = f"note:{note_id}"

            def fetch(note_id=note_id, dest=dest):
                note = api.notes.get(note_id)
                text = getattr(note, "text", None) or getattr(note, "content", "") or ""
                header = f"{getattr(note, 'title', '')}\n{getattr(note, 'modified', '')}\n\n"
                try:
                    api.notes.export_note(note_id, str(self.root / "Notes" / "html"), export_mode="archival")
                except Exception:
                    pass
                return (header + str(text)).encode("utf-8")

            self.add(area="notes", key=key, path=dest, size=0, fetch=fetch, kind="bytes")

    def enumerate_drive(self, api):
        try:
            root = api.drive.root
        except Exception:
            return
        stack = [(root, self.root / "Drive")]
        seen = set()
        while stack:
            node, dest_dir = stack.pop()
            try:
                children = node.get_children()
            except Exception:
                continue
            for child in children or []:
                name = safe_name(getattr(child, "name", "") or "file")
                if getattr(child, "type", "") == "folder":
                    stack.append((child, dest_dir / name))
                    continue
                key = f"drive:{getattr(child, 'name', '')}:{getattr(child, 'size', 0)}"
                if key in seen:
                    continue
                seen.add(key)
                size = int(getattr(child, "size", 0) or 0)
                dest = dest_dir / name

                def fetch(child=child):
                    response = child.open(stream=True, timeout=(20, 120))
                    return response

                self.add(area="drive", key=key, path=dest, size=size, fetch=fetch)

    def enumerate_json(self, api):
        def contacts():
            return {
                "me": getattr(getattr(api.contacts, "me", None), "raw_data", {}),
                "contacts": api.contacts.all or [],
            }

        self.add_json(
            "contacts",
            "contacts:all",
            "Contacts/contacts.json",
            _guard(contacts, {}),
        )

        def calendars():
            calendars = api.calendar.get_calendars()
            events = api.calendar.get_events(period="month")
            return {"calendars": calendars, "events": events}

        self.add_json(
            "calendar",
            "calendar:month",
            "Calendar/calendars.json",
            _guard(calendars, {}),
        )

        def reminders():
            out = []
            for reminders_list in api.reminders.lists():
                try:
                    result = api.reminders.list_reminders(
                        reminders_list.id, include_completed=True
                    )
                    out.append({"list": reminders_list, "reminders": result.reminders})
                except Exception:
                    continue
            return out

        self.add_json(
            "reminders",
            "reminders:all",
            "Reminders/reminders.json",
            _guard(reminders, []),
        )

        def account():
            storage = _guard(lambda: api.account.storage, None)
            return {
                "email": self.ctx.account.get("email", ""),
                "storage": storage,
                "plan": _guard(lambda: api.account.summary_plan, {}),
                "devices": _guard(lambda: api.account.devices, []),
                "family": _guard(lambda: api.account.family, []),
            }

        self.add_json("account", "account:info", "Account/account.json", _guard(account, {}))

    # ------------------------------------------------------------------ run

    def run(self) -> dict:
        api = self.ctx.api
        seen: set[str] = set()
        if api is not None:
            self.enumerate_photos(api, seen)
            self.enumerate_notes(api)
            self.enumerate_drive(api)
            self.enumerate_json(api)

        total = len(self.tasks)
        for index, task in enumerate(self.tasks, 1):
            if self.mode != "force" and not self.manifest.needs(
                task["key"], task["path"], task["size"]
            ):
                self.done += 1
                area = self.areas[task["area"]]
                area["done"] += 1
                area["bytes"] += int(task["path"].stat().st_size if task["path"].exists() else 0)
                self.bytes += int(task["path"].stat().st_size if task["path"].exists() else 0)
                self._progress(task["area"], total, index)
                continue
            try:
                written = self.download(task)
                self.manifest.mark(
                    task["key"],
                    task["area"],
                    task["path"],
                    written["size"],
                    written["sha256"],
                )
                self.done += 1
                self.bytes += written["size"]
                self.areas[task["area"]]["done"] += 1
                self.areas[task["area"]]["bytes"] += written["size"]
            except Exception as error:
                self.failed += 1
                self.manifest.mark(
                    task["key"], task["area"], task["path"], 0, "", status="failed"
                )
                log.info("export item failed: %s", type(error).__name__)
            self._progress(task["area"], total, index)

        totals = {
            "done": self.done,
            "failed": self.failed,
            "total": total,
            "bytes": self.bytes,
            "areas": self.areas,
        }
        self.ctx.emit(
            "job:export_done",
            {
                "manifest": str(self.manifest.path),
                "totals": totals,
            },
        )
        return totals

    def _progress(self, area: str, total: int, index: int):
        now = time.monotonic()
        if now - self._last_emit < 1.0 and index != total:
            return
        self._last_emit = now
        overall = sum(item["done"] for item in self.areas.values())
        self.ctx.emitter.progress(
            {
                "area": area,
                "done": self.areas.get(area, {}).get("done", 0),
                "total": self.areas.get(area, {}).get("total", 0),
                "bytes": self.areas.get(area, {}).get("bytes", 0),
                "overallDone": overall,
                "overallTotal": total,
                "areas": self.areas,
            },
            area="overall",
            throttle=1.0,
        )

    def download(self, task: dict) -> dict:
        path: Path = task["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".{time.time_ns()}.part")
        last = None
        for attempt in range(3):
            try:
                result = task["fetch"]()
                if task["kind"] == "bytes":
                    data = result
                    with tmp.open("wb") as stream:
                        stream.write(data)
                else:
                    with tmp.open("wb") as stream:
                        response = result
                        if getattr(response, "status_code", None) is not None:
                            if response.status_code == 429:
                                wait = float(response.headers.get("retry-after", "2"))
                                time.sleep(min(wait, 30))
                                raise RuntimeError("rate limited")
                            response.raise_for_status()
                        for chunk in response.iter_content(1 << 20):
                            if chunk:
                                stream.write(chunk)
                        if hasattr(response, "close"):
                            response.close()
                size = tmp.stat().st_size
                if task["size"] and size != task["size"]:
                    raise RuntimeError(f"short file {size}/{task['size']}")
                digest = hashlib.sha256()
                with tmp.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1 << 20), b""):
                        digest.update(chunk)
                tmp.replace(path)
                return {"size": size, "sha256": digest.hexdigest()}
            except Exception as error:
                last = error
                tmp.unlink(missing_ok=True)
                time.sleep(1.5**attempt)
        raise last or RuntimeError("download failed")


def _guard(fn, default):
    try:
        return fn()
    except Exception:
        return default
