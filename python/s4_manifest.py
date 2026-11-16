#!/usr/bin/env python3
"""Write Scan/s4-manifest.json for every account.

The panel lists photos by walking the export tree.  Once the bytes live on S4
and the local copy is pruned, that walk finds nothing, so the listing is
written down first: one entry per media file that exists in the bucket.

    {"generated": "...", "files": [{"p": "Photos/Library/x.jpg", "s": 1, "m": 2}]}
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("EXPORT_DIR") or (Path(__file__).resolve().parents[1] / "export"))
# Everything the mirror uploads; the panel needs a listing for all of it.
KEEP_PREFIX = ("Photos/", "Drive/", "Notes/", "Calendar/", "Contacts/")


def manifest_for(account: Path) -> dict:
    files = []
    for prefix in KEEP_PREFIX:
        base = account / prefix.rstrip("/")
        if not base.is_dir():
            continue
        for current, _dirs, names in os.walk(base, followlinks=True):
            for name in names:
                full = Path(current) / name
                try:
                    stat = full.stat()
                except OSError:
                    continue
                files.append(
                    {
                        "p": full.relative_to(account).as_posix(),
                        "s": stat.st_size,
                        "m": int(stat.st_mtime * 1000),
                    }
                )
    return {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files}


def main() -> None:
    only = {item.strip().lower() for item in (sys.argv[1] or "").split(",") if item.strip()} if len(sys.argv) > 1 else set()
    total = 0
    for account in sorted(ROOT.iterdir()):
        if not account.is_dir() or account.name.startswith("."):
            continue
        if only and account.name.lower() not in only:
            continue
        data = manifest_for(account)
        out = account / "Scan" / "s4-manifest.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        # MERGE with what is already listed: the prune runs per account, and a
        # second pass must not drop the entries of files already moved out.
        merged = {entry["p"]: entry for entry in (data["files"] or [])}
        if out.exists():
            try:
                for entry in json.loads(out.read_text()).get("files") or []:
                    merged.setdefault(entry["p"], entry)
            except Exception:
                pass
        data["files"] = sorted(merged.values(), key=lambda entry: entry["p"])
        out.write_text(json.dumps(data))
        total += len(data["files"])
        print(f"{account.name}: {len(data['files'])} files, {out.stat().st_size // 1024} KB", flush=True)
    print(f"total {total}")


if __name__ == "__main__":
    main()
