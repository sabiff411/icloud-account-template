"""Phrase-aware post-processing: boxes -> reading order -> BIP39 phrase.

Shared by the benchmark and by python/worker/scan.py, so it must stay free of
heavy imports (Pillow/OpenCV only where the caller already has them).
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

_HERE = Path(__file__).resolve().parent
WORDLIST = _HERE.parents[1] / "python" / "worker" / "data" / "bip39_english.txt"

COUNTS = (24, 21, 18, 15, 12)
TIER = {3: "low", 5: "minimum", 8: "medium", 12: "high"}

# Common OCR confusions, applied only after an exact match fails.
_CONFUSION = str.maketrans({
    "0": "o", "1": "l", "5": "s", "8": "b", "|": "l", "!": "l",
    "€": "e", "©": "o", "®": "o",
})

_NORM = re.compile(r"[^a-z]+")


@dataclass
class Line:
    text: str
    conf: float = 1.0
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class Token:
    raw: str
    word: str | None
    score: float
    dist: int


@dataclass
class Phrase:
    phrase: str
    words: list[str]
    checksum: bool
    confidence: float
    order: str
    columns: int = 1
    start: int = 0


@dataclass
class Rejected:
    phrase: str
    reason: str
    confidence: float = 0.0
    count: int = 0


@dataclass
class Extraction:
    text: str
    phrases: list[Phrase] = field(default_factory=list)
    rejected: list[Rejected] = field(default_factory=list)
    matched: int = 0
    total: int = 0
    max_run: int = 0

    @property
    def density(self) -> float:
        return self.matched / self.total if self.total else 0.0

    @property
    def seed_like(self) -> bool:
        """Cheap evidence that this image may contain a seed list."""
        return self.max_run >= 6 or (self.matched >= 8 and self.density >= 0.5)

    @property
    def best(self) -> Phrase | None:
        if not self.phrases:
            return None
        return sorted(self.phrases, key=lambda p: (p.checksum, p.confidence, len(p.words)))[-1]


def load_words(path: Path | str = WORDLIST) -> list[str]:
    words = Path(path).read_text(encoding="utf-8").split()
    if len(words) != 2048:
        raise RuntimeError(f"bip39 wordlist has {len(words)} words")
    return words


WORDS = load_words()
WORDSET = set(WORDS)


# ---------------------------------------------------------------- checksum

def _bits_to_bytes(bits: str) -> bytes:
    return int(bits, 2).to_bytes(len(bits) // 8, "big")


def checksum_ok(words: list[str], index: dict[str, int] | None = None) -> bool:
    n = len(words)
    if n not in COUNTS:
        return False
    index = index or {w: i for i, w in enumerate(WORDS)}
    if any(w not in index for w in words):
        return False
    bits = "".join(format(index[w], "011b") for w in words)
    cs = n // 3
    ent, got = bits[:-cs], bits[-cs:]
    digest = hashlib.sha256(_bits_to_bytes(ent)).digest()
    want = "".join(format(b, "08b") for b in digest)[:cs]
    return got == want


# ---------------------------------------------------------------- normalise / fuzzy

def norm(token: str) -> str:
    t = unicodedata.normalize("NFKC", token).lower()
    t = t.replace("’", "'").replace("‘", "'")
    t = _NORM.sub("", t)
    return t


try:  # C implementation; the pure-python fallback below is only for the worker
    from rapidfuzz.distance import Levenshtein as _RFLev

    def _lev(a: str, b: str) -> int:
        return _RFLev.distance(a, b)
except Exception:  # pragma: no cover
    def _lev(a: str, b: str) -> int:
        return _lev_py(a, b)


def _lev_py(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def match_token(raw: str) -> Token:
    t = norm(raw)
    if not t:
        return Token(raw, None, 0.0, 99)
    if t in WORDSET:
        return Token(raw, t, 1.0, 0)
    if len(t) < 3:
        return Token(raw, None, 0.0, 99)
    alt = t.translate(_CONFUSION)
    if alt in WORDSET:
        return Token(raw, alt, 0.92, 0)
    # Short words are only repaired at distance 1 and only when long enough
    # that the repair is unambiguous ("your" -> "hour" must NOT happen).
    if len(t) >= 8:
        max_d = 2
    elif len(t) >= 5:
        max_d = 1
    else:
        max_d = 0
    if max_d == 0:
        return Token(raw, None, 0.0, 99)
    best, best_d = None, 99
    for w in WORDS:
        if abs(len(w) - len(t)) > max_d:
            continue
        d = _lev(t, w)
        if d < best_d:
            best, best_d = w, d
            if d == 1 and len(t) >= 8:
                break
    if best is not None and best_d <= max_d:
        score = 1.0 if best_d == 0 else (0.88 if best_d == 1 else 0.78)
        return Token(raw, best, score, best_d)
    return Token(raw, None, 0.0, 99)


# ---------------------------------------------------------------- reading order

def _group_rows(lines: list[Line], tol: float | None = None) -> list[list[Line]]:
    if not lines:
        return []
    heights = sorted(max(1.0, l.y1 - l.y0) for l in lines)
    med = heights[len(heights) // 2]
    tol = tol or max(8.0, med * 0.6)
    rows: list[list[Line]] = []
    for line in sorted(lines, key=lambda l: (l.cy, l.x0)):
        if rows and abs(line.cy - sum(x.cy for x in rows[-1]) / len(rows[-1])) <= tol:
            rows[-1].append(line)
        else:
            rows.append([line])
    for row in rows:
        row.sort(key=lambda l: l.x0)
    return rows


def order_row_major(lines: list[Line]) -> str:
    return "\n".join(" ".join(l.text for l in row) for row in _group_rows(lines))


def _columns(lines: list[Line]) -> list[list[Line]]:
    """Cluster boxes into columns by their left edge.

    A grid column is left-aligned, so its boxes share an x0 cluster while
    different columns are separated by a gutter wider than normal word
    spacing.  Using x0 (not word width) keeps a wide word from swallowing the
    gutter of the next column.
    """
    if not lines:
        return []
    widths = sorted(max(1.0, l.x1 - l.x0) for l in lines)
    med_w = widths[len(widths) // 2]
    tol = max(18.0, med_w * 0.35)
    starts = sorted(l.x0 for l in lines)
    centers: list[float] = [starts[0]]
    for x in starts[1:]:
        if x - centers[-1] > tol:
            centers.append(x)
        else:
            centers[-1] = (centers[-1] + x) / 2
    cols: list[list[Line]] = [[] for _ in centers]
    for line in lines:
        k = min(range(len(centers)), key=lambda i: abs(line.x0 - centers[i]))
        cols[k].append(line)
    for c in cols:
        c.sort(key=lambda l: (l.cy, l.x0))
    return [c for c in cols if c]


def order_column_major(lines: list[Line]) -> tuple[str, int]:
    cols = _columns(lines)
    # Drop chrome columns (headings, buttons): a seed column holds many
    # BIP39 words, a centred heading sits in its own 1-3 word cluster.
    def seedish(col: list[Line]) -> int:
        return sum(1 for l in col for t in l.text.split() if norm(t) in WORDSET)

    kept = [c for c in cols if seedish(c) >= 3] or cols
    text = "\n".join(" ".join(l.text for l in c) for c in kept)
    return text, len(kept)


_PAIR = re.compile(r"^\s*(\d{1,3})\s*[\.\):\-]?\s+([A-Za-z]+)\s*$")


def numbered_words(text: str) -> list[str] | None:
    """Return words sorted by their printed number, or None if unnumbered.

    This is the layout-independent answer: the wallet's numbers ARE the phrase
    order, so a grid read in any visual order still reconstructs correctly.
    """
    pairs = []
    for line in text.splitlines():
        m = _PAIR.match(line)
        if m:
            pairs.append((int(m.group(1)), m.group(2).lower()))
    if len(pairs) < 12:
        return None
    uniq: dict[int, str] = {}
    for n, w in sorted(pairs):
        uniq.setdefault(n, w)
    if min(uniq) > 2:
        return None
    return [uniq[k] for k in sorted(uniq)]


def resolve_grid(words: list[str], columns: int | None) -> tuple[list[str], str]:
    """Pick the word order that validates, preferring the reported layout.

    The model reads in some visual order and may miscount the columns; the
    checksum is the arbiter.  Returns (words, order_label).
    """
    variants = dict(grid_variants(words))
    ordered: list[tuple[str, list[str]]] = [("row", words)]
    # Only the layout the model actually reported, plus the raw read. Trying
    # every column count multiplies the chance a random permutation checksums.
    if columns and columns > 1 and f"grid{columns}" in variants:
        ordered.insert(0, (f"grid{columns}", variants[f"grid{columns}"]))
    for label, candidate in ordered:
        if len(candidate) in COUNTS and checksum_ok(candidate):
            return candidate, label
    return words, "row"


# ---------------------------------------------------------------- extraction

_DIGITS = re.compile(r"[0-9]{1,2}[.)]?")


def _is_noise(tok: Token) -> bool:
    """Numbers, bullets and 1-2 letter junk that sit between seed words."""
    if tok.word:
        return False
    raw = tok.raw.strip()
    if not raw or _DIGITS.fullmatch(raw):
        return True
    return len(norm(raw)) <= 2


def _runs(tokens: list[Token]) -> list[list[Token]]:
    """Group matched words into runs, bridging a little OCR noise.

    One unmatched word (a heading token that fell between two columns, a
    stray bullet) must not cut a seed in half; two are tolerated only when
    they are pure noise (numbers, punctuation).
    """
    runs: list[list[Token]] = []
    cur: list[Token] = []
    gap = 0
    for tok in tokens:
        if tok.word:
            cur.append(tok)
            gap = 0
            continue
        if not cur:
            continue
        gap += 1
        if gap <= (2 if _is_noise(tok) else 1):
            continue
        runs.append(cur)
        cur = []
        gap = 0
    if cur:
        runs.append(cur)
    return runs


def grid_variants(words: list[str]) -> list[tuple[str, list[str]]]:
    """Re-read a row-major word sequence as columns (2..6 columns).

    A printed grid read left-to-right across rows yields the interleaved
    order; the seed order runs down each column.  Trying the small number of
    column counts is cheaper and more reliable than guessing from boxes.
    """
    n = len(words)
    out = []
    for cols in range(2, 7):
        rows = (n + cols - 1) // cols
        if rows < 2:
            continue
        # uneven grids: the first `full` columns hold one extra word
        full = n - cols * (rows - 1)
        lens = [rows if c < full else rows - 1 for c in range(cols)]
        if min(lens) < 1:
            continue
        idx, pos = {}, 0
        for r in range(rows):
            for c in range(cols):
                if r < lens[c]:
                    idx[(r, c)] = pos
                    pos += 1
        if pos != n:
            continue
        variant = [words[idx[(r, c)]] for c in range(cols) for r in range(lens[c])]
        if variant != words:
            out.append((f"grid{cols}", variant))
    return out


def find_phrases(text: str, order: str = "row", min_conf: float = 0.75) -> tuple[list[Phrase], list[Rejected]]:
    toks = [match_token(t) for t in text.split()]
    phrases: list[Phrase] = []
    rejected: list[Rejected] = []
    seen: set[str] = set()
    for run in _runs(toks):
        # Only near-complete runs count. Sliding a window through a long run
        # invents short phrases that happen to satisfy the checksum.
        # If the run is exactly a valid seed length, that IS the phrase: do
        # not slide a shorter window inside it (a 18-of-24 window can pass
        # the checksum by luck).  Otherwise trim only from the head or tail,
        # where UI chrome sits, never from the middle.
        if len(run) in COUNTS:
            candidates = [(len(run), 0)]
        else:
            candidates = [(c, s) for c in COUNTS if 0 < len(run) - c <= 8
                          for s in (0, len(run) - c)]
        for count, start in candidates:
            if True:
                window = run[start:start + count]
                words = [t.word for t in window]  # type: ignore[misc]
                conf = sum(t.score for t in window) / count
                key = " ".join(words)
                if key in seen:
                    continue
                seen.add(key)
                if conf < min_conf:
                    rejected.append(Rejected(key, "low confidence", conf, count))
                    continue
                ok = checksum_ok(words)
                if ok:
                    phrases.append(Phrase(key, words, True, conf, order, start=start))
                    continue
                fixed = None
                for label, variant in grid_variants(words):
                    if checksum_ok(variant):
                        fixed = (label, variant)
                        break
                if fixed:
                    vkey = " ".join(fixed[1])
                    if vkey not in seen:
                        seen.add(vkey)
                        phrases.append(Phrase(vkey, fixed[1], True, conf, fixed[0], start=start))
                else:
                    # Keep the candidate so a full-length but checksum-invalid
                    # phrase is reported (and explained) instead of vanishing.
                    phrases.append(Phrase(key, words, False, conf, order, start=start))
                    rejected.append(Rejected(key, "checksum fail", conf, count))
    return phrases, rejected


def _stats(text: str) -> tuple[int, int, int]:
    toks = [match_token(t) for t in text.split()]
    runs = _runs(toks)
    return sum(1 for t in toks if t.word), len(toks), max((len(r) for r in runs), default=0)


def extract(lines: list[Line], min_conf: float = 0.75) -> Extraction:
    """Try row-major then column-major order; prefer a checksum-valid phrase."""
    row_text = order_row_major(lines)
    row_phrases, row_rej = find_phrases(row_text, "row", min_conf)
    col_text, ncols = order_column_major(lines)
    col_phrases, col_rej = find_phrases(col_text, "column", min_conf)

    allp = row_phrases + col_phrases
    # ties go to row order: it is the natural reading order, column order is
    # only preferred when row-major fails the checksum
    # Ties: prefer the longest phrase, then the one furthest into its run.
    # UI chrome ("Type your 12-Word Phrase") precedes the seed, so the
    # correct window is the tail; a head-aligned window can checksum by luck.
    allp.sort(key=lambda p: (p.checksum, len(p.words), p.confidence,
                             p.start, 1 if p.order == "row" else 0))
    matched, total, max_run = _stats(row_text if not allp or allp[-1].order == "row" else col_text)
    if allp:
        best = allp[-1]
        # keep the order that produced the winning phrase as the transcript
        text = row_text if best.order == "row" else col_text
        for p in row_phrases + col_phrases:
            p.columns = ncols if p.order == "column" else 1
        return Extraction(text, [best] + [p for p in allp if p is not best],
                          row_rej + col_rej, matched, total, max_run)
    return Extraction(row_text, [], row_rej + col_rej, matched, total, max_run)
