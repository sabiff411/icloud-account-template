"""Score one or more results/<engine>.jsonl files against eval/gt.json."""
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from rapidfuzz.distance import Levenshtein

HERE = Path(__file__).resolve().parent
EVAL = HERE / "eval"
RESULTS = HERE / "results"

POSITIVE = {"printed_clean", "printed_photo", "screenshot", "rotated", "lowres", "heic_avif", "positive_real"}
NEGATIVE = {"negative_synth", "negative_real", "near_miss", "near_miss_real"}


def norm(s: str) -> str:
    return " ".join(s.lower().split())


def cer(ref: str, hyp: str) -> float:
    ref, hyp = norm(ref), norm(hyp)
    return Levenshtein.normalized_distance(ref, hyp) if ref else (0.0 if not hyp else 1.0)


def wer(ref: str, hyp: str) -> float:
    r, h = norm(ref).split(), norm(hyp).split()
    if not r:
        return 0.0 if not h else 1.0
    return Levenshtein.distance(r, h) / len(r)


def bucket(g: dict) -> str:
    if g["class"] == "heic_avif":
        return "heic_avif"
    return f"{g['class']}:{g['word_count']}w"


def load(path: Path) -> dict[str, dict]:
    out = {}
    for line in path.read_text().splitlines():
        r = json.loads(line)
        out[r["id"]] = r
    return out


def score_one(path: Path) -> dict:
    gt = {g["id"]: g for g in json.loads((EVAL / "gt.json").read_text())["images"]}
    res = load(path)
    per_class = defaultdict(lambda: {"n": 0, "hit": 0, "cs": 0, "cer": [], "wer": [], "ms": []})
    fp = 0
    neg_n = 0
    rejected = Counter()
    for gid, g in gt.items():
        r = res.get(gid)
        if not r:
            continue
        c = g["class"]
        d = per_class[c]
        d["n"] += 1
        d["ms"].append(r["ms"])
        if c in NEGATIVE:
            if c in ("negative_synth", "negative_real"):
                neg_n += 1
                if r["phrase"] and r["checksum"]:
                    fp += 1
            for reason in r.get("rejected", []):
                rejected[reason] += 1
            continue
        got = norm(r["phrase"])
        want = norm(g["phrase"])
        hit = got == want
        d["hit"] += int(hit)
        d["cs"] += int(bool(r.get("checksum")))
        refs = [x for x in (g.get("transcript"), g.get("transcript_col")) if x]
        d["cer"].append(min(cer(x, r.get("text", "")) for x in refs))
        d["wer"].append(min(wer(x, r.get("text", "")) for x in refs))
    return {"file": path.name, "per_class": per_class, "fp": fp, "neg_n": neg_n, "rejected": rejected}


def fmt_table(rows: list[dict]) -> str:
    lines = ["| engine | class | n | recall | checksum | CER | WER | med ms | p95 ms |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for row in rows:
        for cls, d in sorted(row["per_class"].items()):
            if not d["n"]:
                continue
            med = statistics.median(d["ms"])
            p95 = statistics.quantiles(d["ms"], n=20)[-1] if len(d["ms"]) > 4 else max(d["ms"])
            lines.append(
                f"| {row['file'].replace('.jsonl','')} | {cls} | {d['n']} | "
                f"{d['hit']/d['n']*100:.1f}% | {d['cs']/d['n']*100:.1f}% | "
                f"{(sum(d['cer'])/len(d['cer']) if d['cer'] else 0):.3f} | "
                f"{(sum(d['wer'])/len(d['wer']) if d['wer'] else 0):.3f} | "
                f"{med:.0f} | {p95:.0f} |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    files = [Path(f) for f in args.files] or sorted(RESULTS.glob("*.jsonl"))
    rows = [score_one(f) for f in files if f.exists()]
    if args.json:
        print(json.dumps(rows, indent=1, default=str))
        return
    print(fmt_table(rows))
    print()
    for row in rows:
        total_pos = sum(d["n"] for c, d in row["per_class"].items() if c in POSITIVE)
        hits = sum(d["hit"] for c, d in row["per_class"].items() if c in POSITIVE)
        printable = [c for c in ("printed_clean", "screenshot", "lowres", "rotated", "heic_avif")]
        ph = sum(row["per_class"][c]["hit"] for c in printable if c in row["per_class"])
        pn = sum(row["per_class"][c]["n"] for c in printable if c in row["per_class"])
        fp_rate = row["fp"] / row["neg_n"] * 1000 if row["neg_n"] else 0
        print(f"**{row['file'].replace('.jsonl','')}** — overall recall "
              f"{hits}/{total_pos} = {hits/max(1,total_pos)*100:.1f}% · "
              f"printed+screenshot {ph}/{pn} = {ph/max(1,pn)*100:.1f}% · "
              f"FP {fp_rate:.1f}/1000 · rejections {dict(row['rejected'].most_common(3))}")


if __name__ == "__main__":
    main()
