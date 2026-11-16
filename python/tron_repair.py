#!/usr/bin/env python3
"""Repair a misread phrase by brute force against a target TRON address.

A VLM (or OCR) can read one word wrong and the phrase still passes the BIP39
checksum, so it looks valid but derives a different wallet.  This tries every
BIP39 word in every position of a known phrase and keeps the substitution only
if the derived address equals the target — the address is the ground truth.

    tron_repair.py --address T... [--account x@y.com] [--paths 2] [--workers 8]

Cost: 12 positions x 2048 words = 24,576 seeds per 12-word phrase, ~2 PBKDF2
each, so phrases are spread over processes.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402
from tron_search import collect  # noqa: E402

from bip_utils import (  # noqa: E402
    Bip39SeedGenerator,
    Bip44,
    Bip44Changes,
    Bip44Coins,
)
from worker import scan  # noqa: E402


def wordlist() -> list[str]:
    """The 2048 BIP39 words, already loaded by the scanner."""
    return list(scan.word_index().keys())


def address_of(seed: bytes, index: int) -> str:
    return (
        Bip44.FromSeed(seed, Bip44Coins.TRON)
        .Purpose().Coin().Account(0).Change(Bip44Changes.CHAIN_EXT).AddressIndex(index)
        .PublicKey().ToAddress()
    )


def try_insert(job: tuple[str, str, int]) -> list[dict]:
    """Drop one word, then try every BIP39 word at every position.

    This is the "we read 12 words but the screen had 13 / one word was cut"
    case: 11 words are right, one is junk and one is missing."""
    phrase, target, paths = job
    words = phrase.split()
    vocabulary = wordlist()
    hits: list[dict] = []
    for drop in range(len(words)):
        rest = words[:drop] + words[drop + 1:]
        for position in range(len(rest) + 1):
            for candidate in vocabulary:
                attempt = rest[:position] + [candidate] + rest[position:]
                text = " ".join(attempt)
                try:
                    seed = Bip39SeedGenerator(text).Generate()
                except Exception:  # noqa: BLE001
                    continue
                for index in range(paths):
                    if address_of(seed, index) == target:
                        hits.append({"phrase": text, "dropped": drop,
                                     "inserted": candidate, "index": index})
                        return hits
    return hits


def try_phrase(job: tuple[str, str, int]) -> list[dict]:
    phrase, target, paths = job
    words = phrase.split()
    vocabulary = wordlist()
    hits: list[dict] = []
    for position in range(len(words)):
        original = words[position]
        for candidate in vocabulary:
            if candidate == original:
                continue
            attempt = list(words)
            attempt[position] = candidate
            text = " ".join(attempt)
            try:
                seed = Bip39SeedGenerator(text).Generate()
            except Exception:  # noqa: BLE001
                continue
            for index in range(paths):
                if address_of(seed, index) == target:
                    hits.append({"phrase": text, "position": position,
                                 "word": candidate, "index": index})
                    return hits
    return hits


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", required=True)
    parser.add_argument("--account", default="")
    parser.add_argument("--paths", type=int, default=2)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--insert", action="store_true",
                        help="drop one word and try every word in every position")
    args = parser.parse_args()

    phrases = list(collect(args.account).keys())
    if args.limit:
        phrases = phrases[: args.limit]
    print(f"{len(phrases)} phrases · {args.workers} processes · "
          f"{args.paths} address indexes each", flush=True)
    started = time.time()
    jobs = [(phrase, args.address, args.paths) for phrase in phrases]
    runner = try_insert if args.insert else try_phrase
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for done, hits in enumerate(pool.map(runner, jobs), 1):
            if hits:
                for hit in hits:
                    print(f"MATCH after {done}/{len(jobs)} phrases: {hit['phrase']}", flush=True)
                    detail = (f"dropped word {hit['dropped'] + 1}, inserted "
                              f"'{hit['inserted']}'" if "inserted" in hit
                              else f"word {hit['position'] + 1} -> {hit['word']}")
                    print(f"  {detail} · m/44'/195'/0'/0/{hit['index']}", flush=True)
            if done % 5 == 0:
                print(f"{done}/{len(jobs)} · {time.time() - started:.0f}s", flush=True)
    print(f"done in {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
