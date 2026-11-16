#!/usr/bin/env python3
"""Export the non-photo data that the bulk image run does not touch.

Notes (text + archival HTML), contacts, calendar, reminders and account info
for every trusted account, using the same anyIP session as the image export.
Nothing already recorded in the manifest is downloaded twice, so a re-run only
fills in what is new or missing.

Writes a per-account report to /opt/icloud3/other_report.json.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, REPORT, load_accounts, log, open_api  # noqa: E402

OTHER_REPORT = Path(os.environ.get("OTHER_REPORT") or Path(__file__).resolve().parents[1] / "other_report.json")


def safe_name(value: object, default: str = "unnamed") -> str:
    text = str(value or "")
    for char in '\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\x0c\r\x0e\x0f<>:"/\\|?*':
        text = text.replace(char, "_")
    text = text.strip(" .")[:120]
    return text or default


def connect(email: str) -> sqlite3.Connection:
    path = EXPORT / email / "manifest.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    # The image exporter and the Drive pass share this file; without a busy
    # timeout a concurrent write raises "database is locked" and a finished
    # note stays unrecorded.
    db = sqlite3.connect(str(path), timeout=60, isolation_level=None)
    db.execute("PRAGMA busy_timeout=60000")
    db.execute(
        """CREATE TABLE IF NOT EXISTS files (
            key TEXT PRIMARY KEY, area TEXT NOT NULL, path TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'done', updated TEXT NOT NULL)"""
    )
    db.execute("PRAGMA synchronous=NORMAL")
    db.commit()
    return db


def mark(db: sqlite3.Connection, key: str, area: str, path: Path, size: int) -> None:
    db.execute(
        """INSERT INTO files(key, area, path, size, sha256, status, updated)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             area=excluded.area, path=excluded.path, size=excluded.size,
             sha256=excluded.sha256, status=excluded.status, updated=excluded.updated""",
        (key, area, str(path), int(size), "", "done", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
    )


def write_bytes(dest: Path, payload: bytes) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(dest.name + ".tmp")
    temp.write_bytes(payload)
    temp.replace(dest)
    return len(payload)


def guard(fn, default):
    try:
        return fn()
    except Exception:
        return default


# Attachments inside a note (photos, scans, PDFs) arrive as CloudKit assets
# with a UTI, not always with a usable filename.
UTI_EXT = {
    "public.jpeg": ".jpg", "public.jpg": ".jpg", "public.png": ".png",
    "public.heic": ".heic", "public.heif": ".heif", "public.tiff": ".tiff",
    "public.gif": ".gif", "public.image": ".jpg", "com.compuserve.gif": ".gif",
    "com.adobe.pdf": ".pdf", "public.mpeg-4": ".mp4", "public.movie": ".mov",
    "com.apple.m4a-audio": ".m4a", "public.mpeg-4-audio": ".m4a",
    "public.audio": ".m4a", "com.apple.notes.table": ".csv",
    "com.microsoft.word.doc": ".doc", "org.openxmlformats.wordprocessingml.document": ".docx",
    "com.microsoft.excel.xls": ".xls", "public.zip-archive": ".zip",
    "com.apple.icns": ".icns",
}


def attachment_name(att) -> str:
    raw = str(getattr(att, "filename", "") or "")
    name = safe_name(raw) if raw else ""
    if name and "." in name.rsplit("/", 1)[-1]:
        return name
    ext = UTI_EXT.get(str(getattr(att, "uti", "") or ""), "")
    stem = name or str(getattr(att, "id", "") or "attachment")
    return safe_name(stem + ext) or f"attachment{ext}"


def note_attachments(api, email: str, note_id: str, note, db: sqlite3.Connection) -> int:
    """Download every attachment of one note under Notes/attachments/<id8>/."""
    items = getattr(note, "attachments", None) or []
    if not items:
        return 0
    folder = EXPORT / email / "Notes" / "attachments" / note_id[:8]
    folder.mkdir(parents=True, exist_ok=True)
    index = []
    for att in items:
        name = attachment_name(att)
        dest = folder / name
        size = int(getattr(att, "size", 0) or 0)
        if dest.exists() and (not size or dest.stat().st_size == size):
            index.append({"file": name, "uti": getattr(att, "uti", ""), "size": dest.stat().st_size})
            continue
        last = None
        for attempt in range(3):
            try:
                data = b"".join(att.stream(service=api.notes))
                if not data:
                    raise RuntimeError("empty attachment")
                temporary = dest.with_name(dest.name + ".part")
                temporary.write_bytes(data)
                temporary.replace(dest)
                mark(db, f"noteatt:{getattr(att, 'id', name)}", "note-attachment", dest, len(data))
                index.append({"file": name, "uti": getattr(att, "uti", ""), "size": len(data)})
                last = None
                break
            except Exception as error:  # noqa: BLE001
                last = error
                time.sleep(1 + attempt)
        if last is not None:
            continue
    (folder / "index.json").write_text(json.dumps(index, indent=1))
    return len(index)


IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.IGNORECASE)


def note_index_entry(email: str, note_id: str, title: str, txt: Path, html: Path | None) -> dict:
    """What the panel needs to show a note: its text, its HTML and its images."""
    base = EXPORT / email
    entry = {
        "title": title,
        "txt": txt.relative_to(base).as_posix() if txt.exists() else "",
        "html": "",
        "images": [],
    }
    if html is None or not html.exists():
        # The exporter names the HTML after the note title; find it even when
        # the sanitised names differ by a character.
        folder = EXPORT / email / "Notes" / "html"
        want = str(title).strip().lower()
        if folder.is_dir():
            for candidate in folder.glob("*.html"):
                if candidate.stem.strip().lower() == want:
                    html = candidate
                    break
    if html is not None and html.exists():
        entry["html"] = html.relative_to(base).as_posix()
        try:
            body = html.read_text(errors="ignore")
        except OSError:
            body = ""
        images = []
        for match in IMG_RE.finditer(body):
            src = match.group(1)
            if not src or src.startswith("data:") or src.startswith("http"):
                continue
            rel = (html.parent / src).resolve()
            try:
                images.append(rel.relative_to(base.resolve()).as_posix())
            except ValueError:
                continue
        entry["images"] = images
    return entry


def notes(api, email: str, db: sqlite3.Connection, stats: dict) -> None:
    try:
        summaries = [s for s in api.notes.iter_all() if not getattr(s, "is_deleted", False)]
    except Exception as error:
        stats["notesError"] = f"{type(error).__name__}: {error}"[:160]
        return
    stats["notesLive"] = len(summaries)
    known = {
        str(row[0])
        for row in db.execute("SELECT key FROM files WHERE area='notes' AND status='done'")
    }
    fetched = 0
    index: dict[str, dict] = {}
    for summary in summaries:
        note_id = str(getattr(summary, "id", "") or "")
        if not note_id:
            continue
        title = safe_name(getattr(summary, "title", "") or note_id)
        dest = EXPORT / email / "Notes" / "txt" / f"{safe_name(note_id[:8])}_{title}.txt"
        key = f"note:{note_id}"
        if key in known and dest.exists():
            # The text is already saved; the note may still carry images
            # that were never downloaded (or added later).
            try:
                note = api.notes.get(note_id)
                note_attachments(api, email, note_id, note, db)
            except Exception:  # noqa: BLE001
                pass
            html_guess = EXPORT / email / "Notes" / "html" / f"{dest.stem.split('_', 1)[-1]}.html"
            index[note_id[:8]] = note_index_entry(email, note_id, title, dest, html_guess)
            continue
        try:
            note = None
            last = None
            for attempt in range(4):
                try:
                    note = api.notes.get(note_id)
                    break
                except Exception as error:  # noqa: BLE001
                    last = error
                    time.sleep(1.5 * (attempt + 1))
            if note is None:
                raise last or RuntimeError("note fetch failed")
            text = getattr(note, "text", None) or getattr(note, "content", "") or ""
            header = f"{getattr(note, 'title', '')}\n{getattr(note, 'modified', '')}\n\n"
            size = write_bytes(dest, (header + str(text)).encode("utf-8"))
            mark(db, key, "notes", dest, size)
            fetched += 1
        except Exception as error:  # noqa: BLE001 - one note must not stop the rest
            # Remember it: a silent `continue` made "178 live, 174 written"
            # impossible to explain afterwards.
            stats.setdefault("notesFailed", []).append(
                f"{note_id[:8]} {type(error).__name__}: {error}"[:140]
            )
            continue
        try:
            saved = note_attachments(api, email, note_id, note, db)
            stats["attachments"] = stats.get("attachments", 0) + saved
        except Exception:  # noqa: BLE001
            pass
        html_path = None
        try:
            saved = api.notes.export_note(
                note_id, str(EXPORT / email / "Notes" / "html"), export_mode="archival"
            )
            html_path = Path(saved) if saved else None
        except Exception:  # noqa: BLE001
            pass
        index[note_id[:8]] = note_index_entry(email, note_id, title, dest, html_path)
        if fetched % 50 == 0:
            db.commit()
    db.commit()
    if index:
        target = EXPORT / email / "Notes" / "index.json"
        merged: dict[str, dict] = {}
        try:
            merged = json.loads(target.read_text())
        except Exception:
            merged = {}
        merged.update(index)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(merged, indent=1))
    stats["notesNew"] = fetched
    if stats.get("notesFailed"):
        log(
            "notes",
            email,
            "failed",
            len(stats["notesFailed"]),
            stats["notesFailed"][:6],
        )


def json_area(api, email: str, db: sqlite3.Connection) -> dict:
    stats: dict = {}
    try:
        contacts = {
            "me": guard(lambda: getattr(api.contacts.me, "raw_data", {}) or {}, {}),
            "contacts": guard(lambda: api.contacts.all or [], []),
        }
        path = EXPORT / email / "Contacts" / "contacts.json"
        size = write_bytes(path, json.dumps(contacts, ensure_ascii=False, default=str).encode("utf-8"))
        mark(db, "contacts:all", "contacts", path, size)
        stats["contactsLive"] = len(contacts["contacts"]) if isinstance(contacts["contacts"], list) else 0
    except Exception as error:  # noqa: BLE001
        stats["contactsError"] = f"{type(error).__name__}: {error}"[:120]

    try:
        calendars = {
            "calendars": guard(lambda: api.calendar.get_calendars(), []),
            "events": guard(
                lambda: api.calendar.get_events(
                    from_dt=datetime(1970, 1, 1), to_dt=datetime(2100, 1, 1), period="month"
                ),
                [],
            ),
        }
        path = EXPORT / email / "Calendar" / "calendars.json"
        size = write_bytes(path, json.dumps(calendars, ensure_ascii=False, default=str).encode("utf-8"))
        mark(db, "calendar:month", "calendar", path, size)
    except Exception as error:  # noqa: BLE001
        stats["calendarError"] = f"{type(error).__name__}: {error}"[:120]

    try:
        out = []
        # lists() is a generator: the request happens on iteration.
        for reminders_list in guard(lambda: list(api.reminders.lists()), []):
            result = guard(lambda: api.reminders.list_reminders(reminders_list.id, include_completed=True), None)
            if result is not None:
                out.append({"list": reminders_list, "reminders": result.reminders})
        path = EXPORT / email / "Reminders" / "reminders.json"
        size = write_bytes(path, json.dumps(out, ensure_ascii=False, default=str).encode("utf-8"))
        mark(db, "reminders:all", "reminders", path, size)
        stats["remindersLists"] = len(out)
    except Exception as error:  # noqa: BLE001
        stats["remindersError"] = f"{type(error).__name__}: {error}"[:120]

    try:
        account = {
            "email": email,
            "storage": guard(lambda: api.account.storage, None),
            "plan": guard(lambda: api.account.summary_plan, {}),
            "devices": guard(lambda: api.account.devices, []),
            "family": guard(lambda: api.account.family, []),
        }
        path = EXPORT / email / "Account" / "account.json"
        size = write_bytes(path, json.dumps(account, ensure_ascii=False, default=str).encode("utf-8"))
        mark(db, "account:info", "account", path, size)
    except Exception as error:  # noqa: BLE001
        stats["accountError"] = f"{type(error).__name__}: {error}"[:120]
    db.commit()
    return stats


def process(account: dict) -> dict:
    email = account["email"]
    db = connect(email)
    stats: dict = {"email": email}
    try:
        api = open_api(account)
        notes(api, email, db, stats)
        stats.update(json_area(api, email, db))
        stats["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    except Exception as error:  # noqa: BLE001
        stats["error"] = f"{type(error).__name__}: {error}"[:200]
    finally:
        db.commit()
        db.close()
    return stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--force",
        action="store_true",
        help="revisit accounts already in the report (notes may have been partial)",
    )
    args = parser.parse_args()
    accounts = load_accounts()
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [item for item in accounts if item["email"].lower() in wanted]
    if args.limit:
        accounts = accounts[: args.limit]
    rows = []
    if OTHER_REPORT.exists():
        try:
            rows = json.loads(OTHER_REPORT.read_text())
        except Exception:
            rows = []
    done = set()
    if not args.force:
        done = {row.get("email") for row in rows if isinstance(row, dict) and "error" not in row}
    log("other start", len(accounts), "accounts")
    for account in accounts:
        if account["email"] in done:
            continue
        started = time.time()
        result = process(account)
        result["seconds"] = round(time.time() - started, 1)
        # One row per account: a forced re-run replaces the older partial row.
        rows = [
            row
            for row in rows
            if not (isinstance(row, dict) and row.get("email") == account["email"])
        ]
        rows.append(result)
        OTHER_REPORT.write_text(json.dumps(rows, indent=2))
        log(
            "other",
            account["email"],
            "notes",
            result.get("notesLive", "-"),
            "new",
            result.get("notesNew", "-"),
            "contacts",
            result.get("contactsLive", "-"),
            "s",
            result["seconds"],
            result.get("error", ""),
        )
    good = [row for row in rows if "error" not in row]
    log(
        "other finish",
        len(good),
        "ok",
        sum(row.get("notesLive", 0) for row in good),
        "notes",
        sum(row.get("contactsLive", 0) for row in good),
        "contacts",
    )


if __name__ == "__main__":
    main()
