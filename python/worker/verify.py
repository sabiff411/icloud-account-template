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
from .inventory import _contact_stats

log = logging.getLogger("worker.verify")


def manifest_ids(dbfile) -> tuple[dict[str, set], dict[str, int]]:
    ids = {"photos": set(), "notes": set(), "drive": set()}
    counts: dict[str, int] = {}
    path = Path(dbfile)
    if not path.exists():
        return ids, counts
    try:
        db = sqlite3.connect(str(path))
        rows = db.execute(
            "SELECT key, area, status FROM files WHERE status IN ('done','skipped')"
        ).fetchall()
        db.close()
    except sqlite3.Error as error:
        log.warning("manifest unreadable: %s", type(error).__name__)
        return ids, counts

    for key, area, status in rows:
        key = str(key or "")
        if status == "done":
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


def enumerate_live(
    api,
    state=None,
    counts_out: dict | None = None,
    on_counts=None,
) -> dict:
    """Enumerate the live account once and fill both shapes from it.

    ``live`` keeps the id sets the comparison needs.  ``counts_out``, when
    given, receives the same numbers in the store's count keys, so a live
    check refreshes every visible counter (photos, albums, videos, notes,
    drive, contacts, mail, ...) instead of a hand-picked few.  A key is only
    written when its enumeration succeeded — a failed service must not
    overwrite a good number with 0.

    ``on_counts`` is called after each area, so the panel updates the cheap
    counters immediately instead of waiting for a 20k-photo enumeration.
    """
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

    def put(key: str, value) -> None:
        if counts_out is None:
            return
        try:
            counts_out[key] = int(value or 0)
        except (TypeError, ValueError):
            pass

    def flush() -> None:
        if counts_out is None or on_counts is None:
            return
        try:
            on_counts(dict(counts_out))
        except Exception:
            pass

    def step(message):
        if state:
            try:
                state(message)
            except Exception:
                pass

    # Cheap counters first: the panel shows them while the big photo/notes/
    # drive enumerations are still running.
    step("Reading live photo albums")
    try:
        albums = api.photos.albums
        put("albums", len(albums))
        try:
            put("videos", len(albums["Videos"]))
        except Exception:
            pass
        # Album lengths are a cheap count query (~1s), unlike the id
        # enumeration below which can take hours on a 20k library.  Publish
        # the totals now so the panel is correct immediately.
        for key, album in (
            ("photos", "Library"),
            ("hidden", "Hidden"),
            ("deleted", "Recently Deleted"),
        ):
            try:
                put(key, len(albums[album]))
            except Exception:
                pass
        if counts_out is not None and "photos" in counts_out:
            # Library is photos + videos; expose the still-picture part too.
            put("images", max(0, counts_out["photos"] - counts_out.get("videos", 0)))
        flush()
    except Exception as error:
        log.info("live albums unavailable: %s", type(error).__name__)

    step("Reading live contacts and calendars")
    try:
        cards = api.contacts.all
        live["contacts"] = _count(cards)
        put("contacts", live["contacts"])
        with_phone, with_email = _contact_stats(cards)
        put("contactsPhone", with_phone)
        put("contactsEmail", with_email)
        flush()
    except Exception:
        pass
    try:
        live["calendar"] = _count(api.calendar.get_calendars())
        put("calendars", live["calendar"])
        flush()
    except Exception:
        pass
    try:
        total = 0
        for reminders_list in api.reminders.lists():
            result = api.reminders.list_reminders(reminders_list.id, include_completed=True)
            total += _count(getattr(result, "reminders", None))
        live["reminders"] = total
        put("reminders", total)
        flush()
    except Exception:
        pass

    step("Reading live mail folders")
    try:
        mail = getattr(api, "mail", None)
        if mail is not None:
            folders = mail.folders()
            put("mailFolders", len(folders))
            put(
                "mailMessages",
                sum(int(getattr(folder, "message_count", 0) or 0) for folder in folders),
            )
            flush()
    except Exception as error:
        log.info("live mail unavailable: %s", type(error).__name__)

    step("Reading live photos")
    photo_ok = False
    try:
        live["photos"] = _asset_ids(api.photos.all)
        photo_ok = True
    except Exception as error:
        # The "all" smart album occasionally 410s under load; Library is the
        # same set and is a reliable fallback.
        log.info("live photos all unavailable: %s", type(error).__name__)
        try:
            live["photos"] = _asset_ids(api.photos.albums["Library"])
            photo_ok = True
        except Exception as fallback_error:
            log.info("live photos unavailable: %s", type(fallback_error).__name__)
    if photo_ok:
        put("photos", len(live["photos"]))
        flush()
    for area, album in (("hidden", "Hidden"), ("deleted", "Recently Deleted")):
        step(f"Reading live {album}")
        try:
            live[area] = _asset_ids(api.photos.albums[album])
            put(area, len(live[area]))
            flush()
        except Exception as error:
            log.info("live %s unavailable: %s", area, type(error).__name__)

    step("Reading live notes")
    try:
        for summary in api.notes.iter_all():
            if not getattr(summary, "is_deleted", False):
                value = getattr(summary, "id", "") or getattr(summary, "identifier", "")
                if value:
                    live["notes"].add(str(value))
        put("notes", len(live["notes"]))
        flush()
    except Exception as error:
        log.info("live notes unavailable: %s", type(error).__name__)

    step("Reading live drive")
    try:
        stack = [(api.drive.root, "")]
        seen: set[str] = set()
        total_bytes = 0
        while stack:
            node, prefix = stack.pop()
            for child in node.get_children() or []:
                name = str(getattr(child, "name", "") or "")
                if getattr(child, "type", "") == "folder":
                    if name.lower().endswith(".app"):
                        continue
                    stack.append((child, f"{prefix}{name}/"))
                    continue
                if exporter.is_skipped_drive(f"{prefix}{name}"):
                    continue
                size = int(getattr(child, "size", 0) or 0)
                key = f"{name}:{size}"
                if key not in seen:
                    seen.add(key)
                    live["drive"].add(key)
                    total_bytes += size
        put("driveFiles", len(live["drive"]))
        put("driveBytes", total_bytes)
        flush()
    except Exception as error:
        log.info("live drive unavailable: %s", type(error).__name__)

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


def exported_content_counts(root, exported: dict) -> dict:
    """Manifest area counts plus content counts for contacts/calendar/reminders.

    The manifest has one row for contacts.json, one for calendars.json and one
    for reminders.json; comparing those file counts with live contact/calendar/
    reminder totals produced false "missing" badges.  Read the JSON files for
    the real totals.
    """
    merged = dict(exported or {})
    areas = {
        area: {"done": int(count or 0), "bytes": 0}
        for area, count in merged.items()
    }
    try:
        content = exporter.collect_counts(Path(root), areas)
    except Exception:
        return merged
    if "contacts" in content:
        merged["contacts"] = content["contacts"]
    if "calendars" in content:
        merged["calendar"] = content["calendars"]
    if "reminders" in content:
        merged["reminders"] = content["reminders"]
    return merged


def run_verify(ctx, payload: dict) -> None:
    from . import auth

    ctx.state("auth", "Opening the saved session")
    api, _session_dir = auth._service(ctx, ctx.account.get("password", ""))
    ctx.api = api
    auth._apply_proxy(api, ctx)
    ok, _trusted, _limited = auth.check_alive(api, ctx)
    if not ok:
        ctx.emit("job:error", {"error": "session is not authenticated"})
        return

    live_counts: dict = {}
    live = enumerate_live(
        api,
        state=lambda message: ctx.state("auth", message),
        counts_out=live_counts,
        on_counts=lambda counts: ctx.emit("job:counts", {"counts": counts}),
    )
    root = Path(payload.get("exportDir") or "./export") / exporter.safe_name(
        ctx.account.get("email", "account")
    )
    ids, exported = manifest_ids(root / "manifest.sqlite3")
    exported = exported_content_counts(root, exported)
    result = compare(live, ids, exported)
    # The same live pass refreshes every counter the panel shows.  Areas the
    # service could not read are absent, so their last good value survives.
    result["counts"] = live_counts
    ctx.emit("job:verify_result", result)
