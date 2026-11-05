"""Import a harvested `out/` tree into the panel's export layout.

The sibling harvester writes:

    out/photos/…, out/hidden/…, out/notes/…, out/drive/…, out/ocr/…

Our panel reads `export/<email>/Photos/{Library,Hidden,…}`, `Notes/txt`,
`Drive`, `Scan/…` and `manifest.sqlite3`. This module maps one to the other,
dedupes HEIC/JPG and live-photo twins, reuses the existing OCR text (no slow
re-OCR), builds the search index, seed findings, thumbnails and a manifest so
the live check has exported counts.

It is also the importer behind the panel's "Import folder" action.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import time
from pathlib import Path

from . import exporter, scan

log = logging.getLogger("worker.import")

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".bmp", ".tiff"}
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp"}
TEXT_EXT = {".txt", ".md", ".csv", ".json", ".html", ".htm", ".xml", ".log", ".yaml", ".yml"}
UUID_RE = re.compile(r"^([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27})")


def _asset(name: str) -> str:
    match = UUID_RE.match(name)
    return match.group(1).upper() if match else name


def _pick(folder: Path) -> list[Path]:
    """One display photo + one playable video per asset.

    HEIC loses to its JPG twin (browsers cannot show HEIC) and a MOV loses to
    its MP4 twin (Chrome cannot play most HEVC MOVs). Live photos keep both
    the still and the motion clip, so the panel can play the video."""
    if not folder.is_dir():
        return []
    files = [path for path in folder.iterdir() if path.is_file()]

    by_asset: dict[str, list[Path]] = {}
    for path in files:
        by_asset.setdefault(_asset(path.name), []).append(path)

    chosen: list[Path] = []
    for paths in by_asset.values():
        photos = [path for path in paths if path.suffix.lower() in IMAGE_EXT]
        videos = [path for path in paths if path.suffix.lower() in VIDEO_EXT]
        if photos:
            non_heic = [path for path in photos if path.suffix.lower() not in {".heic", ".heif"}]
            chosen.append(sorted(non_heic or photos)[0])
        if videos:
            mp4s = [path for path in videos if path.suffix.lower() == ".mp4"]
            chosen.append(sorted(mp4s or videos)[0])
    return sorted(chosen)


def _copy(source: Path, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    try:
        return dest.stat().st_size
    except OSError:
        return 0


def _thumb(source: Path, target: Path) -> bool:
    if source.suffix.lower() in VIDEO_EXT:
        return scan.video_thumb(source, target)
    return scan.thumbnail(source, target)


def _read(path: Path) -> str:
    try:
        if path.stat().st_size > 5 << 20:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")[: scan.MAX_TEXT]
    except OSError:
        return ""


def _split_ocr_name(name: str) -> tuple[str, str]:
    # `photos__<asset>_original_IMG_0190.HEIC.txt`
    if "__" not in name:
        return "", name
    prefix, rest = name.split("__", 1)
    return prefix, rest[: -4] if rest.lower().endswith(".txt") else rest


def import_out(out_dir, export_dir, email: str, progress=None) -> dict:
    root = Path(out_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"{root} is not a folder")
    target = Path(export_dir) / exporter.safe_name(email, "account")
    for sub in ("Photos/Library", "Photos/Hidden", "Photos/Recently Deleted",
                "Notes/txt", "Drive", "Scan/ocr", "Scan/thumbs", "Account"):
        (target / sub).mkdir(parents=True, exist_ok=True)

    library = _pick(root / "photos")
    hidden = _pick(root / "hidden")
    total = len(library) + len(hidden)
    done = 0
    bytes_total = 0

    rel_by_asset: dict[str, str] = {}
    entries: list[dict] = []
    image_paths: list[tuple[Path, str, str]] = []

    def add_image(source: Path, area: str, folder: str):
        nonlocal done, bytes_total
        dest = target / "Photos" / folder / source.name
        bytes_total += _copy(source, dest)
        rel = dest.relative_to(target).as_posix()
        key = _asset(source.name)
        existing = rel_by_asset.get(key)
        if not existing or (
            source.suffix.lower() in IMAGE_EXT
            and Path(existing).suffix.lower() in VIDEO_EXT
        ):
            rel_by_asset[key] = rel
        thumb = target / "Scan" / "thumbs" / f"{rel}.jpg"
        _thumb(dest, thumb)
        entries.append(
            {
                "path": rel,
                "area": area,
                "kind": "image",
                "name": source.name,
                "text": "",
                "mtime": dest.stat().st_mtime if dest.exists() else time.time(),
            }
        )
        image_paths.append((dest, rel, area))
        done += 1
        if progress:
            progress(done, max(total, 1), folder)

    for source in library:
        add_image(source, "photos", "Library")
    for source in hidden:
        add_image(source, "hidden", "Hidden")

    # Notes (plain text exports from the harvester) + the vision-verified list.
    note_count = 0
    for source in sorted((root / "notes").glob("*")) if (root / "notes").is_dir() else []:
        if not source.is_file():
            continue
        dest = target / "Notes" / "txt" / source.name
        _copy(source, dest)
        text = _read(dest)
        entries.append(
            {
                "path": dest.relative_to(target).as_posix(),
                "area": "notes",
                "kind": "note",
                "name": dest.name,
                "text": text,
                "mtime": dest.stat().st_mtime,
            }
        )
        note_count += 1
    seeds_md = root / "seed_screens.md"
    if seeds_md.exists():
        dest = target / "Notes" / "txt" / "seed_screens.txt"
        _copy(seeds_md, dest)
        entries.append(
            {
                "path": dest.relative_to(target).as_posix(),
                "area": "notes",
                "kind": "note",
                "name": dest.name,
                "text": _read(dest),
                "mtime": dest.stat().st_mtime,
            }
        )
        note_count += 1

    # Drive tree.
    drive_files = 0
    drive_bytes = 0
    drive_root = root / "drive"
    if drive_root.is_dir():
        for source in sorted(drive_root.rglob("*")):
            if not source.is_file():
                continue
            rel = source.relative_to(drive_root)
            dest = target / "Drive" / rel
            drive_bytes += _copy(source, dest)
            drive_files += 1
            entries.append(
                {
                    "path": dest.relative_to(target).as_posix(),
                    "area": "drive",
                    "kind": "note" if dest.suffix.lower() in TEXT_EXT else "file",
                    "name": dest.name,
                    "text": _read(dest),
                    "mtime": dest.stat().st_mtime,
                }
            )

    # Reuse the harvester's OCR: map `<area>__<source>` onto the kept file.
    by_path = {entry["path"]: entry for entry in entries}
    ocr_texts: dict[str, list[str]] = {}
    ocr_dir = root / "ocr"
    if ocr_dir.is_dir():
        for ocr_file in sorted(ocr_dir.glob("*.txt")):
            _prefix, source_name = _split_ocr_name(ocr_file.name)
            rel = rel_by_asset.get(_asset(source_name))
            if not rel:
                continue
            text = _read(ocr_file)
            if text:
                ocr_texts.setdefault(rel, []).append(text)
                ocr_copy = target / "Scan" / "ocr" / f"{rel}.txt"
                ocr_copy.parent.mkdir(parents=True, exist_ok=True)
                ocr_copy.write_text(text, encoding="utf-8")

    for rel, chunks in ocr_texts.items():
        if rel in by_path:
            by_path[rel]["text"] = "\n".join(dict.fromkeys(chunks))[: scan.MAX_TEXT]

    index = scan.word_index()
    findings: list[dict] = []
    tiers = {"minimum": 0, "medium": 0, "high": 0, "valid": 0}
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        haystack = f"{entry['name']} {entry.get('text', '')}"
        for item in scan.find_sequences(haystack, index):
            marker = (entry["path"], item["phrase"])
            if marker in seen:
                continue
            seen.add(marker)
            findings.append(
                {
                    "file": entry["path"],
                    "area": entry["area"],
                    "name": entry["name"],
                    "phrase": item["phrase"],
                    "words": item["words"],
                    "tier": item["tier"],
                    "checksum": item["checksum"],
                    "source": "ocr" if entry["area"] in ("photos", "hidden") and entry.get("text") else
                    "note" if entry["area"] == "notes" else "filename",
                    "snippet": (entry.get("text") or "")[:180].strip(),
                }
            )
            tiers[item["tier"]] = tiers.get(item["tier"], 0) + 1
            if item["checksum"]:
                tiers["valid"] += 1

    generated = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    scan_dir = target / "Scan"
    scan_dir.mkdir(parents=True, exist_ok=True)
    (scan_dir / "index.json").write_text(
        json.dumps({"generatedAt": generated, "entries": entries}, ensure_ascii=False),
        encoding="utf-8",
    )
    (scan_dir / "findings.json").write_text(
        json.dumps({"generatedAt": generated, "findings": findings}, ensure_ascii=False),
        encoding="utf-8",
    )
    summary = {
        "generatedAt": generated,
        "files": len(entries),
        "images": len(image_paths),
        "ocrOk": len(ocr_texts),
        "ocrFailed": 0,
        "findings": len(findings),
        "tiers": tiers,
        "imported": True,
    }
    (scan_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")

    (target / "Account" / "account.json").write_text(
        json.dumps(
            {
                "email": email,
                "storage": {},
                "plan": {},
                "devices": [],
                "family": [],
                "importedFrom": str(root),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    _write_manifest(target, library, hidden, entries, drive_files)

    stills = lambda paths: [p for p in paths if p.suffix.lower() in IMAGE_EXT]
    clips = lambda paths: [p for p in paths if p.suffix.lower() in VIDEO_EXT]
    counts = {
        "photos": len(stills(library)),
        "hidden": len(stills(hidden)),
        "videos": len(clips(library)) + len(clips(hidden)),
        "deleted": 0,
        "notes": note_count,
        "albums": 0,
        "contacts": 0,
        "contactsPhone": 0,
        "contactsEmail": 0,
        "driveFiles": drive_files,
        "driveBytes": drive_bytes,
        "reminders": 0,
        "calendars": 0,
    }
    return {
        "counts": counts,
        "summary": summary,
        "files": len(entries),
        "bytes": bytes_total,
        "findings": len(findings),
    }


def _write_manifest(target: Path, library, hidden, entries, drive_files):
    db = sqlite3.connect(target / "manifest.sqlite3")
    db.execute(
        """CREATE TABLE IF NOT EXISTS files (
            key TEXT PRIMARY KEY, area TEXT, path TEXT, size INTEGER,
            sha256 TEXT, status TEXT, updated TEXT)"""
    )
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rows = []
    for paths, area in ((library, "photos"), (hidden, "hidden")):
        for source in paths:
            rows.append((f"photo:{_asset(source.name)}", area,
                         f"Photos/{'Library' if area == 'photos' else 'Hidden'}/{source.name}",
                         source.stat().st_size, "", "done", now))
    for entry in entries:
        if entry["area"] == "notes":
            note_id = _asset(entry["name"]) if _asset(entry["name"]) != entry["name"] else entry["name"]
            rows.append((f"note:{note_id}", "notes", entry["path"], 0, "", "done", now))
        elif entry["area"] == "drive":
            try:
                size = (target / entry["path"]).stat().st_size
            except OSError:
                size = 0
            rows.append((f"drive:{entry['name']}:{size}", "drive", entry["path"], size, "", "done", now))
    db.executemany(
        "INSERT OR REPLACE INTO files(key, area, path, size, sha256, status, updated) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()


def run_import(ctx, payload: dict) -> None:
    out_dir = payload.get("path") or ""
    if not out_dir:
        ctx.emit("job:error", {"error": "no folder to import"})
        return
    export_dir = payload.get("exportDir") or "./export"

    def progress(done, total, area):
        ctx.emitter.send(
            "job:import_progress",
            {"jobId": ctx.job_id, "area": area, "done": done, "total": total},
            key="import",
            throttle=1.0,
        )

    result = import_out(out_dir, export_dir, ctx.account.get("email", "account"), progress=progress)
    ctx.emit("job:import_result", result)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", help="harvested out/ folder")
    parser.add_argument("--email", required=True, help="account email for the panel")
    parser.add_argument("--export", default="./export", help="export root")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    def progress(done, total, area):
        if done == total or done % 25 == 0:
            print(f"{done}/{total} {area}", flush=True)

    result = import_out(args.out, args.export, args.email, progress=progress)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
