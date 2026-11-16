#!/usr/bin/env python3
"""Build Notes/index.json for every account from what is already on disk.

    notes_index.py [email[,email]]

The exporter writes Notes/txt/<id>_<title>.txt and Notes/html/<title>.html
(with its images under Notes/html/assets/).  The panel needs to know which
images belong to which note; this walks the two directories and writes that
map, so notes with screenshots, receipts or photos show them without asking
iCloud for anything again.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path("/opt/icloud3/export")
IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.IGNORECASE)


def entry(base: Path, txt: Path) -> dict:
    stem = txt.stem
    note_id, _, title = stem.partition("_")
    folder = base / "Notes" / "html"
    html = None
    wanted = (title or stem).strip().lower()
    if folder.is_dir():
        for candidate in folder.glob("*.html"):
            if candidate.stem.strip().lower() == wanted:
                html = candidate
                break
    images: list[str] = []
    html_rel = ""
    if html is not None:
        html_rel = html.relative_to(base).as_posix()
        try:
            body = html.read_text(errors="ignore")
        except OSError:
            body = ""
        for match in IMG_RE.finditer(body):
            src = match.group(1)
            if not src or src.startswith("data:") or src.startswith("http"):
                continue
            try:
                images.append((html.parent / src).resolve().relative_to(base.resolve()).as_posix())
            except ValueError:
                continue
    return {
        "title": title or stem,
        "txt": txt.relative_to(base).as_posix(),
        "html": html_rel,
        "images": images,
    }


def build(base: Path) -> int:
    notes = base / "Notes" / "txt"
    if not notes.is_dir():
        return 0
    index = {}
    for txt in sorted(notes.glob("*.txt")):
        if "_" not in txt.stem:
            continue
        note_id = txt.stem.split("_", 1)[0]
        index[note_id] = entry(base, txt)
    if not index:
        return 0
    target = base / "Notes" / "index.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(index, indent=1))
    return sum(1 for value in index.values() if value["images"])


def main() -> None:
    wanted = {item.strip().lower() for item in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if item.strip()}
    total = 0
    for base in sorted(ROOT.iterdir()):
        if not base.is_dir() or base.name.startswith("."):
            continue
        if wanted and base.name.lower() not in wanted:
            continue
        with_images = build(base)
        if with_images:
            print(f"{base.name}: {with_images} notes with images", flush=True)
        total += with_images
    print(f"total {total}")


if __name__ == "__main__":
    main()
