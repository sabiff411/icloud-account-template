"""Run the Qwen3-VL endpoint over the eval set (Runpod pod).

Adds a `vlm` "engine" to the same result format, so score.py works unchanged.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image, ImageOps

import postprocess as pp

HERE = Path(__file__).resolve().parent
EVAL = HERE / "eval"
RESULTS = HERE / "results"

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

MODEL_NAME = "Qwen/Qwen3-VL-8B-Instruct"
PROMPT = (
    "Extract the seed words from this image.\n"
    "- If the words are numbered: output one line per word as '<number> <word>'.\n"
    "- If they are NOT numbered: output 'COLUMNS: <n>' on the first line (how many "
    "vertical word columns you see), then every word in row order (left-to-right, "
    "top-to-bottom).\n"
    "Output only that — no commentary."
)


def encode(path: Path, max_side: int = 1600) -> str:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im) or im
        im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def call(url: str, b64: str, timeout: int = 120) -> tuple[str, float]:
    body = {
        "model": MODEL_NAME,
        "temperature": 0,
        "max_tokens": 600,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
            ],
        }],
    }
    t0 = time.perf_counter()
    r = requests.post(url, json=body, timeout=timeout)
    r.raise_for_status()
    out = r.json()["choices"][0]["message"]["content"]
    return out, (time.perf_counter() - t0) * 1000


def _one(args):
    url, gid, path, side = args
    try:
        txt, ms = call(url, encode(Path(path), side))
    except Exception as e:
        return {"id": gid, "file": Path(path).name, "engine": "vlm", "ms": 0,
                "ocr_ms": 0, "lines": 0, "phrase": "", "words": 0, "checksum": False,
                "confidence": 0, "order": "vlm", "text": "", "rejected": [], "error": str(e)[:200]}
    # Reconstruct order from the model's own line ordering.
    import re as _re
    words = pp.numbered_words(txt)
    if words:
        # numbers carry the order; ignore the model's visual reading order
        lines = [pp.Line(w, 1.0, 0, i * 10, 1000, i * 10 + 9) for i, w in enumerate(words)]
    else:
        m = _re.search(r"COLUMNS:\s*(\d+)", txt, _re.I)
        cols = int(m.group(1)) if m else 1
        body = _re.sub(r"COLUMNS:\s*\d+", "", txt, flags=_re.I)
        raw = [w for w in (pp.match_token(t).word for t in body.split()) if w]
        ordered, _label = pp.resolve_grid(raw, cols)
        lines = [pp.Line(w, 1.0, 0, i * 10, 1000, i * 10 + 9) for i, w in enumerate(ordered)]
    ext = pp.extract(lines)
    best = ext.best
    return {
        "id": gid, "file": Path(path).name, "engine": "vlm",
        "ocr_ms": round(ms, 1), "ms": round(ms, 1), "retries": 0,
        "lines": len(lines), "phrase": best.phrase if best else "", "words": len(best.words) if best else 0,
        "checksum": bool(best.checksum) if best else False,
        "confidence": round(best.confidence, 4) if best else 0,
        "order": best.order if best else "", "text": ext.text[:2000],
        "rejected": [r.reason for r in ext.rejected[:20]], "meta": {"model": "Qwen3-VL-8B"},
    }


def main() -> None:
    global MODEL_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(RESULTS / "vlm.jsonl"))
    ap.add_argument("--max-side", type=int, default=1600)
    ap.add_argument("--model", default="")
    args = ap.parse_args()
    if args.model:
        MODEL_NAME = args.model

    gt = json.loads((EVAL / "gt.json").read_text())["images"]
    if args.only:
        keep = set(args.only.split(","))
        gt = [g for g in gt if g["class"] in keep]
    if args.limit:
        gt = gt[: args.limit]
    tasks = [(args.url, g["id"], str(EVAL / "images" / g["file"]), args.max_side) for g in gt]

    t0 = time.perf_counter()
    with open(args.out, "w") as fh, ThreadPoolExecutor(max_workers=args.workers) as pool:
        for row in pool.map(_one, tasks):
            fh.write(json.dumps(row) + "\n")
    dt = time.perf_counter() - t0
    print(f"vlm: {len(tasks)} images in {dt:.1f}s ({dt/len(tasks):.3f}s/img wall, {args.workers} workers) -> {args.out}")


if __name__ == "__main__":
    main()
