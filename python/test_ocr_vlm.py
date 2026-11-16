#!/usr/bin/env python3
"""Acceptance test for ocr_vlm: render known phrases, read them back."""
from __future__ import annotations

import hashlib
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker.ocr_vlm import checksum_ok, extract  # noqa: E402

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

WORDLIST = Path(__file__).parent / "worker" / "data" / "bip39_english.txt"
WORDS = [w.strip() for w in WORDLIST.read_text().splitlines() if w.strip()]
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def phrase(count: int = 12) -> list[str]:
    rng = random.Random(7 + count)
    for _ in range(10_000):
        candidate = [rng.choice(WORDS) for _ in range(count)]
        if checksum_ok(candidate):
            return candidate
    raise SystemExit("no valid phrase found")


def render(path: Path, text_lines: list[str], columns: int = 1, numbered: bool = False) -> None:
    font = ImageFont.truetype(FONT, 34)
    width, height = (900 if columns == 1 else 1500), 900
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    if numbered:
        # two columns of "<n> <word>"
        per_column = (len(text_lines) + 1) // 2
        for i, word in enumerate(text_lines):
            column = i // per_column
            row = i % per_column
            draw.text((40 + column * 420, 30 + row * 55), f"{i + 1} {word}", fill="black", font=font)
    else:
        for i, word in enumerate(text_lines):
            draw.text((40, 30 + i * 55), word, fill="black", font=font)
    image.save(path)


def main() -> None:
    out = Path("/tmp/vlm-test")
    out.mkdir(exist_ok=True)
    tests = []
    p = phrase(12)
    n = " ".join(p)

    a = out / "numbered-2col.jpg"
    render(a, p, numbered=True)
    tests.append(("numbered 2-col", a, p))

    b = out / "single-column.jpg"
    render(b, p)
    tests.append(("1-col list", b, p))

    c = out / "three-columns.jpg"
    render(c, p, columns=3)
    tests.append(("3 columns", c, p))

    for name, path, expected in tests:
        result = extract(path)
        ok = result["words"] == expected
        print(
            json.dumps(
                {
                    "case": name,
                    "exact": ok,
                    "checksum": result["checksum"],
                    "order": result["order"],
                    "count": result["count"],
                    "seconds": result["seconds"],
                    "reason": result["reason"],
                    "phrase": result["phrase"],
                },
                ensure_ascii=False,
            )
        )
        if not ok:
            print("  expected:", n)
            print("  raw:", result["raw"].replace("\n", " | ")[:400])


if __name__ == "__main__":
    main()
