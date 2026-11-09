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
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .events import json_safe
from . import scan as scan_module

log = logging.getLogger("worker.export")

# Anything this large is deferred to the very end of the export.  A single
# huge drive file or video must never hold up notes, contacts or the rest of
# the small library behind it.
LARGE_BYTES = 100 * 1024 * 1024
LARGE_PRIORITY = 90

AREAS = ("photos", "hidden", "deleted", "notes", "drive", "contacts", "calendar", "reminders", "mail", "account")

# Small, high-value data first; photos and mail attachments last.  The
# dashboard then shows notes/contacts/calendar while a large library is still
# downloading.
AREA_PRIORITY = {
    "notes": 0,
    "contacts": 1,
    "calendar": 2,
    "reminders": 3,
    "account": 4,
    "mail": 5,
    "drive": 6,
    "photos": 7,
    "hidden": 8,
    "deleted": 8,
}

VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"}


def collect_counts(root: Path, areas: dict) -> dict:
    """Content counts from the export itself.

    The login-time inventory is a live snapshot; after an export (especially
    an incremental one that adds notes) the panel must show what is actually
    on disk.  Photos/notes/drive come from the manifest-backed area counter;
    contacts/calendar/reminders/mail are read from the JSON files written by
    this export.
    """
    counts: dict[str, int] = {}
    for area in ("photos", "hidden", "deleted", "notes"):
        counts[area] = int((areas.get(area) or {}).get("done", 0) or 0)
    counts["driveFiles"] = int((areas.get("drive") or {}).get("done", 0) or 0)
    counts["driveBytes"] = int((areas.get("drive") or {}).get("bytes", 0) or 0)

    try:
        data = json.loads((root / "Contacts" / "contacts.json").read_text(encoding="utf-8"))
        cards = data.get("contacts") if isinstance(data, dict) else []
        cards = cards if isinstance(cards, list) else []
        counts["contacts"] = len(cards)
        counts["contactsPhone"] = sum(
            1 for card in cards if isinstance(card, dict) and card.get("phones")
        )
        counts["contactsEmail"] = sum(
            1 for card in cards if isinstance(card, dict) and card.get("emails")
        )
    except Exception:
        pass

    try:
        data = json.loads((root / "Calendar" / "calendars.json").read_text(encoding="utf-8"))
        calendars = data.get("calendars") if isinstance(data, dict) else None
        if isinstance(calendars, list):
            counts["calendars"] = len(calendars)
    except Exception:
        pass

    try:
        data = json.loads((root / "Reminders" / "reminders.json").read_text(encoding="utf-8"))
        if isinstance(data, list):
            counts["reminders"] = sum(
                len((item or {}).get("reminders") or [])
                for item in data
                if isinstance(item, dict)
            )
    except Exception:
        pass

    try:
        data = json.loads((root / "Mail" / "index.json").read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("available") is not False:
            counts["mailFolders"] = len(data.get("folders") or [])
            counts["mailMessages"] = int(data.get("messages") or 0)
    except Exception:
        pass

    videos = 0
    photos_dir = root / "Photos"
    if photos_dir.exists():
        videos = sum(
            1
            for path in photos_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in VIDEO_EXT
        )
    counts["videos"] = videos
    return counts


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
        self.force = mode in ("force", "mail-force", "all-force")
        self.only_mail = mode in ("mail", "mail-force")
        self.phase = mode if mode in ("notes", "small", "drive", "photos", "videos") else ""
        self.include_mail = mode in ("mail", "mail-force", "all", "all-force")
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

    def _cancelled(self) -> bool:
        cancel = getattr(self.ctx, "cancel", None)
        return bool(cancel is not None and cancel.is_set())

    def add(
        self,
        *,
        area: str,
        key: str,
        path: Path,
        size: int,
        fetch: Callable[[], Any],
        kind: str = "stream",
        priority: int | None = None,
    ):
        if not contained(self.root, path):
            path = self.root / safe_name(path.name)
        if priority is None:
            priority = AREA_PRIORITY.get(area, 5)
        if area == "mail" and kind == "chunks":
            priority = 9
        if int(size or 0) >= LARGE_BYTES:
            priority = max(priority, LARGE_PRIORITY)
        self.tasks.append(
            {
                "area": area,
                "key": key,
                "path": path,
                "size": int(size or 0),
                "fetch": fetch,
                "kind": kind,
                "priority": priority,
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

    def enumerate_photos(self, api, seen: set[str], only: str = ""):
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
            if self._cancelled():
                return
            try:
                self._add_album(api, album, area, album_name, seen, only)
                self._drain(8)
            except Exception as error:
                log.info("photo album failed: %s", type(error).__name__)
        try:
            for album in albums:
                name = str(getattr(album, "name", "") or "album")
                if name in ("Hidden", "Recently Deleted", "Library"):
                    continue
                try:
                    self._add_album(api, album, "photos", name, seen, only)
                    self._drain(8)
                except Exception as error:
                    log.info("photo album failed: %s", type(error).__name__)
        except Exception:
            pass

    def _add_album(self, api, album, area: str, album_name: str, seen: set[str], only: str = ""):
        try:
            assets = iter(album)
        except Exception:
            return
        count = 0
        for asset in assets:
            if self._cancelled():
                return
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
                is_video = Path(filename).suffix.lower() in VIDEO_EXT
                if only == "image" and is_video:
                    continue
                if only == "video" and not is_video:
                    continue
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
                count += 1
                # Start downloading after every 50 assets, so the dashboard
                # shows new images while a 15k-photo album is still listing.
                if count % 50 == 0:
                    self._drain(8)
            except Exception as error:
                log.info("photo enumerate failed: %s", type(error).__name__)
        self._drain(8)

    def enumerate_notes(self, api):
        try:
            summaries = [s for s in api.notes.iter_all() if not getattr(s, "is_deleted", False)]
        except Exception:
            return
        for summary in summaries:
            if self._cancelled():
                return
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
            if self._cancelled():
                return
            node, dest_dir = stack.pop()
            try:
                children = node.get_children()
            except Exception:
                continue
            for child in children or []:
                if self._cancelled():
                    return
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
                    # Some drive nodes (e.g. the "Shortcuts" folder) come
                    # back without a size in their metadata; pyicloud's
                    # downloader indexes data["size"] unconditionally.
                    try:
                        data = getattr(child, "data", None)
                        if isinstance(data, dict) and "size" not in data:
                            data["size"] = int(getattr(child, "size", 0) or 0)
                    except Exception:
                        pass
                    return child.open(stream=True, timeout=(20, 120))

                self.add(area="drive", key=key, path=dest, size=size, fetch=fetch)

    def enumerate_mail(self, api):
        """Export the experimental iCloud Mail surface when the installed
        pyicloud exposes it (main/2026.10.2+). 2026.10.1 has no api.mail, so
        record a clear availability marker instead of silently skipping it."""
        mail = _guard(lambda: getattr(api, "mail", None), None)
        if mail is None:
            self.add_json(
                "mail",
                "mail:available",
                "Mail/index.json",
                {
                    "available": False,
                    "reason": "installed pyicloud has no Mail service (install main/2026.10.2+)",
                    "folders": [],
                    "messages": 0,
                },
            )
            return

        folders = _guard(lambda: mail.folders(), []) or []
        index = {
            "available": True,
            "folders": [],
            "messages": 0,
            "attachments": 0,
        }
        all_messages: list[dict] = []

        for folder in folders:
            folder_name = safe_name(
                f"{str(getattr(folder, 'id', '') or '')[:8]}_"
                f"{getattr(folder, 'name', '') or 'mail'}"
            )
            folder_index = {
                "id": getattr(folder, "id", ""),
                "name": getattr(folder, "name", ""),
                "messages": 0,
            }
            try:
                iterator = mail.iter_messages(
                    folder, page_size=50, max_pages=10000
                )
                for message in iterator:
                    uid = str(getattr(message, "uid", "") or "")
                    mid = str(getattr(message, "id", "") or uid or "message")
                    if not uid:
                        continue
                    meta = _message_json(message)
                    meta["path"] = f"Mail/{folder_name}/{safe_name(mid)}.json"
                    try:
                        stamp = float(getattr(message, "internal_date", 0) or 0)
                        if stamp:
                            meta["date"] = datetime.fromtimestamp(
                                stamp, timezone.utc
                            ).isoformat()
                    except (TypeError, ValueError, OSError):
                        meta["date"] = ""
                    all_messages.append(meta)

                    def fetch(message=message):
                        body = _guard(lambda: mail.body(message), None)
                        payload = {
                            "message": _message_json(message, include_parts=True),
                            "body": _jsonable(body),
                        }
                        return json.dumps(
                            json_safe(payload), indent=2, ensure_ascii=False
                        ).encode("utf-8")

                    self.add(
                        area="mail",
                        key=f"mail:{getattr(folder, 'id', '')}:{mid}",
                        path=self.root / meta["path"],
                        size=0,
                        fetch=fetch,
                        kind="bytes",
                    )
                    folder_index["messages"] += 1
                    index["messages"] += 1

                    for part_index, part in enumerate(getattr(message, "parts", []) or []):
                        if not getattr(part, "is_attachment", False):
                            continue
                        filename = safe_name(
                            getattr(part, "filename", "") or f"part-{part_index + 1}"
                        )
                        dest = (
                            self.root / "Mail" / folder_name / "attachments"
                            / f"{safe_name(mid)}-{part_index + 1}-{filename}"
                        )
                        if getattr(part, "mail_drop_url", None):
                            def fetch_attachment(message=message, part_index=part_index):
                                return mail.mail_drop_attachment(message, part_index + 1)
                        else:
                            def fetch_attachment(message=message, part=part):
                                return mail.attachment(message, part.id)
                        self.add(
                            area="mail",
                            key=f"mailpart:{getattr(folder, 'id', '')}:{mid}:{part_index}",
                            path=dest,
                            size=int(getattr(part, "size", 0) or 0),
                            fetch=fetch_attachment,
                            kind="chunks",
                        )
                        folder_index.setdefault("attachments", 0)
                        folder_index["attachments"] += 1
                        index["attachments"] += 1
            except Exception as error:
                log.info("mail folder %s failed: %s", folder_index["name"], type(error).__name__)
            index["folders"].append(folder_index)

        self.add_json("mail", "mail:messages", "Mail/messages.json", all_messages)
        self.add_json("mail", "mail:index", "Mail/index.json", index)

    def enumerate_json(self, api):
        def contacts():
            # MeCard can be absent on accounts with no card; it must not hide
            # the address book. Guard each call independently.
            me = _guard(lambda: getattr(api.contacts.me, "raw_data", {}) or {}, {})
            book = _guard(lambda: api.contacts.all or [], [])
            if not isinstance(book, list):
                book = []
            return {"me": me, "contacts": book}

        contact_data = _guard(contacts, {"me": {}, "contacts": []})
        self.add_json(
            "contacts",
            "contacts:all",
            "Contacts/contacts.json",
            contact_data,
        )
        # A plain-text index of every contact note, so the seed scanner and
        # search do not have to parse JSON and so notes are visible as text.
        note_lines = []
        for card in contact_data.get("contacts", []) if isinstance(contact_data, dict) else []:
            if not isinstance(card, dict):
                continue
            name = " ".join(
                part for part in [
                    card.get("firstName") or card.get("first_name") or "",
                    card.get("lastName") or card.get("last_name") or "",
                ] if part
            ) or card.get("companyName") or card.get("contactId") or "contact"
            note = card.get("notes") or card.get("note") or ""
            if note:
                note_lines.append(f"{name}\n{note}")
        if note_lines:
            payload = ("\n\n".join(note_lines) + "\n").encode("utf-8")
            self.add(
                area="contacts",
                key="contacts:notes",
                path=self.root / "Contacts" / "contact_notes.txt",
                size=len(payload),
                fetch=lambda payload=payload: payload,
                kind="bytes",
            )

        def calendars():
            calendars = api.calendar.get_calendars()
            # Export the whole history, not just the current month. Apple's
            # calendar API accepts an explicit range; a single bound would be
            # expanded to that month by pyicloud.
            events = _guard(
                lambda: api.calendar.get_events(
                    from_dt=datetime(1970, 1, 1),
                    to_dt=datetime(2100, 1, 1),
                    period="month",
                ),
                None,
            )
            if events is None:
                events = _guard(
                    lambda: api.calendar.get_events(period="month"), []
                )
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

    def _total_known(self) -> int:
        return sum(int(item.get("total", 0)) for item in self.areas.values())

    def _thumb_file(self, path: Path) -> None:
        """Write a browser-safe JPEG preview next to the scan cache.

        Browsers cannot decode HEIC/HEIF, so the admin UI shows the original
        only for formats it can render and uses this JPEG for the rest.
        """
        try:
            if not path.is_file():
                return
            rel = path.relative_to(self.root).as_posix()
            target = self.root / "Scan" / "thumbs" / f"{rel}.jpg"
            if target.exists() and target.stat().st_mtime >= path.stat().st_mtime:
                return
            suffix = path.suffix.lower()
            if suffix in scan_module.IMAGE_EXT:
                scan_module.thumbnail(path, target)
                if suffix in (".heic", ".heif"):
                    preview = self.root / "Scan" / "previews" / f"{rel}.jpg"
                    if not preview.exists() or preview.stat().st_mtime < path.stat().st_mtime:
                        scan_module.preview(path, preview)
            elif suffix in scan_module.VIDEO_EXT:
                # First frame, so the grid shows what is inside the video
                # before the operator opens the player.
                scan_module.video_thumb(path, target)
                play = self.root / "Scan" / "play" / f"{rel}.mp4"
                if not play.exists() or play.stat().st_mtime < path.stat().st_mtime:
                    scan_module.video_proxy(path, play)
        except Exception:
            pass

    def _thumb_for_task(self, task: dict) -> None:
        if task.get("area") not in ("photos", "hidden", "deleted"):
            return
        path = task.get("path")
        if isinstance(path, Path) and (
            path.suffix.lower() in scan_module.IMAGE_EXT
            or path.suffix.lower() in scan_module.VIDEO_EXT
        ):
            self._thumb_file(path)

    def _backfill_thumbs(self) -> None:
        """Previews for files that were exported before thumbnails existed.

        Runs in a background thread: a 15k-photo library must not delay the
        small notes/contacts phase, but a photo that is already on disk should
        become viewable immediately instead of waiting for the photos phase.
        """
        base = self.root / "Photos"
        if not base.is_dir():
            return
        try:
            paths = sorted(base.rglob("*"))
        except Exception:
            return
        for path in paths:
            if path.suffix.lower() in scan_module.IMAGE_EXT:
                self._thumb_file(path)

    def _download_task(self, task: dict) -> None:
        total = self._total_known()
        area = self.areas.setdefault(task["area"], {"done": 0, "total": 0, "bytes": 0})
        if not self.force and not self.manifest.needs(
            task["key"], task["path"], task["size"]
        ):
            self.done += 1
            area["done"] += 1
            size = int(task["path"].stat().st_size if task["path"].exists() else 0)
            area["bytes"] += size
            self.bytes += size
            self._thumb_for_task(task)
            self._progress(task["area"], total, self.done)
            return
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
            area["done"] += 1
            area["bytes"] += written["size"]
            self._thumb_for_task(task)
        except Exception as error:
            self.failed += 1
            self.manifest.mark(
                task["key"], task["area"], task["path"], 0, "", status="failed"
            )
            log.info(
                "export item failed: %s %s\n%s",
                task.get("key"),
                type(error).__name__,
                traceback.format_exc(),
            )
        self._progress(task["area"], total, self.done)

    def _drain(self, max_priority: int) -> None:
        """Download the pending tasks at or below a priority, small first."""
        ready = [task for task in self.tasks if task.get("priority", 5) <= max_priority]
        if not ready:
            return
        pending = set(id(task) for task in ready)
        self.tasks = [task for task in self.tasks if id(task) not in pending]
        ready.sort(key=lambda task: (task.get("priority", 5), int(task.get("size", 0) or 0)))
        cancel = getattr(self.ctx, "cancel", None)
        for task in ready:
            if cancel is not None and cancel.is_set():
                return
            self._download_task(task)

    def run(self) -> dict:
        api = self.ctx.api
        seen: set[str] = set()
        if api is not None:
            if self.only_mail:
                # Mail is large and optional: only the explicit "Export mail"
                # button reaches this path.
                self.enumerate_mail(api)
                self._drain(99)
            else:
                # Notes first, then contacts/calendar/reminders/account.  Each
                # phase drains before the next enumeration starts, so a large
                # photo library or mailbox cannot delay the small items.
                if self.phase == "notes":
                    self.enumerate_notes(api)
                    self._drain(0)
                    self._drain(99)
                elif self.phase == "small":
                    self.enumerate_json(api)
                    self._drain(4)
                    self._drain(99)
                elif self.phase == "drive":
                    self.enumerate_drive(api)
                    self._drain(6)
                    # Large drive files are priority 90; they still belong to
                    # the drive wave, not to a later wave.
                    self._drain(99)
                elif self.phase == "photos":
                    self.enumerate_photos(api, seen, only="image")
                    self._drain(99)
                elif self.phase == "videos":
                    self.enumerate_photos(api, seen, only="video")
                    self._drain(99)
                else:
                    # Notes first, then contacts/calendar/reminders/account.
                    self.enumerate_notes(api)
                    self._drain(0)
                    # Notes are on disk now; previews for older photos can be
                    # prepared in the background while contacts/calendar load.
                    threading.Thread(
                        target=self._backfill_thumbs, daemon=True, name="thumb-backfill"
                    ).start()
                    self.enumerate_json(api)
                    self._drain(4)
                    if self.include_mail:
                        self.enumerate_mail(api)
                        self._drain(5)
                    self.enumerate_drive(api)
                    self._drain(6)
                    self.enumerate_photos(api, seen)
                    self._drain(99)
        else:
            self._drain(99)

        total = self._total_known()

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
                "counts": collect_counts(self.root, self.areas),
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
                # Emitter.progress does not add the id (JobContext.emit does);
                # without it Node drops every tick and the panel shows 0/0.
                "jobId": getattr(self.ctx, "job_id", ""),
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
                    data = result.encode("utf-8") if isinstance(result, str) else result
                    with tmp.open("wb") as stream:
                        stream.write(data)
                elif task["kind"] == "chunks":
                    with tmp.open("wb") as stream:
                        if isinstance(result, (bytes, bytearray, memoryview)):
                            stream.write(result)
                        elif isinstance(result, str):
                            stream.write(result.encode("utf-8"))
                        else:
                            for chunk in result:
                                if chunk:
                                    stream.write(chunk)
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


def _jsonable(value):
    """Best-effort JSON view of a pydantic model or plain object."""
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        try:
            return json_safe(value.model_dump(mode="json"))
        except Exception:
            pass
    return json_safe(value)


def _message_json(message, *, include_parts: bool = False) -> dict:
    data = _jsonable(message)
    if not isinstance(data, dict):
        return {"id": str(getattr(message, "id", "") or ""), "value": data}
    if not include_parts:
        data.pop("parts", None)
    return data


def _guard(fn, default):
    try:
        return fn()
    except Exception:
        return default
