"""OCR + BIP39 scan over one account's export.

Text is extracted from images (RapidOCR), notes and filenames, indexed for
search, and scanned for BIP39 word runs. A run of 3–4 words is `low` (a
short candidate, noisy by design), 5–7 `minimum`, 8–11 `medium`, 12+ `high`;
a 12/15/18/21/24-word window with a valid BIP39 checksum is also marked
`valid` (checksum only — no balance lookup).

Artefacts (all under the account root, never outside it):

    Scan/index.json     one entry per file: path, area, kind, name, text
    Scan/findings.json  phrases with source, tier and checksum
    Scan/summary.json   counts for the panel
    Scan/ocr/…          raw extracted text
    Scan/thumbs/…       ～512px JPEG previews for the photo grid
"""

from __future__ import annotations

import hashlib
import html as html_lib
import itertools
import json
import logging
import os
import re
import subprocess
import time
import zipfile
from pathlib import Path

log = logging.getLogger("worker.scan")

WORDLIST = Path(__file__).with_name("data") / "bip39_english.txt"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".bmp", ".tiff"}
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp"}
# Plain-text containers.  .ics/.vcf/.emlx are calendar/contact/mail exports
# that used to be skipped even though they are ordinary text.
TEXT_EXT = {
    ".txt", ".md", ".csv", ".json", ".jsonl", ".html", ".htm", ".xml",
    ".log", ".yaml", ".yml", ".eml", ".emlx", ".mbox", ".ics", ".vcf",
    ".webarchive", ".rtf",
}
# OOXML packages (docx/xlsx/pptx) and the Apple iWork equivalents are ZIPs
# holding XML.  Text extraction is stdlib-only.
OFFICE_EXT = {".docx", ".xlsx", ".pptx", ".pages", ".numbers", ".key"}
PDF_EXT = {".pdf"}
DOC_EXT = OFFICE_EXT | PDF_EXT | {".doc"}
# A seed phrase is at most 24 words; chunking large text keeps memory bounded
# without losing a phrase that crosses a chunk boundary.
CHUNK_CHARS = 2_000_000
CHUNK_OVERLAP = 4000
MAX_TEXT = 40000          # per-file text kept in Scan/index.json
MAX_FILE = 32 << 20       # hard read cap for a text/document file
MAX_SCAN_CHARS = 32 << 20 # text actually fed to the phrase scanner
CHECKSUM_COUNTS = {12: 128, 15: 160, 18: 192, 21: 224, 24: 256}
WEB_TOKENS = {
    "top", "width", "height", "style", "border", "margin", "padding", "left", "right",
    "bottom", "color", "child", "first", "last", "group", "item", "list", "text",
    "font", "size", "auto", "solid", "none", "block", "table", "column", "row",
    "content", "position", "image", "media", "root", "body", "head", "link", "meta",
    "script", "button", "form", "label", "option", "value", "name", "class", "input",
    "select", "radio", "hidden", "display", "search", "drop", "section", "main",
    "type", "time", "submit", "reset", "number", "date", "email", "password", "file",
    "range", "line", "space", "center", "middle", "start", "end", "order", "index",
    "scale", "shadow", "radius", "outline", "cursor", "pointer", "active", "focus",
    "title", "header", "footer", "article", "aside", "nav", "source", "track", "path",
    "fill", "stroke", "circle", "units", "important", "webkit", "absolute", "relative",
    "flex", "grid", "inline", "transform", "transition", "opacity", "background",
    "icon", "hover", "document", "video", "page", "error", "account", "case", "box",
    "card", "panel", "menu", "tab", "container", "wrapper", "modal", "screen", "banner",
    "hero", "field", "visible", "static", "fixed", "sticky", "overflow", "weight",
    "dashed", "dotted", "normal", "bold", "italic", "uppercase", "lowercase",
    "capitalize", "nowrap", "wrap", "default", "ease", "linear", "infinite",
    "alternate", "forwards", "backwards",
}

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
    if count >= 3:
        # Short runs are kept as low-confidence candidates: enough signal to
        # inspect next to the source image, too little to call a seed.
        return "low"
    return "none"


def is_spam_phrase(phrase: str) -> bool:
    """One word filling the phrase, HTML/CSS selectors and document noise.

    The panel hides these by default; keeping the flag (instead of dropping
    the finding) means a real, unusual seed is always recoverable.
    """
    words = str(phrase or "").lower().split()
    if len(words) < 3:
        return False
    index = word_index()
    # A real seed can only contain BIP39 words; OCR/manual text cannot.
    if any(word not in index for word in words):
        return True
    # BIP39 phrases are 12/15/18/21/24 words.  A longer run is merged
    # prose/JSON; other counts above 11 are not a phrase either.
    if len(words) > 24 or (len(words) > 11 and len(words) not in CHECKSUM_COUNTS):
        return True
    # HTML/CSS property dumps: "style border top width border top …".
    web = sum(1 for word in words if word in WEB_TOKENS)
    if web >= 3 and web * 2 >= len(words):
        return True
    # Two or more repeated words is very unlikely in a random seed.
    if len(set(words)) <= len(words) - 2:
        return True
    counts: dict[str, int] = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1
    top = max(counts.values())
    return top == len(words) or (top >= 3 and top >= len(words) - 2)


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


def _grid_sequences(text: str, index: dict[str, int] | None = None) -> list[str]:
    """`1. word` … `12. word` grids, in order.

    OCR often drops one number (the word still sits on its own line). When the
    grid is otherwise complete, fill up to two gaps from single BIP39 words
    that appear on their own line — that reconstructs the real phrase instead
    of a checksum-lucky slice of the prose around it."""
    index = index or word_index()
    grid: dict[int, list[str]] = {}
    numbered: set[str] = set()
    for number, word in re.findall(
        r"(?<![0-9A-Za-z])(\d{1,2})\s*[.):]?\s*([A-Za-z]{2,})(?![A-Za-z])", text
    ):
        grid.setdefault(int(number), []).append(word)
        numbered.add(word.lower())
    highest = max(grid, default=0)
    if highest < 5:
        return []
    missing = [position for position in range(1, highest + 1) if position not in grid]
    if missing:
        candidates: list[str] = []
        for line in str(text).splitlines():
            candidate = line.strip().strip("`*•- ").lower()
            if (
                candidate
                and re.fullmatch(r"[a-z]+", candidate)
                and candidate in index
                and candidate not in numbered
                and candidate not in candidates
            ):
                candidates.append(candidate)
        if candidates and len(missing) <= 5 and len(candidates) >= len(missing):
            for combo in itertools.permutations(candidates[:8], len(missing)):
                assignment = dict(zip(missing, combo))
                words = [
                    assignment.get(position) or grid[position][0]
                    for position in range(1, highest + 1)
                ]
                if checksum_ok(words, index):
                    return [" ".join(words)]
        for position, word in zip(missing, candidates):
            grid[position] = [word]
    if all(position in grid for position in range(1, highest + 1)):
        words = [grid[position][0] for position in range(1, highest + 1)]
        # A numbered instruction manual also produces a numbered grid; only a
        # grid whose every word is BIP39 is a seed.
        if all(word.lower() in index for word in words):
            return [" ".join(words)]
    return []


def find_sequences(text: str, index: dict[str, int] | None = None) -> list[dict]:
    index = index or word_index()
    if not text:
        return []
    grid_sequences = _grid_sequences(str(text), index)
    blob = " ".join([str(text), *grid_sequences])
    findings: list[dict] = []
    seen: set[str] = set()

    def add(phrase: str, offset: int = 0):
        words = phrase.split()
        if phrase in seen or len(words) < 3:
            return
        seen.add(phrase)
        findings.append(
            {
                "phrase": phrase,
                "words": len(words),
                "tier": tier_for(len(words)),
                "checksum": checksum_ok(words, index) if len(words) in CHECKSUM_COUNTS else False,
                "spam": is_spam_phrase(phrase),
                "offset": offset,
            }
        )

    if grid_sequences:
        for phrase in grid_sequences:
            add(phrase)
        if any(item["checksum"] for item in findings):
            # The numbered grid is the seed; prose around it only produces
            # checksum-lucky slices.
            return findings

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
    # A run of a real BIP39 length is the phrase. A run one/two words longer
    # is usually a label ("secret key", "recovery phrase") glued to it: try
    # the anchored window and record it, instead of every sliding slice (which
    # manufactures checksum-lucky slices of a 16-word custom phrase).
    size = len(run)
    if size <= 4:
        # Low-confidence: a short BIP39 run (often a product name or a line
        # fragment). Keep it separate from the 5+ tiers so it stays filterable.
        add(" ".join(run), start)
        return
    if size in CHECKSUM_COUNTS:
        add(" ".join(run), start)
        return
    added = False
    for target in CHECKSUM_COUNTS:
        if 0 < size - target <= 2:
            # Slide over every window of a real length.  "NOTE:" / "END" are
            # themselves BIP39 words (vCard/ICS/OCR labels), so the valid
            # phrase can sit one or two words inside the run, not only at an
            # edge.
            for offset in range(size - target + 1):
                window = run[offset : offset + target]
                if checksum_ok(window, index):
                    add(" ".join(window), start)
                    added = True
    if not added:
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
    if rel.startswith("Contacts/"):
        return "contacts"
    if rel.startswith("Calendar/"):
        return "calendar"
    if rel.startswith("Reminders/"):
        return "reminders"
    if rel.startswith("Mail/"):
        return "mail"
    if rel.startswith("Account/"):
        return "account"
    return "other"


def json_text(text: str) -> str:
    """Extract only JSON string values (not keys).

    Contacts, calendar and mail exports are JSON; scanning the raw document
    would make field names like ``"false"``/``"title"`` look like BIP39
    candidates. The values (names, notes, subjects, bodies) are what matter.
    """
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return text
    out: list[str] = []

    def walk(value):
        if isinstance(value, str):
            if value:
                out.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item)

    walk(data)
    return "\n".join(out)


def kind_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXT or suffix in VIDEO_EXT:
        return "image"
    if suffix == ".txt" or suffix in TEXT_EXT or suffix in DOC_EXT:
        return "note" if "Notes/" in path.as_posix() else "file"
    return "file"


def _read_limited(path: Path, limit: int = MAX_FILE, tail: int = 4 << 20) -> str:
    """Read a text file, keeping the head and (for huge files) the tail.

    A 3.8 GB .mbox must not be loaded whole, but a seed at the end of it
    should still be seen.  For files within the limit the return value is the
    complete text, so JSON parsing and calendars stay correct.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    try:
        if size <= limit:
            return path.read_text(encoding="utf-8", errors="replace")
        with path.open("rb") as handle:
            head = handle.read(limit)
            if size > tail:
                handle.seek(-tail, 2)
                return (
                    head.decode("utf-8", "replace")
                    + "\n"
                    + handle.read(tail).decode("utf-8", "replace")
                )
            return head.decode("utf-8", "replace")
    except OSError:
        return ""


def _office_text(path: Path) -> str:
    """Text from a docx/xlsx/pptx/pages/numbers ZIP package."""
    out: list[str] = []
    try:
        with zipfile.ZipFile(path) as package:
            names = [
                name
                for name in package.namelist()
                if name.endswith(".xml")
                and name.startswith(("word/", "xl/", "ppt/", "Index/", "Metadata/"))
            ]
            if not names:
                names = [name for name in package.namelist() if name.endswith(".xml")]
            for name in names[:120]:
                try:
                    raw = package.read(name)[: 4 << 20].decode("utf-8", "replace")
                except Exception:
                    continue
                raw = re.sub(r"<[^>]+>", " ", raw)
                out.append(html_lib.unescape(raw))
    except (zipfile.BadZipFile, OSError):
        pass
    return "\n".join(out)


def _pdf_text(path: Path) -> str:
    """Text layer of a PDF.  Scanned PDFs have none; their pages would need
    rendering + OCR (a later pass)."""
    try:
        from pypdf import PdfReader
    except Exception:
        return ""
    try:
        reader = PdfReader(str(path))
        out: list[str] = []
        for page in reader.pages[:120]:
            try:
                out.append(page.extract_text() or "")
            except Exception:
                continue
        return "\n".join(out)
    except Exception:
        return ""


def read_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in PDF_EXT:
        return _pdf_text(path)
    if suffix in OFFICE_EXT:
        return _office_text(path)
    if suffix == ".doc":
        try:
            raw = path.read_bytes()[:MAX_FILE].decode("latin-1", "ignore")
        except OSError:
            return ""
        return re.sub(r"[^\x20-\x7e\n]+", " ", raw)
    raw = _read_limited(path)
    if suffix in {".html", ".htm", ".xml", ".webarchive"}:
        # Strip style/script bodies first: their CSS property names are BIP39
        # words ("top", "width", "border", …) and used to produce hundreds
        # of false seed phrases per webarchive.
        raw = re.sub(
            r"<(style|script)\b[^>]*>.*?</\1>",
            " ",
            raw,
            flags=re.S | re.I,
        )
        raw = re.sub(r"<[^>]+>", " ", raw)
        raw = html_lib.unescape(raw)
    if suffix == ".rtf":
        raw = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", raw)
        raw = raw.replace("{", " ").replace("}", " ")
    if suffix == ".json":
        raw = json_text(raw)
    elif suffix == ".jsonl":
        lines = []
        for line in raw.splitlines():
            lines.append(json_text(line))
        raw = "\n".join(lines)
    return re.sub(r"[ \t]+", " ", raw)


def _chunks(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP):
    if len(text) <= size:
        yield text
        return
    start = 0
    while start < len(text):
        yield text[start : start + size]
        if start + size >= len(text):
            break
        start += size - overlap


def find_in_text(text: str, index: dict[str, int] | None = None) -> list[dict]:
    """find_sequences over arbitrarily large text, deduped across chunks."""
    index = index or word_index()
    if not text:
        return []
    text = str(text)[:MAX_SCAN_CHARS]
    found: list[dict] = []
    seen: set[str] = set()
    for chunk in _chunks(text):
        for item in find_sequences(chunk, index):
            phrase = item["phrase"]
            if phrase in seen:
                continue
            seen.add(phrase)
            found.append(item)
    return found


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
        from PIL import ImageOps

        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(path) as image:
            # Phone photos carry the orientation in EXIF; the browser applies
            # it to the original, but a re-encoded JPEG does not.  Apply it
            # to the pixels so the grid is never sideways or mirrored.
            upright = ImageOps.exif_transpose(image)
            if upright is not None:
                image = upright
            image = image.convert("RGB")
            image.thumbnail((size, size))
            image.save(target, "JPEG", quality=82)
        return True
    except Exception:
        return False


def preview(path: Path, target: Path, size: int = 2048) -> bool:
    """A larger JPEG for HEIC/HEIF, which the browser cannot decode itself."""
    try:
        Image = _pil()
        from PIL import ImageOps

        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(path) as image:
            upright = ImageOps.exif_transpose(image)
            if upright is not None:
                image = upright
            image = image.convert("RGB")
            image.thumbnail((size, size))
            image.save(target, "JPEG", quality=88)
        return True
    except Exception:
        return False


def _ocr_engine():
    global _OCR
    if _OCR is None:
        from rapidocr_onnxruntime import RapidOCR

        # One ONNX thread per worker: the parallelism comes from running
        # several worker *processes*, and letting each one grab every core
        # would make them fight over the CPU (measured: 8 processes with the
        # default -1 were no faster than one).
        threads = int(os.environ.get("SCAN_OCR_THREADS") or 1)
        _OCR = RapidOCR(intra_op_num_threads=threads, inter_op_num_threads=1)
    return _OCR


def ocr_image(path: Path) -> str:
    import numpy as np

    from PIL import ImageOps

    Image = _pil()
    with Image.open(path) as image:
        upright = ImageOps.exif_transpose(image)
        if upright is not None:
            image = upright
        image = image.convert("RGB")
        image.thumbnail((2200, 2200))
        result, _ = _ocr_engine()(np.array(image))
    return "\n".join(item[1] for item in (result or []) if item and len(item) > 1)


def _image_task(task: dict) -> dict:
    """Decode one image once and produce its thumbnail and/or OCR text.

    Runs in a worker process.  The old loop decoded every image twice — once
    for the 512 px thumbnail and again for OCR — and did so one image at a
    time, which is why a phone library of a few hundred thousand images took
    days.  Here one decode feeds both, and one process per core works through
    the queue independently.
    """
    import numpy as np

    from PIL import ImageOps

    path = Path(task["path"])
    thumb = Path(task["thumb"])
    ocr_file = Path(task["ocr"])
    need_ocr = bool(task.get("need_ocr"))
    need_thumb = bool(task.get("need_thumb"))
    text = ""
    thumb_ok = False
    try:
        Image = _pil()
        with Image.open(path) as image:
            upright = ImageOps.exif_transpose(image)
            if upright is not None:
                image = upright
            rgb = image.convert("RGB")
            if need_thumb:
                tiny = rgb.copy()
                tiny.thumbnail((512, 512))
                thumb.parent.mkdir(parents=True, exist_ok=True)
                tiny.save(thumb, "JPEG", quality=82)
                thumb_ok = True
            if need_ocr:
                size = int(os.environ.get("SCAN_OCR_MAX") or 2200)
                ocr_input = rgb.copy()
                ocr_input.thumbnail((size, size))
                result, _ = _ocr_engine()(np.array(ocr_input), use_cls=bool(int(os.environ.get("SCAN_OCR_CLS") or 1)))
                text = "\n".join(
                    item[1] for item in (result or []) if item and len(item) > 1
                )
                ocr_file.parent.mkdir(parents=True, exist_ok=True)
                # Write even an empty result: "this image has no text" is a
                # valid cache entry and must not be OCR'd again next run.
                ocr_file.write_text(text, encoding="utf-8")
    except Exception as error:  # noqa: BLE001 - one bad file must not stop the scan
        return {
            "need_ocr": need_ocr,
            "need_thumb": need_thumb,
            "text": "",
            "thumb": False,
            "error": type(error).__name__,
        }
    return {
        "need_ocr": need_ocr,
        "need_thumb": need_thumb,
        "text": text,
        "thumb": thumb_ok,
        "error": None,
    }


def _iter_image_results(tasks: list[dict], workers: int):
    """Yield worker results in task order, with a bounded look-ahead.

    Keeping only a few tasks in flight bounds memory (OCR text can be large)
    while still letting every core run at full speed.
    """
    if not tasks:
        return
    from collections import deque
    from concurrent.futures import ProcessPoolExecutor

    lookahead = max(2, workers * 3)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        pending: deque = deque()
        source = iter(tasks)

        def fill() -> None:
            while len(pending) < lookahead:
                task = next(source, None)
                if task is None:
                    return
                pending.append(pool.submit(_image_task, task))

        fill()
        while pending:
            yield pending.popleft().result()
            fill()


def video_proxy(path: Path, target: Path) -> bool:
    """H.264/AAC MP4 that every browser can play.

    iPhone videos are HEVC (hvc1); Chrome/Chromium on many desktops cannot
    decode HEVC, so the player stays black.  A fast 720p-class H.264 proxy
    fixes playback without touching the original export.
    """
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(path),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-vf",
                "scale='min(1280,iw)':-2",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(target),
            ],
            capture_output=True,
            timeout=600,
        )
        return target.exists() and target.stat().st_size > 0
    except Exception:
        return False


def video_thumb(path: Path, target: Path) -> bool:
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        for seek in ("1", "0"):
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-ss", seek, "-autorotate",
                 "-i", str(path), "-frames:v", "1", "-vf", "scale=512:-2", str(target)],
                capture_output=True,
                timeout=30,
            )
            if target.exists() and target.stat().st_size > 0:
                return True
        return False
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

    # Compare this run with the previous findings so the report can say what
    # is genuinely new (and at which tier), not just the total.
    previous_findings: set[tuple[str, str]] = set()
    previous_file = scan_dir / "findings.json"
    if previous_file.exists():
        try:
            previous_payload = json.loads(previous_file.read_text(encoding="utf-8"))
            previous_findings = {
                (str(item.get("file", "")), str(item.get("phrase", "")))
                for item in previous_payload.get("findings", [])
                if isinstance(item, dict)
            }
        except Exception:
            previous_findings = set()

    files = sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and "Scan" not in path.relative_to(root).parts
        and path.name != "manifest.sqlite3"
        # The exporter writes a .part file and renames it when done.  A scan
        # running at the same time (the account lock now has a timeout) can
        # list a .part that is renamed before it is read; skip temp files.
        and not path.name.endswith((".part", ".tmp"))
    )
    if limit:
        files = files[:limit]

    entries: list[dict] = []
    findings: list[dict] = []
    images = ocr_ok = ocr_failed = 0
    tiers = {"low": 0, "minimum": 0, "medium": 0, "high": 0, "valid": 0}
    total = len(files)

    # Plan the image work before the loop.  A phone library is hundreds of
    # thousands of files; doing OCR one-by-one on one core is the difference
    # between hours and days.  Workers decode each image once and write the
    # OCR cache/thumbnail themselves; the main loop stays in file order and
    # only post-processes the text.
    workers = int(os.environ.get("SCAN_WORKERS") or 0) or min(8, os.cpu_count() or 1)
    if not os.environ.get("SCAN_OCR_THREADS"):
        # Parallel workers get one ONNX thread each; a single worker may use
        # a few cores.
        os.environ["SCAN_OCR_THREADS"] = (
            "1" if workers > 1 else str(max(1, min(4, os.cpu_count() or 1)))
        )
    image_plan: dict[int, dict] = {}
    image_tasks: list[dict] = []
    for number, path in enumerate(files, 1):
        suffix = path.suffix.lower()
        if suffix not in IMAGE_EXT and suffix not in VIDEO_EXT:
            continue
        rel = path.relative_to(root).as_posix()
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        thumb = scan_dir / "thumbs" / f"{rel}.jpg"
        plan = {"mtime": mtime, "thumb": thumb, "video": suffix in VIDEO_EXT}
        image_plan[number] = plan
        if plan["video"]:
            continue
        ocr_file = scan_dir / "ocr" / f"{rel}.txt"
        cached = ocr_file.exists() and ocr_file.stat().st_mtime >= mtime
        need_thumb = not (thumb.exists() and thumb.stat().st_mtime >= mtime)
        plan.update({"ocr_file": ocr_file, "cached": cached, "task": not cached or need_thumb})
        if plan["task"]:
            image_tasks.append(
                {
                    "path": str(path),
                    "thumb": str(thumb),
                    "ocr": str(ocr_file),
                    "need_ocr": not cached,
                    "need_thumb": need_thumb,
                }
            )
    image_results = _iter_image_results(image_tasks, workers)

    for number, path in enumerate(files, 1):
        rel = path.relative_to(root).as_posix()
        area = area_for(rel)
        kind = kind_for(path)
        plan = image_plan.get(number)
        if plan is not None:
            mtime = plan["mtime"]
        else:
            try:
                mtime = path.stat().st_mtime
            except OSError:
                # Renamed/removed between the walk and the stat.
                continue
        text = ""
        source = "text"

        if plan is not None or kind == "image":
            images += 1
            suffix = path.suffix.lower()
            if plan is None:
                # The file appeared/changed between planning and the loop;
                # fall back to the old one-at-a-time path.
                thumb = scan_dir / "thumbs" / f"{rel}.jpg"
                if not thumbnail(path, thumb):
                    if suffix in VIDEO_EXT:
                        video_thumb(path, thumb)
                try:
                    ocr_file = scan_dir / "ocr" / f"{rel}.txt"
                    cached = ocr_file.exists() and ocr_file.stat().st_mtime >= mtime
                    text = (
                        ocr_file.read_text(encoding="utf-8", errors="replace")
                        if cached
                        else ocr_image(path)
                    )
                    source = "ocr"
                    ocr_ok += 1
                except Exception as error:
                    ocr_failed += 1
                    log.info("ocr failed for %s: %s", rel, type(error).__name__)
            elif plan["video"]:
                if not thumbnail(path, plan["thumb"]):
                    video_thumb(path, plan["thumb"])
                source = "ocr"
                ocr_ok += 1
            else:
                ocr_file = plan["ocr_file"]
                if plan["task"]:
                    result = next(image_results)
                    if result.get("need_ocr"):
                        if result.get("error"):
                            ocr_failed += 1
                            log.info(
                                "ocr failed for %s: %s", rel, result.get("error")
                            )
                        else:
                            text = result.get("text") or ""
                            ocr_ok += 1
                    else:
                        text = (
                            ocr_file.read_text(encoding="utf-8", errors="replace")
                            if ocr_file.exists()
                            else ""
                        )
                        ocr_ok += 1
                else:
                    text = (
                        ocr_file.read_text(encoding="utf-8", errors="replace")
                        if plan["cached"]
                        else ""
                    )
                    ocr_ok += 1
                source = "ocr"
        elif path.suffix.lower() in TEXT_EXT or path.suffix.lower() in DOC_EXT or path.suffix.lower() in {".txt", ".md"}:
            suffix = path.suffix.lower()
            try:
                if suffix in DOC_EXT:
                    # PDF/Office extraction is the expensive part. Cache the
                    # text by mtime like the image OCR cache, so a re-scan does
                    # not parse 6,000 PDFs again.
                    cache_file = scan_dir / "text" / f"{rel}.txt"
                    if (
                        cache_file.exists()
                        and cache_file.stat().st_mtime >= mtime
                    ):
                        text = cache_file.read_text(encoding="utf-8", errors="replace")
                    else:
                        text = read_text(path)
                        cache_file.parent.mkdir(parents=True, exist_ok=True)
                        cache_file.write_text(text, encoding="utf-8")
                else:
                    text = read_text(path)
            except OSError:
                continue
            source = "note" if area == "notes" else "text"

        haystack = " ".join([path.name, text])
        found = find_in_text(haystack, index)
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
                    "spam": item.get("spam", is_spam_phrase(phrase)),
                    "source": source if source != "text" else (
                        "contact" if area == "contacts" else
                        "calendar" if area == "calendar" else
                        "reminder" if area == "reminders" else
                        "mail" if area == "mail" else
                        "filename"
                    ),
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

    # The pool normally unwinds when the generator is garbage-collected, but
    # closing it here releases the workers (and their ONNX memory) promptly.
    if hasattr(image_results, "close"):
        image_results.close()

    generated = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    new_findings = [
        item
        for item in findings
        if (item["file"], item["phrase"]) not in previous_findings
    ]
    new_tiers = {"low": 0, "minimum": 0, "medium": 0, "high": 0, "valid": 0}
    for item in new_findings:
        new_tiers[item["tier"]] = new_tiers.get(item["tier"], 0) + 1
        if item["checksum"]:
            new_tiers["valid"] += 1
    _write_json(scan_dir / "index.json", {"generatedAt": generated, "entries": entries})
    _write_json(scan_dir / "findings.json", {"generatedAt": generated, "findings": findings})
    summary = {
        "generatedAt": generated,
        "files": len(entries),
        "images": images,
        "ocrOk": ocr_ok,
        "ocrFailed": ocr_failed,
        "findings": len(findings),
        "newFindings": len(new_findings),
        "newTiers": new_tiers,
        # Distinct files/images that produced at least one phrase, so the
        # operator can tell "9 phrases in 1 screenshot" from "9 screenshots".
        "hitFiles": len({item["file"] for item in findings}),
        "hitImages": len(
            {
                item["file"]
                for item in findings
                if Path(item["file"]).suffix.lower() in IMAGE_EXT
            }
        ),
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

    # SCAN_ENGINE=vlm sends the images to the vision-LLM endpoint instead of
    # running RapidOCR on the VPS.  The dashboard already shows the images
    # (with "OCR pending"); this pass only fills Scan/ocr and findings.
    if str(os.environ.get("SCAN_ENGINE") or "").lower() == "vlm":
        import sys

        from pathlib import Path as _Path

        sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
        import scan_vlm  # noqa: PLC0415

        result = scan_vlm.process_account(
            root,
            concurrency=int(os.environ.get("SCAN_VLM_CONCURRENCY") or 8),
            limit=int(payload.get("limit") or 0),
        )
        ctx.emit("job:scan_done", result if isinstance(result, dict) else {"ok": True})
        return

    summary = scan_export(ctx, root, limit=int(payload.get("limit") or 0), progress=progress)
    ctx.emit("job:scan_done", summary)
