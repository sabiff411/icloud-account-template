"""Run one engine over the eval set and write results/<engine>.jsonl."""
from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import postprocess as pp

HERE = Path(__file__).resolve().parent
EVAL = HERE / "eval"
RESULTS = HERE / "results"


def _variant(img, kind, tmpdir):
    """Write a transformed copy of the image and return its path."""
    from PIL import Image, ImageOps
    import numpy as np

    out = Path(tmpdir) / f"{kind}.png"
    if kind.startswith("rot"):
        deg = int(kind[3:])
        img.rotate(-deg, expand=True, fillcolor="white").save(out)
    elif kind == "upscale":
        g = ImageOps.autocontrast(ImageOps.grayscale(img))
        g = g.resize((int(g.width * 1.6), int(g.height * 1.6)), Image.LANCZOS)
        g.convert("RGB").save(out)
    elif kind == "threshold":
        import cv2
        g = np.array(ImageOps.grayscale(img))
        g = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                  cv2.THRESH_BINARY, 31, 15)
        Image.fromarray(g).convert("RGB").save(out)
    return str(out)


def _one(args):
    engine_name, gid, path, max_side, retry = args
    import tempfile

    import engines

    engines.configure_tesseract()
    fn = engines.ENGINES[engine_name]
    t0 = time.perf_counter()
    tries = 0
    td_ctx = tempfile.TemporaryDirectory()
    td = td_ctx.name
    src = path
    if retry:
        try:
            deg = engines.detect_orientation(path, max_side)
        except Exception:
            deg = 0
        if deg:
            img0 = engines.load_image(path, max_side)
            src = _variant(img0, f"rot{deg}", td)
            tries += 1
    res = fn(src, max_side=max_side)
    ext = pp.extract(res.lines)
    if retry and not (ext.best and ext.best.checksum) and ext.seed_like:
        img = engines.load_image(src, max_side)
        if True:
            for kind in ("rot90", "rot180", "rot270", "upscale", "threshold"):
                tries += 1
                vp = _variant(img, kind, td)
                try:
                    r2 = fn(vp, max_side=max_side)
                except Exception:
                    continue
                e2 = pp.extract(r2.lines)
                if e2.best and e2.best.checksum:
                    res, ext = r2, e2
                    break
                if e2.best and (not ext.best or e2.best.confidence > ext.best.confidence):
                    res, ext = r2, e2
    td_ctx.cleanup()
    t1 = time.perf_counter()
    best = ext.best
    return {
        "id": gid,
        "file": Path(path).name,
        "engine": engine_name,
        "ocr_ms": round((t1 - t0) * 1000, 2),
        "ms": round((t1 - t0) * 1000, 2),
        "retries": tries,
        "lines": len(res.lines),
        "phrase": best.phrase if best else "",
        "words": len(best.words) if best else 0,
        "checksum": bool(best.checksum) if best else False,
        "confidence": round(best.confidence, 4) if best else 0,
        "order": best.order if best else "",
        "text": ext.text[:2000],
        "rejected": [r.reason for r in ext.rejected[:20]],
        "meta": res.meta,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--procs", type=int, default=1)
    ap.add_argument("--max-side", type=int, default=2200)
    ap.add_argument("--only", default="", help="comma separated class filter")
    ap.add_argument("--out", default="")
    ap.add_argument("--retry", type=int, default=1)
    args = ap.parse_args()

    gt = json.loads((EVAL / "gt.json").read_text())["images"]
    if args.only:
        keep = set(args.only.split(","))
        gt = [g for g in gt if g["class"] in keep]
    if args.limit:
        gt = gt[: args.limit]

    tasks = [(args.engine, g["id"], str(EVAL / "images" / g["file"]), args.max_side, args.retry) for g in gt]
    RESULTS.mkdir(exist_ok=True)
    out = Path(args.out) if args.out else RESULTS / f"{args.engine}.jsonl"

    t0 = time.perf_counter()
    with out.open("w") as fh, ProcessPoolExecutor(max_workers=max(1, args.procs)) as pool:
        if args.procs <= 1:
            rows = map(_one, tasks)
        else:
            rows = pool.map(_one, tasks, chunksize=4)
        for row in rows:
            fh.write(json.dumps(row) + "\n")
    total = time.perf_counter() - t0
    print(f"{args.engine}: {len(tasks)} images in {total:.1f}s "
          f"({total / max(1, len(tasks)):.3f}s/img wall, {args.procs} procs) -> {out}")


if __name__ == "__main__":
    main()
