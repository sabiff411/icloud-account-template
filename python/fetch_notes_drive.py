#!/usr/bin/env python3
"""Download every note and every Drive file of one account.

    fetch_notes_drive.py --email a@b.com --out /path
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, "/opt/icloud3/python")
from bulk_images import load_accounts, open_api_safe  # noqa: E402

SAFE = re.compile(r"[^\w.\- ()\[\]]+", re.UNICODE)


def safe(name: str, fallback: str = "file") -> str:
    cleaned = SAFE.sub("_", str(name or "")).strip(" .")
    return (cleaned or fallback)[:180]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    out = Path(args.out)
    notes_dir = out / "notes"
    html_dir = out / "notes-html"
    drive_dir = out / "drive"
    for folder in (notes_dir, html_dir, drive_dir):
        folder.mkdir(parents=True, exist_ok=True)

    account = next(a for a in load_accounts() if a["email"] == args.email)
    api = open_api_safe(account)
    print(f"[dl] session ok for {args.email}", flush=True)

    # ---------------------------------------------------------------- notes
    notes = 0
    try:
        summaries = [s for s in api.notes.iter_all() if not getattr(s, "is_deleted", False)]
    except Exception as error:  # noqa: BLE001
        summaries = []
        print(f"[dl] notes list failed: {type(error).__name__}: {error}", flush=True)
    for summary in summaries:
        note_id = str(getattr(summary, "id", "") or "")
        if not note_id:
            continue
        title = str(getattr(summary, "title", "") or note_id)
        try:
            note = api.notes.get(note_id)
            body = getattr(note, "text", None) or getattr(note, "content", "") or ""
            header = f"{getattr(note, 'title', title)}\n{getattr(note, 'modified', '')}\n\n"
            (notes_dir / f"{safe(note_id[:8])}_{safe(title)}.txt").write_text(
                header + str(body), errors="ignore"
            )
            notes += 1
        except Exception as error:  # noqa: BLE001
            print(f"[dl] note {title[:40]} failed: {type(error).__name__}", flush=True)
        try:
            api.notes.export_note(note_id, str(html_dir), export_mode="archival")
        except Exception:  # noqa: BLE001
            pass
    print(f"[dl] notes saved: {notes} of {len(summaries)}", flush=True)

    # ---------------------------------------------------------------- drive
    root = api.drive.root
    stack = [(root, drive_dir)]
    files = 0
    total = 0
    errors = []
    while stack:
        node, dest_dir = stack.pop()
        try:
            children = node.get_children()
        except Exception as error:  # noqa: BLE001
            errors.append({"folder": str(dest_dir), "error": type(error).__name__})
            continue
        for child in children or []:
            raw_name = str(getattr(child, "name", "") or "")
            name = safe(raw_name or "file")
            if getattr(child, "type", "") == "folder":
                if raw_name.lower().endswith(".app"):
                    continue
                stack.append((child, dest_dir / name))
                continue
            target = dest_dir / name
            size = int(getattr(child, "size", 0) or 0)
            try:
                data = getattr(child, "data", None)
                if isinstance(data, dict) and "size" not in data:
                    data["size"] = size
                response = child.open(stream=True, timeout=(20, 180))
                target.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with target.open("wb") as handle:
                    for chunk in response.iter_content(1024 * 256):
                        if chunk:
                            handle.write(chunk)
                            written += len(chunk)
                files += 1
                total += written
                print(f"[dl] {target.relative_to(drive_dir)} ({written // 1024} KB)", flush=True)
            except Exception as error:  # noqa: BLE001
                errors.append({"file": str(target), "error": f"{type(error).__name__}: {error}"})
                print(f"[dl] FAILED {raw_name}: {type(error).__name__}", flush=True)

    (out / "download.json").write_text(
        json.dumps(
            {
                "email": args.email,
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "notes": notes,
                "driveFiles": files,
                "driveBytes": total,
                "errors": errors,
            },
            indent=1,
        )
    )
    print(f"[dl] drive files: {files}, {total / 1024 / 1024:.1f} MB, errors {len(errors)}", flush=True)


if __name__ == "__main__":
    main()
