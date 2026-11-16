"""Engine adapters. Every adapter returns word/line boxes in image pixels.

`recognize(path)` includes decode + EXIF + downscale, matching the baseline's
per-image work, so latency numbers are comparable.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageOps

from postprocess import Line

# Optional: pillow_heif registers HEIC/AVIF openers
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass


@dataclass
class Result:
    lines: list[Line]
    meta: dict


def load_image(path: str | Path, max_side: int = 2200) -> Image.Image:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im) or im
        im = im.convert("RGB")
        if max_side:
            im.thumbnail((max_side, max_side))
        return im


def _quad_to_box(q) -> tuple[float, float, float, float]:
    xs = [float(p[0]) for p in q]
    ys = [float(p[1]) for p in q]
    return min(xs), min(ys), max(xs), max(ys)


# ---------------------------------------------------------------- RapidOCR

_rapid = {}


def _rapid_engine(threads: int = 1, en: bool = False, max_side: int = 2200):
    key = (threads, en)
    if key in _rapid:
        return _rapid[key]
    if en:
        from rapidocr import RapidOCR  # v2 package, downloads en models
        engine = RapidOCR(params={
            "Global.max_side_len": max_side,
            "Global.intra_op_num_threads": threads,
            "Global.inter_op_num_threads": 1,
            "Det.limit_side_len": 1600,
            "Det.box_thresh": 0.3,
            "Det.thresh": 0.3,
            "Rec.lang_type": "en",
        })
    else:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR(
            intra_op_num_threads=threads,
            inter_op_num_threads=1,
            det_limit_side_len=1600,
            det_box_thresh=0.5,
            global_max_side_len=max_side,
        )
    _rapid[key] = engine
    return engine


def rapidocr(path, max_side=2200, threads=1, en=False, use_cls=True) -> Result:
    img = load_image(path, max_side)
    engine = _rapid_engine(threads, en, max_side)
    out = engine(np.array(img), use_cls=use_cls) if not en else engine(np.array(img))
    if isinstance(out, tuple):  # 1.x returns (result, elapse)
        out = out[0]
    lines: list[Line] = []
    if hasattr(out, "boxes") and out.boxes is not None:      # v2 object
        texts = out.txts or []
        scores = out.scores or []
        for box, text, score in zip(out.boxes, texts, scores):
            x0, y0, x1, y1 = _quad_to_box(box)
            lines.append(Line(str(text), float(score), x0, y0, x1, y1))
    else:
        for item in out or []:
            if not item or len(item) < 3:
                continue
            box, text, score = item[0], item[1], item[2]
            x0, y0, x1, y1 = _quad_to_box(box)
            lines.append(Line(str(text), float(score), x0, y0, x1, y1))
    return Result(lines, {"engine": "rapidocr_en" if en else "rapidocr"})


# ---------------------------------------------------------------- PaddleOCR

_paddle = {}


def paddleocr_en(path, max_side=2200, use_cls=True) -> Result:
    from paddleocr import PaddleOCR
    if "en" not in _paddle:
        try:
            _paddle["en"] = PaddleOCR(lang="en", use_textline_orientation=use_cls,
                                      use_doc_orientation_classify=False,
                                      use_doc_unwarping=False)
        except TypeError:
            _paddle["en"] = PaddleOCR(lang="en", use_angle_cls=use_cls, show_log=False)
    ocr = _paddle["en"]
    img = load_image(path, max_side)
    arr = np.array(img)
    lines: list[Line] = []
    if hasattr(ocr, "predict"):
        res = ocr.predict(arr)
        for page in res or []:
            data = page if isinstance(page, dict) else getattr(page, "json", {})
            data = data.get("res", data) if isinstance(data, dict) else {}
            texts = data.get("rec_texts") or []
            scores = data.get("rec_scores") or []
            polys = data.get("rec_polys") or data.get("dt_polys") or []
            for box, text, score in zip(polys, texts, scores):
                x0, y0, x1, y1 = _quad_to_box(box)
                lines.append(Line(str(text), float(score), x0, y0, x1, y1))
    else:
        res = ocr.ocr(arr, cls=use_cls)
        page = res[0] if res and isinstance(res[0], list) else res
        for item in page or []:
            box, (text, score) = item[0], item[1]
            x0, y0, x1, y1 = _quad_to_box(box)
            lines.append(Line(str(text), float(score), x0, y0, x1, y1))
    return Result(lines, {"engine": "paddleocr_en"})


# ---------------------------------------------------------------- Tesseract

def deskew(img: Image.Image) -> Image.Image:
    try:
        import cv2
    except Exception:
        return img
    arr = np.array(img.convert("L"))
    inv = cv2.threshold(arr, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(inv > 0))
    if len(coords) < 50:
        return img
    angle = cv2.minAreaRect(coords.astype(np.float32))[-1]
    if angle > 45:
        angle -= 90
    if abs(angle) < 0.4 or abs(angle) > 15:
        return img
    return img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor="white")


def tesseract(path, max_side=2200, psm=6, skew=False) -> Result:
    import pytesseract
    from pytesseract import Output

    img = load_image(path, max_side)
    if skew:
        img = deskew(img)
    data = pytesseract.image_to_data(img, lang="eng", config=f"--psm {psm}",
                                     output_type=Output.DICT)
    lines: list[Line] = []
    n = len(data.get("text", []))
    for i in range(n):
        text = (data["text"][i] or "").strip()
        try:
            conf = float(data["conf"][i])
        except Exception:
            conf = -1
        if not text or conf < 0:
            continue
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        lines.append(Line(text, conf / 100.0, x, y, x + w, y + h))
    return Result(lines, {"engine": f"tesseract_psm{psm}", "skew": skew})


# ---------------------------------------------------------------- Tesseract CLI

def _tess_env():
    root = Path(__file__).resolve().parent / "tess" / "root"
    env = dict(os.environ)
    if root.exists():
        env["LD_LIBRARY_PATH"] = str(root / "usr" / "lib" / "x86_64-linux-gnu")
        env["TESSDATA_PREFIX"] = str(root / "usr" / "share" / "tesseract-ocr" / "5" / "tessdata")
        return str(root / "usr" / "bin" / "tesseract"), env
    return "tesseract", env


def tesseract_cli(path, max_side=2200, psm=6, skew=False) -> Result:
    """Tesseract 5 via its CLI + TSV output (no pytesseract dependency)."""
    import subprocess
    import tempfile

    img = load_image(path, max_side)
    if skew:
        img = deskew(img)
    exe, env = _tess_env()
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
        tmp = fh.name
    try:
        img.save(tmp)
        proc = subprocess.run([exe, tmp, "stdout", "-l", "eng", "--psm", str(psm), "tsv"],
                              capture_output=True, text=True, env=env, timeout=120)
        tv = proc.stdout.splitlines()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    lines: list[Line] = []
    header = True
    for row in tv:
        cols = row.split("\t")
        if header:
            header = False
            continue
        if len(cols) < 12 or cols[0] != "5":
            continue
        text = cols[11].strip()
        try:
            conf = float(cols[10])
        except ValueError:
            continue
        if not text or conf < 0:
            continue
        left, top, width, height = (int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9]))
        lines.append(Line(text, conf / 100.0, left, top, left + width, top + height))
    return Result(lines, {"engine": f"tesseract_cli_psm{psm}", "skew": skew})


def detect_orientation(path, max_side=2200) -> int:
    """Tesseract OSD rotate angle (0/90/180/270), 0 when unsure."""
    import subprocess
    import tempfile

    img = load_image(path, max_side)
    exe, env = _tess_env()
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
        tmp = fh.name
    try:
        img.save(tmp)
        out = subprocess.run([exe, tmp, "stdout", "--psm", "0"], capture_output=True,
                             text=True, env=env, timeout=60).stdout
    except Exception:
        return 0
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    conf = 0.0
    deg = 0
    for line in out.splitlines():
        if line.startswith("Rotate:"):
            try:
                deg = int(line.split(":")[1].strip())
            except ValueError:
                deg = 0
        elif line.startswith("Orientation confidence:"):
            try:
                conf = float(line.split(":")[1].strip())
            except ValueError:
                conf = 0.0
    return deg if conf >= 2.0 and deg in (90, 180, 270) else 0


# ---------------------------------------------------------------- EasyOCR

_easy = {}


def easyocr_en(path, max_side=2200, gpu=None) -> Result:
    import torch
    from easyocr import Reader

    if gpu is None:
        gpu = torch.cuda.is_available()
    key = bool(gpu)
    if key not in _easy:
        _easy[key] = Reader(["en"], gpu=key, verbose=False)
    reader = _easy[key]
    img = load_image(path, max_side)
    out = reader.readtext(np.array(img), detail=1, paragraph=False,
                          mag_ratio=1.0, canvas_size=max_side)
    lines = []
    for box, text, conf in out:
        x0, y0, x1, y1 = _quad_to_box(box)
        lines.append(Line(text, float(conf), x0, y0, x1, y1))
    return Result(lines, {"engine": "easyocr_en", "gpu": key})


# ---------------------------------------------------------------- docTR

_doctr = {}


def doctr_en(path, max_side=2200, gpu=None) -> Result:
    import torch
    from doctr.models import ocr_predictor

    if gpu is None:
        gpu = torch.cuda.is_available()
    key = bool(gpu)
    if key not in _doctr:
        model = ocr_predictor(pretrained=True, assume_straight_pages=False,
                               preserve_aspect_ratio=True)
        _doctr[key] = model.to("cuda" if key else "cpu")
    model = _doctr[key]
    img = load_image(path, max_side)
    arr = np.array(img).astype(np.float32) / 255.0
    h, w = arr.shape[:2]
    res = model([arr])
    lines = []
    for page in res.pages:
        for block in page.blocks:
            for line in block.lines:
                for word in line.words:
                    (ny0, nx0), (ny1, nx1) = word.geometry
                    lines.append(Line(word.value, float(word.confidence),
                                      nx0 * w, ny0 * h, nx1 * w, ny1 * h))
    return Result(lines, {"engine": "doctr_en", "gpu": key})


# ---------------------------------------------------------------- Surya

def surya_en(path, max_side=2200) -> Result:
    from PIL import Image as _Image
    from surya.recognition import RecognitionPredictor
    from surya.foundation import FoundationPredictor

    if "rec" not in _doctr:
        _doctr["rec"] = (FoundationPredictor(), RecognitionPredictor(FoundationPredictor()))
    found, rec = _doctr["rec"]
    img = load_image(path, max_side)
    preds = rec([img], task_names=["ocr_with_boxes"])
    lines = []
    for page in preds:
        for box, text, conf in zip(page.bboxes, page.text_lines, page.confidence):
            x0, y0, x1, y1 = box
            lines.append(Line(text, float(conf), x0, y0, x1, y1))
    return Result(lines, {"engine": "surya_en"})


ENGINES: dict[str, Callable[..., Result]] = {
    "rapidocr": lambda p, **k: rapidocr(p, en=False, **k),
    "rapidocr_en": lambda p, **k: rapidocr(p, en=True, **k),
    "paddle_en": paddleocr_en,
    "tesseract_psm6": lambda p, **k: tesseract(p, psm=6, **k),
    "tesseract_psm11": lambda p, **k: tesseract(p, psm=11, **k),
    "tesseract_psm6_deskew": lambda p, **k: tesseract_cli(p, psm=6, skew=True, **k),
    "tesseract_cli_psm6": lambda p, **k: tesseract_cli(p, psm=6, **k),
    "tesseract_cli_psm11": lambda p, **k: tesseract_cli(p, psm=11, **k),
    "easyocr": easyocr_en,
    "doctr": doctr_en,
    "surya": surya_en,
}


def configure_tesseract():
    """Point pytesseract at the locally extracted Tesseract 5 build."""
    root = Path(__file__).resolve().parent / "tess" / "root"
    exe = root / "usr" / "bin" / "tesseract"
    if exe.exists():
        os.environ.setdefault("LD_LIBRARY_PATH", str(root / "usr" / "lib" / "x86_64-linux-gnu"))
        os.environ.setdefault("TESSDATA_PREFIX", str(root / "usr" / "share" / "tesseract-ocr" / "5" / "tessdata"))
        try:
            import pytesseract
            pytesseract.pytesseract.tesseract_cmd = str(exe)
        except Exception:
            pass
        return str(exe)
    return "system"
