"""OCR + BIP39 scan over one account's export.

Text is extracted from images (RapidOCR), notes and filenames, indexed for
search, and scanned for BIP39 word runs. A run of 5–7 words is `minimum`,
8–11 `medium`, 12+ `high`; a 12/15/18/21/24-word window with a valid BIP39
checksum is also marked `valid` (checksum only — no balance lookup).

Artefacts (all under the account root, never outside it):

    Scan/index.json     one entry per file: path, area, kind, name, text
    Scan/findings.json  phrases with source, tier and checksum
    Scan/summary.json   counts for the panel
    Scan/ocr/…          raw extracted text
    Scan/thumbs/…       ～512px JPEG previews for the photo grid
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import subprocess
import time
from pathlib import Path

log = logging.getLogger("worker.scan")

WORDLIST = Path(__file__).with_name("data") / "bip39_english.txt"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".bmp", ".tiff"}
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp"}
TEXT_EXT = {".txt", ".md", ".csv", ".json", ".html", ".htm", ".xml", ".log", ".yaml", ".yml"}
MAX_TEXT = 20000
MAX_FILE = 5 << 20
CHECKSUM_COUNTS = {12: 128, 15: 160, 18: 192, 21: 224, 24: 256}
WINDOWS = (24, 21, 18, 15, 12)

_WORDS: dict[str, int] | None = None
_OCR = None
_HEIF = False


# --------------------------------------------------------------------- BIP39


def word_index() -> dict[str, int]:
    global _WORDS
    if _WORDS is None:
        words = WORDLIST.read_text(encoding="utf-8").split()
        if len(words) != 2048:
            raise RuntimeError(f"bip39 wordlist has {len(words)} words")
        _WORDS = {word: index for index, word in enumerate(words)}
    return _WORDS


def tier_for(count: int) -> str:
    if count >= 12:
        return "high"
    if count >= 8:
        return "medium"
    if count >= 5:
        return "minimum"
    return "none"


def checksum_ok(words, index: dict[str, int] | None = None) -> bool:
    index = index or word_index()
    count = len(words)
    if count not in CHECKSUM_COUNTS:
        return False
    try:
        indices = [index[word.lower()] for word in words]
    except KeyError:
        return False
    total_bits = count * 11
    checksum_bits = total_bits // 33
    entropy_bits = total_bits - checksum_bits
    if CHECKSUM_COUNTS[count] != entropy_bits:
        return False
    acc = 0
    for value in indices:
        acc = (acc << 11) | value
    checksum = acc & ((1 << checksum_bits) - 1)
    entropy = (acc >> checksum_bits).to_bytes(entropy_bits // 8, "big")
    digest = hashlib.sha256(entropy).digest()
    return digest[0] >> (8 - checksum_bits) == checksum


def _grid_sequences(text: str) -> list[str]:
    """`1. word` … `12. word` grids, in order, when the numbers are contiguous."""
    grid: dict[int, list[str]] = {}
    for number, word in re.findall(
        r"(?<![0-9A-Za-z])(\d{1,2})\s*[.):]?\s*([A-Za-z]{2,})(?![A-Za-z])", text
    ):
        grid.setdefault(int(number), []).append(word)
    sequences = []
    highest = max(grid, default=0)
    if highest >= 5 and all(position in grid for position in range(1, highest + 1)):
        sequences.append(" ".join(grid[position][0] for position in range(1, highest + 1)))
    return sequences


def find_sequences(text: str, index: dict[str, int] | None = None) -> list[dict]:
    index = index or word_index()
    if not text:
        return []
    blob = " ".join([str(text), *_grid_sequences(str(text))])
    findings: list[dict] = []
    seen: set[str] = set()

    def add(phrase: str, offset: int = 0):
        words = phrase.split()
        if phrase in seen or len(words) < 5:
            return
        seen.add(phrase)
        findings.append(
            {
                "phrase": phrase,
                "words": len(words),
                "tier": tier_for(len(words)),
                "checksum": checksum_ok(words, index) if len(words) in CHECKSUM_COUNTS else False,
                "offset": offset,
            }
        )

    tokens = re.findall(r"[A-Za-z]+", blob)
    run: list[str] = []
    start = 0
    for position, token in enumerate(tokens + [""]):
        word = token.lower()
        if word and word in index:
            if not run:
                start = position
            run.append(word)
            continue
        if run:
            _scan_run(run, index, add, start)
            run = []
    return findings


def _scan_run(run: list[str], index: dict[str, int], add, start: int) -> None:
    valid_windows: list[str] = []
    for length in WINDOWS:
        if len(run) < length:
            continue
        for offset in range(0, len(run) - length + 1):
            window = run[offset : offset + length]
            if checksum_ok(window, index):
                valid_windows.append(" ".join(window))
    if valid_windows:
        for phrase in valid_windows:
            add(phrase, start)
        return
    phrase = " ".join(run[:24])
    if len(phrase.split()) >= 5:
        add(phrase, start)


# --------------------------------------------------------------------- files


def area_for(rel: str) -> str:
    if rel.startswith("Photos/"):
        return "photos"
    if rel.startswith("Notes/"):
        return "notes"
    if rel.startswith("Drive/"):
        return "drive"
    return "other"


def kind_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXT or suffix in VIDEO_EXT:
        return "image"
    if suffix == ".txt" or suffix in TEXT_EXT:
        return "note" if "Notes/" in path.as_posix() else "file"
    return "file"


def read_text(path: Path) -> str:
    if path.stat().st_size > MAX_FILE:
        return ""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if path.suffix.lower() in {".html", ".htm", ".xml"}:
        raw = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"[ \t]+", " ", raw)[:MAX_TEXT]


def _pil():
    from PIL import Image, ImageFile

    global _HEIF
    if not _HEIF:
        try:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        except Exception:
            pass
        _HEIF = True
    Image.MAX_IMAGE_PIXELS = None
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    return Image


def thumbnail(path: Path, target: Path, size: int = 512) -> bool:
    try:
        Image = _pil()
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(path) as image:
            image = image.convert("RGB")
            image.thumbnail((size, size))
            image.save(target, "JPEG", quality=82)
        return True
    except Exception:
        return False


def _ocr_engine():
    global _OCR
    if _OCR is None:
        from rapidocr_onnxruntime import RapidOCR

        _OCR = RapidOCR()
    return _OCR


def ocr_image(path: Path) -> str:
    import numpy as np

    Image = _pil()
    with Image.open(path) as image:
        image = image.convert("RGB")
        image.thumbnail((2200, 2200))
        result, _ = _ocr_engine()(np.array(image))
    return "\n".join(item[1] for item in (result or []) if item and len(item) > 1)


def video_thumb(path: Path, target: Path) -> bool:
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-ss", "1", "-i", str(path),
             "-frames:v", "1", "-vf", "scale=512:-2", str(target)],
            capture_output=True,
            timeout=30,
        )
        return target.exists()
    except Exception:
        return False


# ----------------------------------------------------------------------- run


def _write_json(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def scan_export(ctx, root: Path, *, limit: int = 0, progress=None) -> dict:
    root = Path(root)
    index = word_index()
    scan_dir = root / "Scan"
    (scan_dir / "ocr").mkdir(parents=True, exist_ok=True)
    (scan_dir / "thumbs").mkdir(parents=True, exist_ok=True)

    files = sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and "Scan" not in path.relative_to(root).parts
        and path.name != "manifest.sqlite3"
    )
    if limit:
        files = files[:limit]

    entries: list[dict] = []
    findings: list[dict] = []
    images = ocr_ok = ocr_failed = 0
    tiers = {"minimum": 0, "medium": 0, "high": 0, "valid": 0}
    total = len(files)

    for number, path in enumerate(files, 1):
        rel = path.relative_to(root).as_posix()
        area = area_for(rel)
        kind = kind_for(path)
        mtime = path.stat().st_mtime
        text = ""
        source = "text"

        if kind == "image":
            images += 1
            thumb = scan_dir / "thumbs" / f"{rel}.jpg"
            if not thumbnail(path, thumb):
                if path.suffix.lower() in VIDEO_EXT:
                    video_thumb(path, thumb)
            try:
                if path.suffix.lower() in VIDEO_EXT:
                    text = ""
                else:
                    text = ocr_image(path)
                source = "ocr"
                ocr_ok += 1
                ocr_file = scan_dir / "ocr" / f"{rel}.txt"
                ocr_file.parent.mkdir(parents=True, exist_ok=True)
                if text:
                    ocr_file.write_text(text, encoding="utf-8")
            except Exception as error:
                ocr_failed += 1
                log.info("ocr failed for %s: %s", rel, type(error).__name__)
        elif path.suffix.lower() in TEXT_EXT or path.suffix.lower() in {".txt", ".md"}:
            text = read_text(path)
            source = "note" if area == "notes" else "text"

        haystack = " ".join([path.name, text])
        found = find_sequences(haystack, index)
        for item in found:
            phrase = item["phrase"]
            findings.append(
                {
                    "file": rel,
                    "area": area,
                    "name": path.name,
                    "phrase": phrase,
                    "words": item["words"],
                    "tier": item["tier"],
                    "checksum": item["checksum"],
                    "source": source if source != "text" else "filename",
                    "snippet": text[:180].strip(),
                }
            )
            tiers[item["tier"]] = tiers.get(item["tier"], 0) + 1
            if item["checksum"]:
                tiers["valid"] += 1

        entries.append(
            {
                "path": rel,
                "area": area,
                "kind": kind,
                "name": path.name,
                "text": text[:MAX_TEXT],
                "mtime": mtime,
            }
        )

        if progress and (number == total or number % 5 == 0):
            progress(number, total, area)

    generated = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _write_json(scan_dir / "index.json", {"generatedAt": generated, "entries": entries})
    _write_json(scan_dir / "findings.json", {"generatedAt": generated, "findings": findings})
    summary = {
        "generatedAt": generated,
        "files": len(entries),
        "images": images,
        "ocrOk": ocr_ok,
        "ocrFailed": ocr_failed,
        "findings": len(findings),
        "tiers": tiers,
    }
    _write_json(scan_dir / "summary.json", summary)
    return summary


def run_scan(ctx, payload: dict) -> None:
    from . import exporter

    root = Path(payload.get("exportDir") or "./export") / exporter.safe_name(
        ctx.account.get("email", "account")
    )
    if not root.exists():
        ctx.emit("job:error", {"error": "export not found; run an export first"})
        return

    def progress(done, total, area):
        ctx.emitter.send(
            "job:scan_progress",
            {"jobId": ctx.job_id, "area": area, "done": done, "total": total},
            key="scan",
            throttle=1.0,
        )

    summary = scan_export(ctx, root, limit=int(payload.get("limit") or 0), progress=progress)
    ctx.emit("job:scan_done", summary)
