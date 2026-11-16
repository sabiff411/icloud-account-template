#!/usr/bin/env python3
"""Keep the image export moving overnight.

Every five minutes:
  * if no ZIP has been written for 30 minutes while a shard is alive, the
    shard is hung on a proxy/API call: kill it and start it again (it resumes
    from zips/index.json);
  * if auto_unzip or the retry runner died, start it again.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("ICLOUD_ROOT") or Path(__file__).resolve().parents[1])
LOG_FILE = Path(os.environ.get("BULK_LOG") or ROOT / "bulk_images.log")
WATCH_LOG = Path(os.environ.get("WATCH_LOG") or ROOT / "watchdog.log")
PYTHON = os.environ.get("PYTHON_BIN") or (
    "/opt/icloud3-venv/bin/python"
    if os.path.exists("/opt/icloud3-venv/bin/python")
    else sys.executable
)
ENV = dict(os.environ)
ENV.setdefault("METADATA_DIRECT", "1")
STALL_SECONDS = int(os.environ.get("WATCHDOG_STALL_SECONDS", "3600") or 3600)


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    with WATCH_LOG.open("a") as handle:
        handle.write(line + "\n")
    print(line, flush=True)


def processes(name: str) -> list[int]:
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().decode().split("\0")
        except OSError:
            continue
        if any(arg.endswith(name) for arg in args):
            found.append(int(entry.name))
    return found


def last_zip() -> float:
    """Newest sign of life: a ZIP written or an account started.

    A large library can spend 15+ minutes enumerating before its first ZIP, so
    the account start line counts as progress.  Without this the watchdog
    restarts a healthy shard every five minutes.
    """
    newest = 0.0
    try:
        lines = LOG_FILE.read_text().splitlines()[-400:]
    except OSError:
        return 0.0
    for line in lines:
        match = re.match(
            r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) .* "
            r"(?:zip \d+ files|account \S+ start|reading \S+(?: \d+ assets)?|urls ready \S+)",
            line,
        )
        if match:
            newest = max(newest, time.mktime(time.strptime(match.group(1), "%Y-%m-%d %H:%M:%S")))
    marker = Path("/tmp/watchdog_restart_at")
    if marker.exists():
        try:
            newest = max(newest, float(marker.read_text().strip()))
        except ValueError:
            pass
    return newest


def export_incomplete() -> bool:
    """True while some trusted account has no finished image report."""
    try:
        data = json.loads(Path(os.environ.get("STORE_FILE") or ROOT / "server/data/items.json").read_text())
    except Exception:
        return False
    trusted = [a for a in data.get("accounts") or [] if a.get("trusted")]
    done = 0
    for account in trusted:
        email = str(account.get("email") or "")
        if email and (ROOT / "export" / email / "zips" / "report.json").exists():
            done += 1
    return done < len(trusted)


def start(name: str, args: list[str], user: str = "icloud3") -> None:
    with (ROOT / f"{name}.log").open("a") as handle:
        command = [PYTHON, str(ROOT / "python" / f"{name}.py"), *args]
        if user == "icloud3":
            keep = ("ANYIP", "S4_", "RCLONE", "EXPORT_DIR", "ICLOUD_", "STORE_FILE", "PYTHON_BIN")
            command = ["sudo", "-E", "-u", "icloud3", "env"] + [
                f"{key}={value}" for key, value in ENV.items() if key.startswith(keep)
            ] + command
        subprocess.Popen(
            command,
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    log(f"started {name} {' '.join(args)}")


def main() -> None:
    while True:
        last = last_zip()
        age = time.time() - last if last else 0
        shards = processes("bulk_images.py")
        if shards and age > STALL_SECONDS:
            log(f"stall: no zip for {age / 60:.0f} min, restarting shards {shards}")
            for pid in shards:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
            time.sleep(4)
            for pid in shards:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            for lock in Path("/tmp").glob("bulk_images*.lock"):
                lock.unlink(missing_ok=True)
            Path("/tmp/watchdog_restart_at").write_text(str(time.time()))
            for index in (0, 1):
                start(
                    "bulk_images",
                    ["--workers", "60", "--batch", "500", "--shard", f"{index}/2"],
                )
            time.sleep(5)
            start("auto_unzip", [])
        else:
            if not processes("bulk_images.py") and export_incomplete():
                log("no exporter running and accounts are unfinished — starting shards")
                for index in (0, 1):
                    start(
                        "bulk_images",
                        ["--workers", "60", "--batch", "500", "--shard", f"{index}/2", "--videos"],
                    )
                Path("/tmp/watchdog_restart_at").write_text(str(time.time()))
            if not processes("auto_unzip.py"):
                log("auto_unzip is not running")
                start("auto_unzip", [])
            if not processes("run_retries.py"):
                log("run_retries is not running")
                start("run_retries", [])
            s4_wanted = os.environ.get("S4_UPLOAD", "1" if os.environ.get("S4_REMOTE") else "0")
            if str(s4_wanted).lower() not in ("0", "false", "no", ""):
                if not processes("s4_upload.py"):
                    log("s4_upload is not running")
                    start("s4_upload", ["--watch", "--prune"], user="root")
        time.sleep(300)


if __name__ == "__main__":
    main()
