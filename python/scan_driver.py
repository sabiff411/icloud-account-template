#!/usr/bin/env python3
"""OCR every exported account, smallest library first; scan_export reuses
the per-image OCR cache, so a re-run only touches new images."""
import json, os, sys, time
from pathlib import Path

os.environ.setdefault("SCAN_WORKERS", "12")
os.environ.setdefault("SCAN_OCR_MAX", "1600")
sys.path.insert(0, "/opt/icloud3/python")
from worker import scan

ROOT = Path("/opt/icloud3/export")
STORE = Path("/opt/icloud3/server/data/items.json")
LOG = open("/var/lib/icloud3-bulk/scan_driver.log", "a", buffering=1)

def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, file=LOG, flush=True)

def progress(done, total, area):
    if done == total or done % 2000 == 0:
        log("progress", area, done, "/", total)

try:
    data = json.loads(STORE.read_text())
    weights = {a.get("email"): int((a.get("counts") or {}).get("images") or 0)
               for a in data.get("accounts", [])}
except Exception:
    weights = {}

accounts = [p for p in ROOT.iterdir() if p.is_dir() and (p / "Photos").is_dir()]
accounts.sort(key=lambda p: (weights.get(p.name, 10**9), p.name))
log("start", len(accounts), "accounts", "workers", os.environ["SCAN_WORKERS"])
for root in accounts:
    try:
        started = time.time()
        r = scan.scan_export(None, root, progress=progress)
        log("done", root.name, "images", r.get("images"), "ocr", r.get("ocrOk"),
            "failed", r.get("ocrFailed"), "findings", r.get("findings"),
            "secs", int(time.time() - started))
    except Exception as error:
        log("error", root.name, type(error).__name__, str(error)[:200])
    time.sleep(3)
log("finished")
