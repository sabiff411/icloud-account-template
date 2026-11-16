"""Build the labelled OCR/BIP39 evaluation set.

Outputs bench/ocr/eval/images/* and bench/ocr/eval/gt.json.

Classes:
  printed_clean    printed seed list, flat scan, 1-4 columns
  printed_photo    same on paper: perspective, shadow, low light, blur, jpeg
  screenshot       wallet/restore UI chrome
  rotated          +-90 / 180 and 1-4 deg skew
  lowres           downscaled + heavy jpeg
  heic_avif        HEIC / AVIF encodes
  near_miss        valid-looking list with one corrupted word (checksum fails)
  negative_synth   receipts, menus, book pages, chats
  negative_real    real corpus photos without seed words
  positive_real    real wallet screenshots from export/
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
PROJ = ROOT.parent.parent
WORDLIST = PROJ / "python" / "worker" / "data" / "bip39_english.txt"
EXPORT = PROJ / "export"
OUT = ROOT / "eval"
IMAGES = OUT / "images"

WORDS = [w.strip() for w in WORDLIST.read_text(encoding="utf-8").split()]
assert len(WORDS) == 2048
INDEX = {w: i for i, w in enumerate(WORDS)}

FONTS = {
    "serif": "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "serif_bold": "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "sans": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "sans_bold": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
}
FONT_CHOICES = ["serif", "sans", "mono", "serif_bold"]

rng = random.Random(20261112)


# ---------------------------------------------------------------- BIP39

def mnemonic(n_words: int) -> list[str]:
    """Checksum-valid mnemonic from OS entropy."""
    ent_bits = n_words * 11 * 32 // 33          # 128 / 160 / 192 / 224 / 256
    ent = os.urandom(ent_bits // 8)
    h = hashlib.sha256(ent).digest()
    bits = bin(int.from_bytes(ent, "big"))[2:].zfill(ent_bits)
    bits += bin(int.from_bytes(h, "big"))[2:].zfill(256)[: ent_bits // 32]
    return [WORDS[int(bits[i:i + 11], 2)] for i in range(0, len(bits), 11)]


def checksum_ok(words: list[str]) -> bool:
    n = len(words)
    if n not in (12, 15, 18, 21, 24) or any(w not in INDEX for w in words):
        return False
    bits = "".join(format(INDEX[w], "011b") for w in words)
    cs = n // 3
    ent, got = bits[:-cs], bits[-cs:]
    h = hashlib.sha256(int(ent, 2).to_bytes(len(ent) // 8, "big")).digest()
    want = "".join(format(b, "08b") for b in h)[:cs]
    return got == want


# ---------------------------------------------------------------- drawing

def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONTS[name], size)


def seed_canvas(phrase: list[str], columns: int, per_line: int,
                fname: str, fsize: int, numbered: bool) -> tuple[Image.Image, str]:
    """Draw a printed seed list.

    columns == 1: a paragraph of `per_line` words per line (reading order ==
    phrase order).  columns >= 2: a grid with one word per cell, filled
    column-major, so the row-major reading order is the interleaved order and
    the phrase order runs down each column.
    """
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    f = font(fname, fsize)
    nf = font(fname, max(14, int(fsize * 0.55)))
    num_w = int(nf.getlength("00") + 12) if numbered else 0
    slot_w = int(max(probe.textlength(w, font=f) for w in phrase)) + num_w + 26
    line_h = int(fsize * 1.9)
    n = len(phrase)
    margin = 60
    cells: dict[tuple[int, int], tuple[int, str]] = {}

    if columns == 1:
        ncols = per_line
        rows = (n + per_line - 1) // per_line
        for i, word in enumerate(phrase):
            cells[(i // per_line, i % per_line)] = (i + 1, word)
    else:
        ncols = columns
        per_col = (n + columns - 1) // columns
        rows = per_col
        for ci in range(columns):
            chunk = phrase[ci * per_col:(ci + 1) * per_col]
            for li, word in enumerate(chunk):
                cells[(li, ci)] = (ci * per_col + li + 1, word)

    width = 2 * margin + ncols * slot_w
    height = 2 * margin + 80 + rows * line_h
    img = Image.new("RGB", (width, height), "#ffffff")
    d = ImageDraw.Draw(img)
    for (r, c), (num, word) in sorted(cells.items()):
        x = margin + c * slot_w
        y = margin + 80 + r * line_h
        if numbered:
            d.text((x, y), f"{num:02d}", font=nf, fill="#9a9a9a")
            d.text((x + num_w, y), word, font=f, fill="#1a1a1a")
        else:
            d.text((x, y), word, font=f, fill="#1a1a1a")

    visual = []
    for r in range(rows):
        for c in range(ncols):
            if (r, c) in cells:
                visual.append(cells[(r, c)][1])
    return img, " ".join(visual)


def screenshot(phrase: list[str], columns: int, dark: bool) -> tuple[Image.Image, str]:
    w = 900
    per_col = (len(phrase) + columns - 1) // columns
    cell_h = 48
    h = max(480, 110 + per_col * cell_h + 110)
    bg = "#0d1020" if dark else "#eef0f5"
    fg = "#f2f4ff" if dark else "#111318"
    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)
    d.text((w // 2, 34), f"Type your {len(phrase)}-Word Phrase", font=font("sans_bold", 26),
           fill=fg, anchor="mm")
    cell_w = (w - 120) // columns
    x0, y0 = 60, 100
    chunks = [phrase[ci * per_col:(ci + 1) * per_col] for ci in range(columns)]
    for ci, chunk in enumerate(chunks):
        for j, word in enumerate(chunk):
            x, y = x0 + ci * cell_w, y0 + j * cell_h
            d.line([(x + 6, y + 40), (x + cell_w - 18, y + 40)],
                   fill="#5b6180" if dark else "#8b90a8", width=2)
            d.text((x + 8, y + 10), word, font=font("sans", 20), fill=fg)
    visual = []
    for j in range(per_col):
        for chunk in chunks:
            if j < len(chunk):
                visual.append(chunk[j])
    d.text((w // 2, h - 40), "Continue", font=font("sans_bold", 20),
           fill="#7c5cff" if dark else "#3b82f6", anchor="mm")
    return img, " ".join(visual)


def receipt() -> tuple[Image.Image, str]:
    w, h = 620, 1000
    img = Image.new("RGB", (w, h), "#fbfaf5")
    d = ImageDraw.Draw(img)
    f, fb = font("mono", 19), font("mono", 22)
    d.text((w // 2, 40), "CORNER MARKET", font=fb, fill="#222", anchor="mm")
    d.text((w // 2, 70), "123 Main St  -  (555) 0142", font=font("mono", 15), fill="#555", anchor="mm")
    d.line([(40, 92), (w - 40, 92)], fill="#999", width=1)
    items = [("Milk 2%", 3.49), ("Sourdough", 5.25), ("Eggs 12ct", 4.99), ("Coffee 1lb", 11.80),
             ("Bananas", 2.10), ("Cheddar", 6.75), ("Tomatoes", 3.20), ("Pasta", 1.89),
             ("Olive oil", 8.45), ("Paper towels", 7.99)]
    y = 110
    lines = []
    for name, price in items:
        d.text((44, y), name, font=f, fill="#222")
        d.text((w - 44, y), f"{price:6.2f}", font=f, fill="#222", anchor="ra")
        lines.append(f"{name} {price:.2f}")
        y += 34
    y += 8
    d.line([(40, y), (w - 40, y)], fill="#999", width=1); y += 18
    for label, val in [("SUBTOTAL", 56.91), ("TAX", 4.55), ("TOTAL", 61.46)]:
        d.text((44, y), label, font=fb, fill="#111")
        d.text((w - 44, y), f"{val:6.2f}", font=fb, fill="#111", anchor="ra")
        lines.append(f"{label} {val:.2f}")
        y += 34
    d.text((w // 2, h - 60), "THANK YOU", font=f, fill="#555", anchor="mm")
    return img, " ".join(lines)


def menu() -> tuple[Image.Image, str]:
    w, h = 760, 980
    img = Image.new("RGB", (w, h), "#fffdf7")
    d = ImageDraw.Draw(img)
    d.text((w // 2, 60), "TRATTORIA", font=font("serif_bold", 38), fill="#2b2118", anchor="mm")
    d.text((w // 2, 100), "cucina  ·  vino", font=font("serif", 20), fill="#7a6a58", anchor="mm")
    dishes = [("Bruschetta", 8), ("Caprese", 11), ("Tagliatelle", 16), ("Risotto fungi", 18),
              ("Pizza margherita", 14), ("Sea bass", 24), ("Tiramisu", 9), ("Panna cotta", 8)]
    y = 170
    lines = []
    for name, price in dishes:
        d.text((70, y), name, font=font("serif", 24), fill="#2b2118")
        d.text((w - 70, y), f"${price}", font=font("serif", 24), fill="#2b2118", anchor="ra")
        d.line([(70, y + 34), (w - 70, y + 34)], fill="#e2d8c8", width=1)
        lines.append(f"{name} {price}")
        y += 92
    return img, " ".join(lines)


def book_page() -> tuple[Image.Image, str]:
    w, h = 820, 1080
    img = Image.new("RGB", (w, h), "#f6f1e7")
    d = ImageDraw.Draw(img)
    f = font("serif", 21)
    words = ("the old house stood at the end of the lane where the road turned to gravel "
             "and the hedges grew tall in summer she remembered the sound of the gate and "
             "the way the light came through the kitchen window in the morning before "
             "anyone else was awake it was a place of small rituals and long silences").split()
    y, line, lines = 110, [], []
    for word in words * 3:
        if d.textlength(" ".join(line + [word]), font=f) > w - 160:
            d.text((80, y), " ".join(line), font=f, fill="#2a2620")
            lines.append(" ".join(line)); y += 34; line = [word]
        else:
            line.append(word)
    if line:
        d.text((80, y), " ".join(line), font=f, fill="#2a2620"); lines.append(" ".join(line))
    d.text((w // 2, 60), "Chapter Four", font=font("serif_bold", 24), fill="#2a2620", anchor="mm")
    return img, " ".join(lines)


def chat() -> tuple[Image.Image, str]:
    w, h = 720, 900
    img = Image.new("RGB", (w, h), "#e9edf2")
    d = ImageDraw.Draw(img)
    f = font("sans", 18)
    msgs = [("them", "are we still on for tonight?"), ("me", "yes, around 7"),
            ("them", "perfect, I'll bring the tickets"), ("me", "see you there"),
            ("them", "did you get the email about the invoice?"), ("me", "checking now")]
    y, lines = 90, []
    for who, text in msgs:
        bw = min(430, int(d.textlength(text, font=f)) + 44)
        x = 40 if who == "them" else w - 40 - bw
        fill = "#ffffff" if who == "them" else "#3b82f6"
        col = "#111" if who == "them" else "#fff"
        d.rounded_rectangle([x, y, x + bw, y + 54], radius=16, fill=fill)
        d.text((x + 20, y + 16), text, font=f, fill=col)
        lines.append(text)
        y += 82
    return img, " ".join(lines)


# ---------------------------------------------------------------- transforms

def paperize(img: Image.Image, shadow: float, bright: float, blur: float) -> Image.Image:
    w, h = img.size
    bg = Image.new("RGB", (w, h), "#e8dcc6")
    d = ImageDraw.Draw(bg)
    for _ in range(4000):
        x, y = rng.randrange(w), rng.randrange(h)
        v = rng.randrange(-12, 12)
        d.point((x, y), fill=(232 + v, 220 + v, 198 + v))
    bg.paste(img, (0, 0))
    # perspective: squeeze the top edge and shift it right
    dx = rng.randint(20, 70); dy = rng.randint(10, 40)
    # PIL QUAD order: upper-left, lower-left, lower-right, upper-right
    quad = (dx, dy, 0, h, w - dx, h - dy, w - dx // 2, 0)
    img = bg.transform((w, h), Image.QUAD, quad, resample=Image.BICUBIC, fillcolor="#e8dcc6")
    # shadow gradient
    grad = Image.new("L", (1, h))
    for y in range(h):
        grad.putpixel((0, y), int(255 * (1 - shadow * (y / h))))
    grad = grad.resize((w, h))
    img = Image.composite(img, Image.new("RGB", (w, h), "#000000"), grad)
    img = Image.eval(img, lambda p: min(255, int(p * bright)))
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    return img


def add_skew(img: Image.Image, deg: float) -> Image.Image:
    return img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor="#e8dcc6")


# ---------------------------------------------------------------- real data

def ocr_to_image(p: Path) -> Path:
    s = str(p).replace("/Scan/ocr/", "/")
    if s.endswith(".txt"):
        s = s[:-4]
    return Path(s)


def real_positives() -> list[dict]:
    """Real screenshots whose OCR already contains a checksum-valid window."""
    found = []
    for p in EXPORT.glob("*/Scan/ocr/**/*.txt"):
        try:
            toks = [t.strip(".,;:()[]{}").lower() for t in p.read_text(errors="ignore").split()]
        except Exception:
            continue
        for start in range(len(toks)):
            for n in (24, 21, 18, 15, 12):
                win = toks[start:start + n]
                if len(win) == n and checksum_ok(win):
                    img = ocr_to_image(p)
                    if img.exists():
                        found.append({"src": img, "phrase": " ".join(win), "n": n})
                    break
    # dedupe by file
    seen, out = set(), []
    for f in found:
        if str(f["src"]) in seen:
            continue
        seen.add(str(f["src"]))
        out.append(f)
    return out


def real_negatives(limit: int) -> list[Path]:
    """Corpus images whose OCR has no run of 3+ BIP39 words."""
    out = []
    for p in EXPORT.glob("*/Scan/ocr/**/*.txt"):
        try:
            toks = [t.strip(".,;:").lower() for t in p.read_text(errors="ignore").split()]
        except Exception:
            continue
        run = 0
        for t in toks:
            run = run + 1 if t in INDEX else 0
            if run >= 3:
                break
        if run >= 3:
            continue
        img = ocr_to_image(p)
        if img.exists() and img.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic"}:
            out.append(img)
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- build

def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    IMAGES.mkdir(parents=True)

    gt = []
    counter = 0

    def add(img: Image.Image, cls: str, phrase: str, transcript: str, n: int,
            cols: int, valid: bool, fmt: str = "png", quality: int | None = None,
            src: Path | None = None) -> None:
        nonlocal counter
        counter += 1
        iid = f"{counter:04d}_{cls}"
        path = IMAGES / f"{iid}.{fmt}"
        if fmt in ("jpg", "jpeg"):
            img.convert("RGB").save(path, "JPEG", quality=quality or 88)
        else:
            fmt_name = {"heic": "HEIF", "avif": "AVIF", "png": "PNG"}.get(fmt, fmt.upper())
            img.save(path, fmt_name)
        gt.append({
            "id": iid, "file": path.name, "class": cls,
            "word_count": n, "columns": cols,
            "phrase": phrase, "transcript": transcript, "transcript_col": phrase,
            "checksum_valid": valid, "source": str(src) if src else "synthetic",
        })

    # 1-2. printed clean + photographed paper, every count x columns
    for cls in ("printed_clean", "printed_photo"):
        for n in (12, 15, 18, 21, 24):
            for cols in (1, 2, 3, 4):
                reps = 5 if cls == "printed_clean" else 4
                for r in range(reps):
                    phrase = mnemonic(n)
                    fname = rng.choice(FONT_CHOICES)
                    fsize = rng.choice([30, 34, 38, 42])
                    per_line = 3 if n % cols == 0 and n // cols % 3 == 0 else 4
                    per_line = 3 if r % 2 == 0 else 4
                    img, transcript = seed_canvas(phrase, cols, per_line, fname, fsize, bool(r % 3))
                    if cls == "printed_clean":
                        add(img, cls, " ".join(phrase), transcript, n, cols, True,
                            quality=90, fmt="jpg")
                    else:
                        img = paperize(img, shadow=rng.uniform(.15, .55), bright=rng.uniform(.55, .95),
                                       blur=rng.choice([0, 0, .6, 1.1]))
                        if r % 3 == 1:
                            img = add_skew(img, rng.uniform(1, 3.5))
                        add(img, cls, " ".join(phrase), transcript, n, cols, True,
                            quality=rng.choice([45, 60, 75]), fmt="jpg")

    # 3. screenshots
    for n in (12, 15, 18, 21, 24):
        for cols in (1, 2, 3):
            for r in range(4):
                phrase = mnemonic(n)
                img, transcript = screenshot(phrase, cols, dark=bool(r % 2))
                add(img, "screenshot", " ".join(phrase), transcript, n, cols, True)

    # 4. rotated / skew
    for n in (12, 18, 24):
        for r in range(10):
            phrase = mnemonic(n)
            cols = rng.choice([1, 2, 3])
            img, transcript = seed_canvas(phrase, cols, 4, rng.choice(FONT_CHOICES), 36, bool(r % 2))
            deg = rng.choice([90, 180, 270, 1, 2, 3, -1, -2, -3])
            out = img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor="#ffffff")
            add(out, "rotated", " ".join(phrase), transcript, n, cols, True, quality=85, fmt="jpg")

    # 5. lowres
    for n in (12, 24):
        for r in range(15):
            phrase = mnemonic(n)
            cols = rng.choice([1, 2])
            img, transcript = seed_canvas(phrase, cols, 4, rng.choice(FONT_CHOICES), 34, False)
            w = rng.choice([640, 720, 800])
            img = img.resize((w, int(img.height * w / img.width)), Image.LANCZOS)
            add(img, "lowres", " ".join(phrase), transcript, n, cols, True,
                quality=rng.choice([30, 40, 50]), fmt="jpg")

    # 6. HEIC / AVIF
    try:
        import pillow_heif  # noqa: F401
        heif_ok = True
    except Exception:
        heif_ok = False
    for n in (12, 24):
        for r in range(8):
            phrase = mnemonic(n)
            cols = rng.choice([1, 2])
            img, transcript = seed_canvas(phrase, cols, 4, "sans", 36, False)
            add(img, "heic_avif", " ".join(phrase), transcript, n, cols, True,
                fmt="heic" if heif_ok else "jpg", quality=80)
    for n in (12, 24):
        for r in range(7):
            phrase = mnemonic(n)
            img, transcript = seed_canvas(phrase, 1, 4, "serif", 36, False)
            add(img, "heic_avif", " ".join(phrase), transcript, n, 1, True, fmt="avif", quality=80)

    # 7. near misses: one word replaced by a similar non-word / other word
    for r in range(30):
        n = rng.choice([12, 24])
        phrase = mnemonic(n)
        i = rng.randrange(n)
        bad = list(phrase)
        if r % 2:
            bad[i] = WORDS[(INDEX[phrase[i]] + 1) % 2048]   # real word, wrong checksum
        else:
            bad[i] = phrase[i][:-1] + "q"                    # not a BIP39 word
        img, transcript = seed_canvas(bad, 1, 4, "serif", 36, False)
        add(img, "near_miss", " ".join(bad), transcript, n, 1, False, quality=88, fmt="jpg")

    # 8. synthetic negatives
    for r in range(24):
        img, t = receipt(); add(img, "negative_synth", "", t, 0, 0, False,
                                 quality=80, fmt="jpg")
    for r in range(22):
        img, t = menu(); add(img, "negative_synth", "", t, 0, 0, False,
                             quality=82, fmt="jpg")
    for r in range(22):
        img, t = book_page(); add(img, "negative_synth", "", t, 0, 0, False,
                                  quality=80, fmt="jpg")
    for r in range(22):
        img, t = chat(); add(img, "negative_synth", "", t, 0, 0, False,
                             quality=82, fmt="jpg")

    # 9. real negatives
    for src in real_negatives(50):
        try:
            with Image.open(src) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((1600, 1600))
                add(im, "negative_real", "", "", 0, 0, False, quality=85, fmt="jpg", src=src)
        except Exception:
            continue

    # 10. real positives
    for rp in real_positives():
        try:
            with Image.open(rp["src"]) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                add(im, "positive_real", rp["phrase"], rp["phrase"], rp["n"], 0, True,
                    quality=90, fmt="jpg", src=rp["src"])
        except Exception:
            continue

    # 11. explicit real wallet screens known from the corpus
    extra = [
        ("export/charles22927@icloud.com/Photos/Library/D894B39C_IMG_0010.PNG",
         "above daring venue artist youth since destroy traffic genuine above shop fly "
         "volcano normal twin plunge tube bus grief present picnic gauge dash cinnamon",
         24, "positive_real", False),
        ("export/charles22927@icloud.com/Photos/Library/988FBEE5_IMG_0007.WEBP",
         "arena dove edge eight false famous fly glue know mouse ostrich taste",
         12, "near_miss_real", False),
    ]
    for rel, phrase, n, cls, valid in extra:
        src = PROJ / rel
        if not src.exists():
            continue
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            add(im, cls, phrase, phrase, n, 0, valid, quality=92, fmt="jpg", src=src)

    (OUT / "gt.json").write_text(json.dumps({
        "generated": "2026-11-12",
        "note": "phrase = true order; transcript = visual row-major order",
        "images": gt,
    }, indent=1), encoding="utf-8")

    from collections import Counter
    c = Counter(g["class"] for g in gt)
    print("images:", len(gt))
    for k, v in sorted(c.items()):
        print(f"  {k:16s} {v}")


if __name__ == "__main__":
    main()
