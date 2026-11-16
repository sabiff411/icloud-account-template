#!/usr/bin/env python3
"""Audit one account: live Drive tree and Notes vs what is on disk.

    drive_notes_audit.py <email>

Prints the exact missing/extra/short files, not a count, so "all downloaded"
can be checked rather than believed.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, "/opt/icloud3/python")
from bulk_images import EXPORT, load_accounts, open_api_safe  # noqa: E402
from worker.exporter import is_skipped_drive, safe_name  # noqa: E402


def live_drive(api):
    out = {}
    stack = [(api.drive.root, "", "")]
    while stack:
        node, rel, prefix = stack.pop()
        try:
            children = node.get_children() or []
        except Exception as error:
            print("  walk error", type(error).__name__, error)
            continue
        for child in children:
            raw = str(getattr(child, "name", "") or "")
            name = safe_name(raw or "file")
            if getattr(child, "type", "") == "folder":
                if raw.lower().endswith(".app"):
                    continue
                stack.append((child, f"{rel}/{name}" if rel else name, f"{prefix}{raw}/"))
                continue
            full = f"{prefix}{raw}"
            if is_skipped_drive(full):
                continue
            out[(f"{rel}/{name}" if rel else name)] = int(getattr(child, "size", 0) or 0)
    return out


def main() -> None:
    email = sys.argv[1]
    account = next(a for a in load_accounts() if a["email"] == email)
    api = open_api_safe(account)
    base = EXPORT / email

    print(f"== {email}")
    want = live_drive(api)
    have = {
        str(path.relative_to(base / "Drive")): path.stat().st_size
        for path in (base / "Drive").rglob("*")
        if path.is_file() and not path.name.endswith(".part")
    }
    missing = sorted(set(want) - set(have))
    extra = sorted(set(have) - set(want))
    short = sorted(
        (name, have[name], want[name])
        for name in set(want) & set(have)
        if want[name] and have[name] != want[name]
    )
    print(f"drive live {len(want)}  disk {len(have)}  missing {len(missing)}  short {len(short)}  extra {len(extra)}")
    for name in missing:
        print("  MISSING", name, want[name])
    for name, got, exp in short:
        print("  SHORT", name, f"{got} != {exp}")
    for name in extra:
        print("  EXTRA", name, have[name])

    summaries = [s for s in api.notes.iter_all() if not getattr(s, "is_deleted", False)]
    note_ids = {str(getattr(s, "id", "") or "") for s in summaries}
    written = {f.name[:8] for f in (base / "Notes/txt").glob("*.txt")}
    lost = sorted(n[:8] for n in note_ids if n[:8] not in written)
    print(f"notes live {len(note_ids)}  disk {len(written)}  missing {len(lost)}")
    titles = {str(getattr(s, "id", ""))[:8]: str(getattr(s, "title", "") or "") for s in summaries}
    for prefix in lost:
        print("  MISSING note", prefix, titles.get(prefix))
    html = len(list((base / "Notes/html").glob("**/*"))) if (base / "Notes/html").is_dir() else 0
    print(f"notes html items {html}")


if __name__ == "__main__":
    main()
