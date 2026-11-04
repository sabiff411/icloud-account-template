"""Live iCloud vs export verification.

The manifest is the source of truth for what is already on disk (it records
each completed item, keyed by asset id / note id / drive name+size). This job
enumerates the live account id-only — no downloads — and reports, per area,
`live / exported / missing`. It never deletes a file.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from . import exporter

log = logging.getLogger("worker.verify")


def manifest_ids(dbfile) -> tuple[dict[str, set], dict[str, int]]:
    ids = {"photos": set(), "notes": set(), "drive": set()}
    counts: dict[str, int] = {}
    path = Path(dbfile)
    if not path.exists():
        return ids, counts
    try:
        db = sqlite3.connect(str(path))
        rows = db.execute("SELECT key, area FROM files WHERE status='done'").fetchall()
        db.close()
    except sqlite3.Error as error:
        log.warning("manifest unreadable: %s", type(error).__name__)
        return ids, counts

    for key, area in rows:
        key = str(key or "")
        counts[area] = counts.get(area, 0) + 1
        if key.startswith("photo:"):
            ids["photos"].add(key[len("photo:") :])
        elif key.startswith("note:"):
            ids["notes"].add(key[len("note:") :])
        elif key.startswith("drive:"):
            rest = key[len("drive:") :]
            name, sep, size = rest.rpartition(":")
            if sep:
                # Drive keys are name:size (old) or rel/path:size (new).
                ids["drive"].add(f"{name.rsplit('/', 1)[-1]}:{size}")
            else:
                ids["drive"].add(rest)
    return ids, counts


def _asset_ids(album) -> set[str]:
    found: set[str] = set()
    for asset in album:
        value = getattr(asset, "id", "") or getattr(asset, "_asset_id", "")
        if value:
            found.add(str(value))
    return found


def _count(value) -> int:
    try:
        return len(value or [])
    except Exception:
        return 0


def enumerate_live(api, state=None) -> dict:
    live: dict = {
        "photos": set(),
        "hidden": set(),
        "deleted": set(),
        "notes": set(),
        "drive": set(),
        "contacts": 0,
        "calendar": 0,
        "reminders": 0,
    }

    def step(message):
        if state:
            try:
                state(message)
            except Exception:
                pass

    step("Reading live photos")
    try:
        live["photos"] = _asset_ids(api.photos.all)
    except Exception as error:
        log.info("live photos unavailable: %s", type(error).__name__)
    for area, album in (("hidden", "Hidden"), ("deleted", "Recently Deleted")):
        step(f"Reading live {album}")
        try:
            live[area] = _asset_ids(api.photos.albums[album])
        except Exception as error:
            log.info("live %s unavailable: %s", area, type(error).__name__)

    step("Reading live notes")
    try:
        for summary in api.notes.iter_all():
            if not getattr(summary, "is_deleted", False):
                value = getattr(summary, "id", "") or getattr(summary, "identifier", "")
                if value:
                    live["notes"].add(str(value))
    except Exception as error:
        log.info("live notes unavailable: %s", type(error).__name__)

    step("Reading live drive")
    try:
        stack = [api.drive.root]
        seen: set[str] = set()
        while stack:
            node = stack.pop()
            for child in node.get_children() or []:
                if getattr(child, "type", "") == "folder":
                    stack.append(child)
                    continue
                name = str(getattr(child, "name", "") or "")
                size = int(getattr(child, "size", 0) or 0)
                key = f"{name}:{size}"
                if key not in seen:
                    seen.add(key)
                    live["drive"].add(key)
    except Exception as error:
        log.info("live drive unavailable: %s", type(error).__name__)

    step("Reading live contacts and calendars")
    try:
        live["contacts"] = _count(api.contacts.all)
    except Exception:
        pass
    try:
        live["calendar"] = _count(api.calendar.get_calendars())
    except Exception:
        pass
    try:
        total = 0
        for reminders_list in api.reminders.lists():
            result = api.reminders.list_reminders(reminders_list.id, include_completed=True)
            total += _count(getattr(result, "reminders", None))
        live["reminders"] = total
    except Exception:
        pass
    return live


def compare(live: dict, ids: dict, exported: dict) -> dict:
    areas: dict[str, dict] = {}
    missing: dict[str, list] = {}

    for area in ("photos", "hidden", "deleted"):
        live_set = set(live.get(area) or set())
        gap = live_set - ids["photos"]
        missing[area] = sorted(gap)
        areas[area] = {
            "live": len(live_set),
            "exported": int(exported.get(area, 0) or 0),
            "missing": len(gap),
        }

    for area, source in (("notes", "notes"), ("drive", "drive")):
        live_set = set(live.get(area) or set())
        gap = live_set - ids[source]
        missing[area] = sorted(gap)
        areas[area] = {
            "live": len(live_set),
            "exported": int(exported.get(area, 0) or 0),
            "missing": len(gap),
        }

    for area in ("contacts", "calendar", "reminders"):
        live_count = int(live.get(area) or 0)
        stored = int(exported.get(area, 0) or 0)
        areas[area] = {
            "live": live_count,
            "exported": stored,
            "missing": max(0, live_count - stored),
        }
        missing[area] = []

    return {"areas": areas, "missing": missing}


def run_verify(ctx, payload: dict) -> None:
    from . import auth

    ctx.state("auth", "Opening the saved session")
    api, _session_dir = auth._service(ctx, ctx.account.get("password", ""))
    ctx.api = api
    auth._apply_proxy(api, ctx)
    try:
        status = api.get_auth_status() or {}
    except Exception:
        status = {}
    if not status.get("authenticated"):
        ctx.emit("job:error", {"error": "session is not authenticated"})
        return

    live = enumerate_live(api, state=lambda message: ctx.state("auth", message))
    root = Path(payload.get("exportDir") or "./export") / exporter.safe_name(
        ctx.account.get("email", "account")
    )
    ids, exported = manifest_ids(root / "manifest.sqlite3")
    result = compare(live, ids, exported)
    ctx.emit("job:verify_result", result)
