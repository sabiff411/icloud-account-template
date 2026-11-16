#!/usr/bin/env python3
"""Run the vision-LLM OCR over exported images and merge the findings.

Writes the same artefacts the local scanner uses, so the panel needs no change:

    Scan/ocr/<rel>.txt     raw model output + the parsed phrase
    Scan/vlm/<rel>.json    parsed result (order, checksum, confidence, reason)
    Scan/findings.json     merged phrases, checksum/tier as before

No CPU-heavy OCR runs on the VPS: the work goes to the remote vLLM endpoint.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker import scan  # noqa: E402
from worker.ocr_vlm import CONCURRENCY, IMAGE_EXT, PODS, describe_pods, extract  # noqa: E402

ROOT = Path("/opt/icloud3/export")
AREAS = ("Library", "Hidden", "Recently Deleted")
LOG = Path("/opt/icloud3/scan_vlm.log")
LOCK = threading.Lock()


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    with LOCK:
        print(line, flush=True)
        try:
            with LOG.open("a") as handle:
                handle.write(line + "\n")
        except OSError:
            pass


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def merge_findings(scan_dir: Path, new_items: list[dict]) -> None:
    path = scan_dir / "findings.json"
    payload = {"generatedAt": None, "findings": []}
    if path.exists():
        try:
            payload = json.loads(path.read_text())
        except Exception:
            pass
    existing = {(item.get("file"), item.get("phrase")) for item in payload.get("findings", [])}
    added = 0
    for item in new_items:
        key = (item.get("file"), item.get("phrase"))
        if key in existing:
            continue
        existing.add(key)
        payload.setdefault("findings", []).append(item)
        added += 1
    if added:
        payload["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=1))
    log(f"merge {scan_dir.parent.name} +{added} findings")


def seed_files(scan_dir: Path, tiers: tuple[str, ...] = ("medium", "high", "valid")) -> set[str]:
    """Files whose old OCR produced a seed candidate at the given tiers."""
    path = scan_dir / "findings.json"
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text())
    except Exception:
        return set()
    found: set[str] = set()
    for item in payload.get("findings", []):
        tier = item.get("tier")
        if tier in tiers or (item.get("checksum") and "valid" in tiers):
            if item.get("file"):
                found.add(str(item["file"]))
    return found


def process_account(
    account: Path,
    concurrency: int,
    limit: int,
    only_seeds: bool = False,
    tiers: tuple[str, ...] = ("medium", "high", "valid"),
    retry_list: bool = False,
    retry_side: int = 2400,
    force: bool = False,
) -> dict:
    email = account.name
    scan_dir = account / "Scan"
    tasks: list[tuple[Path, str]] = []
    roots: list[tuple[Path, str]] = [(account / "Photos" / area, area) for area in AREAS]
    roots.append((account / "Drive", "Drive"))
    for base, label in roots:
        if retry_list:
            break
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXT:
                continue
            rel = path.relative_to(account).as_posix()
            marker = scan_dir / "vlm" / f"{rel}.json"
            if marker.exists():
                payload = None
                try:
                    if marker.stat().st_size < 400:
                        payload = json.loads(marker.read_text())
                except Exception:
                    payload = {"error": "unreadable", "attempts": 0}
                if payload is not None and "error" in payload:
                    # A failed read is re-queued, but only a few times: a
                    # genuinely undecodable file must not spin forever.
                    stub = int(payload.get("attempts") or 0) < 3
                else:
                    stub = False
                if not stub and not only_seeds and not force:
                    continue
            tasks.append((path, label))
            if limit and len(tasks) >= limit:
                break
        if limit and len(tasks) >= limit:
            break
    if retry_list:
        listed: list[tuple[Path, str]] = []
        try:
            entries = (scan_dir / "vlm-retry.txt").read_text().splitlines()
        except OSError:
            entries = []
        for entry in entries:
            rel = entry.split("/", 1)[1] if "/" in entry else entry
            target = account / rel
            if target.is_file():
                area = rel.split("/")[1] if rel.startswith("Photos/") else "Drive"
                listed.append((target, area))
        tasks = listed
    if only_seeds:
        wanted = seed_files(scan_dir, tiers)
        tasks = [task for task in tasks if task[0].relative_to(account).as_posix() in wanted]
    if not tasks:
        return {"email": email, "images": 0, "phrases": 0, "valid": 0, "seconds": 0}

    index = scan.word_index()
    findings: list[dict] = []
    vlm_index: dict[str, dict] = {}
    started = time.time()
    done = 0

    def one(task: tuple[Path, str]) -> dict:
        path, area = task
        try:
            result = extract(path, retry_side if retry_list else None)
        except Exception as error:  # noqa: BLE001 - one image must not stop the account
            rel = path.relative_to(account).as_posix()
            out = scan_dir / "vlm" / f"{rel}.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            attempts = 1
            if out.exists():
                try:
                    attempts = int(json.loads(out.read_text()).get("attempts") or 0) + 1
                except Exception:
                    attempts = 1
            out.write_text(
                json.dumps({"error": f"{type(error).__name__}: {str(error)[:120]}", "attempts": attempts})
            )
            log(f"{account.name} skip {path.name} {type(error).__name__}")
            return {"findings": [], "result": None}
        rel = path.relative_to(account).as_posix()
        text = result.get("raw") or ""
        phrase = result.get("phrase") or ""
        if phrase:
            text = f"{text}\n{phrase}\n"
        write_text(scan_dir / "ocr" / f"{rel}.txt", text)
        thumb = scan_dir / "thumbs" / f"{rel}.jpg"
        if not thumb.exists():
            try:
                from PIL import Image, ImageOps

                with Image.open(path) as image:
                    upright = ImageOps.exif_transpose(image) or image
                    small = upright.convert("RGB")
                    small.thumbnail((512, 512))
                    thumb.parent.mkdir(parents=True, exist_ok=True)
                    small.save(thumb, "JPEG", quality=82)
            except Exception:
                pass
        out = scan_dir / "vlm" / f"{rel}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False))
        vlm_index[rel] = {
            "kind": result.get("kind") or "",
            "modelKind": result.get("modelKind") or "",
            "checksum": bool(result.get("checksum")),
            "count": int(result.get("count") or 0),
            "phrase": result.get("phrase") or "",
            "hasText": bool(result.get("hasText")),
        }
        local: list[dict] = []
        if phrase and result.get("count") in (12, 15, 18, 21, 24):
            local.append(
                {
                    "file": rel,
                    "area": area,
                    "name": path.name,
                    "phrase": phrase,
                    "words": result["count"],
                    "tier": scan.tier_for(result["count"]),
                    "checksum": bool(result.get("checksum")),
                    "spam": scan.is_spam_phrase(phrase),
                    "source": "ocr-vlm",
                    "offset": 0,
                }
            )
        for item in scan.find_sequences(text, index):
            if item["phrase"] == phrase:
                continue
            local.append(
                {
                    "file": rel,
                    "area": area,
                    "name": path.name,
                    "phrase": item["phrase"],
                    "words": item["words"],
                    "tier": item["tier"],
                    "checksum": item["checksum"],
                    "spam": item.get("spam", False),
                    "source": "ocr-vlm",
                    "offset": item.get("offset", 0),
                }
            )
        return {
            "findings": local,
            "result": result,
            "rel": rel,
            "meta": vlm_index[rel],
        }

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        index_path = scan_dir / "vlm-index.json"

        def flush_index() -> None:
            if not vlm_index:
                return
            merged: dict[str, dict] = {}
            if index_path.exists():
                try:
                    merged = json.loads(index_path.read_text())
                except Exception:
                    merged = {}
            merged.update(vlm_index)
            index_path.write_text(json.dumps(merged))

        for outcome in pool.map(one, tasks):
            findings.extend(outcome["findings"])
            done += 1
            if done % 50 == 0:
                log(f"{email} {done}/{len(tasks)}")
            if done % 100 == 0:
                flush_index()

    merge_findings(scan_dir, findings)
    if vlm_index:
        index_path = scan_dir / "vlm-index.json"
        merged: dict[str, dict] = {}
        if index_path.exists():
            try:
                merged = json.loads(index_path.read_text())
            except Exception:
                merged = {}
        merged.update(vlm_index)
        index_path.write_text(json.dumps(merged))
    valid = sum(1 for item in findings if item["checksum"])
    elapsed = time.time() - started
    log(
        f"done {email} images {len(tasks)} phrases {len(findings)} valid {valid} "
        f"secs {elapsed:.0f} rate {len(tasks) / max(elapsed, 1):.2f}/s"
    )
    return {"email": email, "images": len(tasks), "phrases": len(findings), "valid": valid, "seconds": elapsed}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--limit", type=int, default=0, help="images per account")
    parser.add_argument("--accounts", type=int, default=0, help="stop after N accounts")
    parser.add_argument("--concurrency", "--workers", dest="concurrency", type=int, default=CONCURRENCY)
    parser.add_argument("--only-seeds", action="store_true", help="recheck only images flagged by the old OCR")
    parser.add_argument("--tiers", default="medium,high,valid", help="tiers to include with --only-seeds")
    parser.add_argument("--retry-list", action="store_true", help="re-read the images listed in Scan/vlm-retry.txt at high resolution")
    parser.add_argument("--retry-side", type=int, default=2400, help="pixels for --retry-list reads")
    parser.add_argument("--force", action="store_true", help="re-read images that already have a result")
    args = parser.parse_args()

    accounts = sorted(
        [p for p in ROOT.iterdir() if p.is_dir() and ((p / "Photos").is_dir() or (p / "Drive").is_dir())],
        key=lambda p: p.name,
    )
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [p for p in accounts if p.name.lower() in wanted]
    if args.accounts:
        accounts = accounts[: args.accounts]

    log(f"start {len(accounts)} accounts pods {len(PODS)} concurrency {args.concurrency} limit {args.limit}")
    for url, model in describe_pods():
        log(f"pod {url} model {model}")
    totals = {"images": 0, "phrases": 0, "valid": 0, "seconds": 0.0}
    for account in accounts:
        try:
            tiers = tuple(part.strip() for part in args.tiers.split(",") if part.strip())
            result = process_account(
                account, args.concurrency, args.limit, args.only_seeds, tiers,
                retry_list=args.retry_list, retry_side=args.retry_side, force=args.force,
            )
        except Exception as error:  # noqa: BLE001
            log(f"{account.name} failed {type(error).__name__}: {str(error)[:160]}")
            continue
        for key in ("images", "phrases", "valid"):
            totals[key] += result.get(key, 0)
        totals["seconds"] += result.get("seconds", 0)
    log(
        f"finish images {totals['images']} phrases {totals['phrases']} valid {totals['valid']} "
        f"secs {totals['seconds']:.0f} rate {totals['images'] / max(totals['seconds'], 1):.2f}/s"
    )


if __name__ == "__main__":
    main()
