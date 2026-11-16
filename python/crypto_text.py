#!/usr/bin/env python3
"""Scan every text source of one account for crypto material.

Reads the exported notes, the Drive documents (text layer, plus OCR of scanned
pages through the pods) and any plain text, and reports BIP39 runs, hex
private keys and WIF keys.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, "/opt/icloud3/python")
from worker import scan  # noqa: E402

HEX_RE = re.compile(r"\b(0x)?[0-9a-fA-F]{64}\b")
WIF_RE = re.compile(r"\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b")
KEYWORDS = (
    "seed", "mnemonic", "phrase", "private key", "privatekey", "recovery",
    "wallet", "ledger", "trezor", "metamask", "trust wallet", "exodus",
    "phantom", "keystore", "passphrase", "backup", "12 words", "24 words",
    "btc", "eth", "bitcoin", "usdt", "binance", "coinbase", "kraken",
)


def scan_text(text: str, index: dict) -> dict:
    phrases = list(scan.find_sequences(text or "", index))
    return {
        "phrases": phrases,
        "hex": sorted(set(HEX_RE.findall(text or ""))),
        "wif": sorted(set(WIF_RE.findall(text or ""))),
        "keywords": sorted({k for k in KEYWORDS if k in (text or "").lower()}),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    account = Path(args.account)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    index = scan.word_index()
    rows = []

    notes = account / "Notes" / "txt"
    if notes.is_dir():
        for path in sorted(notes.glob("*.txt")):
            text = path.read_text(errors="ignore")
            found = scan_text(text, index)
            rows.append({"source": "note", "name": path.name, "path": str(path), **found,
                         "text": text[:4000]})

    emails = [p for p in account.glob("Mail/**/*") if p.is_file()]
    for path in emails:
        try:
            text = path.read_text(errors="ignore")
        except Exception:  # noqa: BLE001
            continue
        found = scan_text(text, index)
        rows.append({"source": "mail", "name": path.name, "path": str(path), **found,
                     "text": text[:4000]})

    (out / "text.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")

    hits = [r for r in rows if r["phrases"] or r["hex"] or r["wif"]]
    print(f"scanned {len(rows)} text files, {len(hits)} with crypto material")
    for row in hits[:20]:
        print(f"  {row['source']:5s} {row['name'][:50]:52s} phrases={len(row['phrases'])} hex={len(row['hex'])} wif={len(row['wif'])} kw={row['keywords'][:3]}")


if __name__ == "__main__":
    main()
