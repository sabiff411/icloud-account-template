#!/usr/bin/env python3
"""Find which seed phrase controls a given TRON address.

Every phrase the pipeline has extracted (VLM transcriptions and OCR findings,
all accounts) is used to derive addresses on the usual BIP44 paths and compared
with the target.  A match is the only proof that matters: the words either
derive the address or they do not.

    tron_search.py --address TQ6QHkqfkRrtNvKSwAcNEGXYyBnRJGfZvm [--account x@y.com]

Paths tried per phrase (TRON coin type 195, plus the Ethereum path that some
wallets reuse, and a few account/index variants):

    m/44'/195'/a'/0/i     a in 0..4, i in 0..9
    m/44'/195'/a'/1/i     change branch
    m/44'/60'/0'/0/i
    m/49'/195'/0'/0/0
    m/44'/195'/0'/0/0 with the phrase as-is and with spaces collapsed
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402

from bip_utils import (  # noqa: E402
    Bip32Secp256k1,
    Bip39SeedGenerator,
    Bip44,
    Bip44Changes,
    Bip44Coins,
)

WORD_COUNTS = (12, 15, 18, 21, 24)


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def normalise(phrase: str) -> str:
    words = [word for word in str(phrase or "").lower().split() if word]
    return " ".join(words)


def collect(account: str = "") -> dict[str, set[str]]:
    """phrase -> files it was read from."""
    found: dict[str, set[str]] = {}

    def add(phrase: str, where: str) -> None:
        text = normalise(phrase)
        if len(text.split()) in WORD_COUNTS:
            found.setdefault(text, set()).add(where)

    for path in ca.OUT_DIR.glob("phrase-*.jsonl"):
        if not account or path.stem == f"phrase-{account.split('@')[0]}":
            for line in path.read_text(errors="ignore").splitlines():
                try:
                    row = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if row.get("phrase"):
                    add(row["phrase"], row.get("rel", path.name))
    for email, root in ca.account_roots().items():
        if account and email != account:
            continue
        for name in ("findings.json", "classify-verify.jsonl"):
            path = root / "Scan" / name
            if not path.is_file():
                continue
            try:
                if name.endswith(".jsonl"):
                    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
                    for row in rows:
                        for phrase in row.get("phrases", []):
                            add(phrase.get("phrase", ""), f"{email}/{row.get('rel', '')}")
                else:
                    payload = json.loads(path.read_text())
                    for item in payload.get("findings", []):
                        add(item.get("phrase", ""), f"{email}/{item.get('file', '')}")
            except Exception:  # noqa: BLE001
                continue
    return found


def addresses(phrase: str) -> list[tuple[str, str]]:
    """(path, address) for every path worth trying."""
    out: list[tuple[str, str]] = []
    try:
        seed = Bip39SeedGenerator(phrase).Generate()
    except Exception:  # noqa: BLE001
        return out
    # master key itself (some old wallets use it)
    try:
        out.append(("m", Bip32Secp256k1.FromSeed(seed).PublicKey().ToAddress()))
    except Exception:  # noqa: BLE001
        pass
    for account_index in range(5):
        for change in (Bip44Changes.CHAIN_EXT, Bip44Changes.CHAIN_INT):
            for index in range(20):
                if change == Bip44Changes.CHAIN_INT and index > 1:
                    continue
                try:
                    ctx = (
                        Bip44.FromSeed(seed, Bip44Coins.TRON)
                        .Purpose()
                        .Coin()
                        .Account(account_index)
                        .Change(change)
                        .AddressIndex(index)
                    )
                    out.append((f"m/44'/195'/{account_index}'/"
                                f"{0 if change == Bip44Changes.CHAIN_EXT else 1}/{index}",
                                ctx.PublicKey().ToAddress()))
                except Exception:  # noqa: BLE001
                    continue
    for account_index in range(3):
        try:
            ctx = Bip44.FromSeed(seed, Bip44Coins.TRON).Purpose().Coin().Account(account_index)
            out.append((f"m/44'/195'/{account_index}'", ctx.PublicKey().ToAddress()))
            out.append((f"m/44'/195'/{account_index}'/0", ctx.Change(Bip44Changes.CHAIN_EXT).PublicKey().ToAddress()))
        except Exception:  # noqa: BLE001
            pass
    for index in range(5):
        try:
            eth = (
                Bip44.FromSeed(seed, Bip44Coins.ETHEREUM)
                .Purpose()
                .Coin()
                .Account(0)
                .Change(Bip44Changes.CHAIN_EXT)
                .AddressIndex(index)
            )
            raw = bytes.fromhex(eth.PublicKey().RawCompressed().ToHex()[2:]
                                if False else eth.PublicKey().RawUncompressed().ToHex()[2:])
            from bip_utils import Keccak256
            digest = Keccak256.ComputeHash(raw)
            payload = b"\x41" + digest[-20:]
            out.append((f"m/44'/60'/0'/0/{index}", _base58check(payload)))
        except Exception:  # noqa: BLE001
            continue
    return out


def _base58check(payload: bytes) -> str:
    from hashlib import sha256

    checksum = sha256(sha256(payload).digest()).digest()[:4]
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = int.from_bytes(payload + checksum, "big")
    text = ""
    while number:
        number, remainder = divmod(number, 58)
        text = alphabet[remainder] + text
    for byte in payload + checksum:
        if byte:
            break
        text = "1" + text
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", required=True)
    parser.add_argument("--account", default="")
    parser.add_argument("--save", default="/opt/icloud3/classify/tron-search.json")
    args = parser.parse_args()

    target = args.address.strip()
    phrases = collect(args.account)
    log(f"{len(phrases)} distinct phrases to derive"
        + (f" (account {args.account})" if args.account else " (all accounts)"))
    started = time.time()
    hits: list[dict] = []
    checked = 0
    for phrase, where in phrases.items():
        checked += 1
        for path, address in addresses(phrase):
            if address == target:
                hits.append({"phrase": phrase, "path": path, "files": sorted(where)})
                log(f"MATCH {address} {path}")
                log(f"  {phrase}")
                for file in sorted(where):
                    log(f"  from {file}")
        if checked % 50 == 0:
            log(f"{checked}/{len(phrases)} phrases · {checked / (time.time() - started):.1f}/s")

    Path(args.save).write_text(json.dumps({
        "address": target,
        "phrases": len(phrases),
        "seconds": round(time.time() - started, 1),
        "matches": hits,
    }, indent=1))
    if not hits:
        log(f"no match · {len(phrases)} phrases × ~100 paths in "
            f"{time.time() - started:.0f}s")
        log(f"wrote {args.save}")
        return
    log(f"{len(hits)} match(es) · wrote {args.save}")


if __name__ == "__main__":
    main()
