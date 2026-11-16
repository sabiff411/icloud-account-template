#!/usr/bin/env python3
"""Bulk image export: images only, 500 per ZIP, through the download proxies.

The account session (metadata / signed URLs) goes through anyIP, exactly like
the worker.  The image bytes go through the six HTTP proxies listed in
``download_proxies.txt``.  Every account keeps its existing individual files;
newly downloaded files are only temporary and are removed after their batch
is zipped (the ZIP contains them).

Per account:

  * enumerate Hidden, Recently Deleted and Library once
  * skip videos (MOV/MP4/...); every still image is included
  * stream in batches of 500 so the signed URLs are still fresh
  * reuse a file already on disk, download the rest in parallel
  * write zips/images-0001.zip, record the asset ids in zips/index.json
  * compare live ids with the manifest: NEW / DELETED
  * compare Drive ids with the manifest: new / missing

It is resumable: ids already recorded in zips/index.json are not downloaded
again.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import shutil
import signal
import sqlite3
import sys
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout, as_completed
from pathlib import Path

import requests
from pyicloud import PyiCloudService
from requests.adapters import HTTPAdapter

# Apple/pyicloud calls ``session.get`` without a timeout, and a stalled proxy
# connection then hangs the whole shard forever.  Inject a default at the
# adapter level so every request has one (connect 15 s, read 60 s).
_DEFAULT_TIMEOUT = (15, 60)
_original_send = HTTPAdapter.send


def _send_with_timeout(self, request, **kwargs):
    if kwargs.get("timeout") is None:
        kwargs["timeout"] = _DEFAULT_TIMEOUT
    return _original_send(self, request, **kwargs)


HTTPAdapter.send = _send_with_timeout
# Keep-alive sockets created before a proxy stalls can block forever; a
# default socket timeout keeps the process moving even then.
socket.setdefaulttimeout(60)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker.exporter import is_skipped_drive  # noqa: E402
from worker.proxy import build_proxy_url, stable_ssid  # noqa: E402
from worker.proxy_support import attach  # noqa: E402

ROOT = Path(os.environ.get("ICLOUD_ROOT") or Path(__file__).resolve().parents[1])
STORE = Path(os.environ.get("STORE_FILE") or ROOT / "server/data/items.json")
EXPORT = Path(os.environ.get("EXPORT_DIR") or ROOT / "export")
LOG = Path(os.environ.get("BULK_LOG") or ROOT / "bulk_images.log")
# Mutable state lives outside the app tree: a deploy rsyncs /opt/icloud3 with
# --delete and would otherwise remove the proxy list and the reports.
STATE = Path(os.environ.get("ICLOUD_BULK_STATE") or "/var/lib/icloud3-bulk")
try:
    STATE.mkdir(parents=True, exist_ok=True)
except OSError:
    STATE = ROOT / "bulk-state"
    STATE.mkdir(parents=True, exist_ok=True)
PROXY_FILE = STATE / "download_proxies.txt"
REPORT = STATE / "bulk_report.json"
# A manual single-account pass can take its own lock instead of waiting for a
# shard: BULK_LOCK=/tmp/bulk_images-manual.lock
LOCK = Path(os.environ.get("BULK_LOCK") or "/tmp/bulk_images.lock")

BATCH = 500
WORKERS = 90
# CloudKit signed URLs are short-lived.  A URL list older than this is stale:
# every download gets 403/410, each one triggers a photo-by-id refresh, and
# the whole shard hangs on CloudKit.  That is what froze aminah for hours.
URL_MAX_AGE = 45 * 60
# A single batch must finish in this budget; a hung proxy/CloudKit call after
# that is recorded as a failure instead of blocking the shard forever.
BATCH_TIMEOUT = 1800
INCLUDE_VIDEOS = False
# Videos are ~30x the bytes of a photo.  By default --videos covers Hidden
# and Recently Deleted (the albums the operator asked for); the huge Library
# clips are fetched by a later --videos-all pass.
INCLUDE_VIDEOS_ALL = False


def want_video(album_name: str) -> bool:
    return bool(INCLUDE_VIDEOS and (INCLUDE_VIDEOS_ALL or album_name in ("Hidden", "Recently Deleted")))
ONLY_HIDDEN = False  # kept for old callers; see ONLY_ALBUM
ONLY_ALBUM = ""
MIN_FREE = 30 * 1024**3
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"}

print_lock = threading.Lock()


class AccountTimeout(Exception):
    pass


def _alarm(signum, frame):
    raise AccountTimeout("account exceeded its time budget")


def log(*args):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(a) for a in args)
    with print_lock:
        print(line, flush=True)


def report_rows() -> list[dict]:
    """Merge the global reports and the per-account zips/report.json files."""
    best: dict[str, dict] = {}
    sources = list(sorted(ROOT.glob("bulk_report*.json")))
    for account_dir in EXPORT.iterdir():
        candidate = account_dir / "zips" / "report.json"
        if candidate.exists():
            sources.append(candidate)
    for path in sources:
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        if isinstance(data, dict):
            data = [data]
        for row in data if isinstance(data, list) else []:
            if not isinstance(row, dict):
                continue
            email = str(row.get("email") or "")
            if not email:
                continue
            current = best.get(email)
            if current is None:
                best[email] = row
                continue
            if current.get("error") and not row.get("error"):
                best[email] = row
            elif str(row.get("finishedAt") or "") > str(current.get("finishedAt") or ""):
                best[email] = row
    return list(best.values())


def load_proxies() -> list[str]:
    """The download proxies, or [] for a direct connection.

    DOWNLOAD_DIRECT=1 is the fast path: measured 6.2 MB/s direct against
    15-22 KB/s through the current proxy pool.
    """
    if os.environ.get("DOWNLOAD_DIRECT", "0") == "1":
        return []
    if not PROXY_FILE.exists() and (ROOT / "download_proxies.txt").exists():
        PROXY_FILE.write_text((ROOT / "download_proxies.txt").read_text())
    out = []
    for line in PROXY_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        host, port, user, password = line.split(":", 3)
        out.append(f"http://{user}:{password}@{host}:{port}")
    if not out:
        raise SystemExit("no proxies in " + str(PROXY_FILE))
    return out


def load_accounts() -> list[dict]:
    data = json.loads(STORE.read_text())
    accounts = data.get("accounts") or []
    if isinstance(accounts, dict):
        accounts = list(accounts.values())
    result = []
    for account in accounts:
        if not account.get("trusted"):
            continue
        email = str(account.get("email") or "").strip()
        session_dir = str(account.get("sessionDir") or "").strip()
        if not email or not session_dir:
            continue
        # Stored paths are relative ("sessions/<hash>") in the live store.
        session_path = Path(session_dir)
        if not session_path.is_absolute():
            session_path = ROOT / session_path
        if not session_path.is_dir():
            continue
        account = dict(account)
        account["sessionDir"] = str(session_path)
        result.append(account)
    # Smallest libraries first: quick wins, and the big ones finish last.
    def weight(account):
        counts = account.get("counts") or {}
        return int(counts.get("images") or counts.get("photos") or 0)
    return sorted(result, key=weight)


def manifest_photos(email: str) -> dict[str, tuple[str, int]]:
    path = EXPORT / email / "manifest.sqlite3"
    found: dict[str, tuple[str, int]] = {}
    if not path.exists():
        return found
    try:
        db = sqlite3.connect(str(path))
        rows = db.execute(
            "SELECT key, path, size FROM files "
            "WHERE area IN ('photos','hidden','deleted') AND status='done'"
        ).fetchall()
        db.close()
    except sqlite3.Error:
        return found
    for key, file_path, size in rows:
        key = str(key or "")
        if key.startswith("photo:"):
            found[key[len("photo:"):]] = (str(file_path), int(size or 0))
    return found


def manifest_drive_ids(email: str) -> set[str]:
    path = EXPORT / email / "manifest.sqlite3"
    found: set[str] = set()
    if not path.exists():
        return found
    try:
        db = sqlite3.connect(str(path))
        rows = db.execute(
            "SELECT key FROM files WHERE area='drive' AND status IN ('done','skipped')"
        ).fetchall()
        db.close()
    except sqlite3.Error:
        return found
    for (key,) in rows:
        key = str(key or "")
        if not key.startswith("drive:"):
            continue
        rest = key[len("drive:"):]
        name, sep, size = rest.rpartition(":")
        if not sep:
            continue
        found.add(f"{name.rsplit('/', 1)[-1]}:{size}")
    return found


def live_drive_ids(api, budget: float = 900.0) -> set[str]:
    found: set[str] = set()
    stack = [(api.drive.root, "")]
    started = time.time()
    while stack:
        if time.time() - started > budget:
            break
        node, prefix = stack.pop()
        try:
            children = node.get_children() or []
        except Exception:
            continue
        for child in children:
            name = str(getattr(child, "name", "") or "")
            if getattr(child, "type", "") == "folder":
                if name.lower().endswith(".app"):
                    continue
                stack.append((child, f"{prefix}{name}/"))
                continue
            if is_skipped_drive(f"{prefix}{name}"):
                continue
            size = int(getattr(child, "size", 0) or 0)
            found.add(f"{name}:{size}")
    return found


def open_api(account: dict, attempt: int = 0):
    email = account["email"]
    proxy = account.get("proxy") or {}
    country = str(proxy.get("country") or (account.get("geo") or {}).get("countryCode") or "")
    ssid = str(proxy.get("ssid") or stable_ssid(email))
    base = os.environ.get("ANYIP_PROXY_URL") or os.environ.get("ICLOUD_PROXY_URL") or ""
    # anyIP metadata calls stall for minutes on some exits; the cookie itself
    # is valid from any IP, so the enumerator can go direct.
    direct = os.environ.get("METADATA_DIRECT", "0") == "1"
    proxy_url = "" if direct else (build_proxy_url(base, country=country, ssid=ssid, attempt=attempt) if base else "")
    api = PyiCloudService(
        email,
        str(account.get("password") or ""),
        cookie_directory=account["sessionDir"],
        authenticate=False,
        accept_terms=True,
    )
    fingerprint = account.get("fingerprint") or {}
    headers = {}
    if fingerprint.get("userAgent"):
        headers["User-Agent"] = fingerprint["userAgent"]
    if fingerprint.get("language"):
        headers["Accept-Language"] = fingerprint["language"]
    if headers:
        api.session.headers.update(headers)
    # Fresh connection per request: a stale keep-alive socket through a dead
    # proxy exit is what hung the shards for hours.
    api.session.headers["Connection"] = "close"
    if proxy_url:
        # Pin the account to its one stable exit IP.  Rotating the session id
        # changes the IP Apple sees and invalidates the trusted cookie, so the
        # session id must never change while the account is in use.
        attach(api.session, proxy_url)
    # A stalled proxy connection must never hang the whole shard: every
    # metadata call gets a default timeout (connect 15 s, read 60 s).
    original = api.session.request

    def with_timeout(*args, **kwargs):
        kwargs.setdefault("timeout", (15, 60))
        return original(*args, **kwargs)

    api.session.request = with_timeout
    status = api.get_auth_status() or {}
    if not status.get("authenticated"):
        # The cookie on disk went stale (Apple dropped it, or the worker's
        # login never saved one).  Log in again with the stored password
        # instead of failing the whole account.
        password = str(account.get("password") or "")
        if not password:
            raise RuntimeError("session not authenticated")
        log("account", email, "session stale, logging in again")
        # A password login rotates Apple's cookies.  If it stops at the 2FA
        # prompt, the jar on disk would lose its web token and the account
        # would look dead; keep a copy and put it back unless the login
        # finished with a token pair.
        backup = backup_session(api)
        api.authenticate()
        if getattr(api, "requires_2fa", False) or not api.session.cookies.get(
            "X-APPLE-WEBAUTH-TOKEN"
        ):
            restore_session(backup)
            raise RuntimeError("2fa required: session needs a code")
        status = api.get_auth_status() or {}
    if not status.get("authenticated"):
        raise RuntimeError("session not authenticated")
    return api


def backup_session(api) -> list[tuple[Path, Path]]:
    """Copy the session/cookiejar before a re-login can rewrite them."""
    saved: list[tuple[Path, Path]] = []
    for attribute in ("session_path", "cookiejar_path"):
        path = Path(getattr(api.session, attribute, "") or "")
        if not path.is_file():
            continue
        backup = path.with_suffix(path.suffix + ".relogin")
        try:
            shutil.copy2(path, backup)
            saved.append((path, backup))
        except OSError:
            pass
    return saved


def restore_session(saved: list[tuple[Path, Path]]) -> None:
    for path, backup in saved:
        try:
            shutil.copy2(backup, path)
        except OSError:
            pass


def open_api_safe(account: dict, attempts: int = 3):
    """open_api that cannot hang: 120 s per attempt, then a fresh exit IP."""
    last = None
    for attempt in range(attempts):
        signal.alarm(120)
        try:
            api = open_api(account, attempt=attempt)
            signal.alarm(0)
            return api
        except AccountTimeout:
            signal.alarm(0)
            last = AccountTimeout("auth timeout")
            log("account", account.get("email"), "auth timeout, rotating exit")
        except Exception as error:  # noqa: BLE001
            signal.alarm(0)
            last = error
            log("account", account.get("email"), "auth failed", type(error).__name__, str(error)[:80])
    raise RuntimeError(f"api unavailable: {type(last).__name__ if last else 'unknown'}")


_session_local = threading.local()


def download_session() -> requests.Session:
    """One keep-alive session per worker thread.

    A fresh TLS connection per 2 MB photo cost ~0.5 s of handshake; reusing
    the connection is what took the throughput from 42 KB/s to the line rate
    on small files.
    """
    session = getattr(_session_local, "session", None)
    if session is None:
        session = requests.Session()
        adapter = HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=0)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        session.headers.update({"Cookie": "", "Connection": "keep-alive"})
        _session_local.session = session
    return session


def download_one(item: dict, proxies: list[str], position: int, dest: Path, refresher=None):
    """Download straight to the file the gallery serves.

    Writing into Photos/... means the image is visible in the dashboard the
    moment it finishes; the ZIP is built from those files afterwards, so a
    batch never has to be "unzipped" before it appears.
    """
    last = None
    for attempt in range(4):
        proxy = proxies[(position + attempt) % len(proxies)] if proxies else None
        url = item["url"]
        try:
            r = download_session().get(
                url,
                proxies={"http": proxy, "https": proxy} if proxy else None,
                timeout=(20, 120),
                headers={"Cookie": ""},
                stream=True,
            )
            if r.status_code in (403, 410):
                new_url = refresher(item) if refresher else None
                if new_url:
                    item["url"] = new_url
                    r.close()
                    continue
            r.raise_for_status()
            dest.parent.mkdir(parents=True, exist_ok=True)
            partial = dest.with_name(dest.name + ".part")
            with partial.open("wb") as stream:
                for chunk in r.iter_content(1 << 20):
                    if chunk:
                        stream.write(chunk)
            r.close()
            size = partial.stat().st_size
            if item["size"] and size != item["size"]:
                partial.unlink(missing_ok=True)
                raise RuntimeError(f"short {size}/{item['size']}")
            partial.replace(dest)
            return True, size, ""
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(0.5 * (attempt + 1))
    return False, 0, type(last).__name__ if last else "error"


def _photo_db(email: str):
    path = EXPORT / email / "manifest.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    # Autocommit: a 500-file batch used to hold the write lock for its whole
    # run, so the notes/Drive passes on the same account died with
    # "database is locked" (and a finished note was never recorded).
    db = sqlite3.connect(str(path), check_same_thread=False, timeout=60, isolation_level=None)
    db.execute("PRAGMA busy_timeout=60000")
    db.execute(
        """CREATE TABLE IF NOT EXISTS files (
            key TEXT PRIMARY KEY, area TEXT NOT NULL, path TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'done', updated TEXT NOT NULL)"""
    )
    return db


def _mark_photo(db, asset_id: str, area: str, dest: Path, size: int) -> None:
    db.execute(
        """INSERT INTO files(key, area, path, size, sha256, status, updated)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET area=excluded.area, path=excluded.path,
             size=excluded.size, status=excluded.status, updated=excluded.updated""",
        (f"photo:{asset_id}", area, str(dest), int(size), "", "done",
         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
    )


def load_index(email: str) -> dict:
    path = EXPORT / email / "zips" / "index.json"
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {"email": email, "batches": [], "failed": []}


def save_index(email: str, index: dict) -> None:
    folder = EXPORT / email / "zips"
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "index.json.tmp"
    tmp.write_text(json.dumps(index, indent=2))
    tmp.replace(folder / "index.json")


def album_folder(item: dict) -> str:
    area = item.get("area")
    if area == "Hidden":
        return "Hidden"
    if area == "Recently Deleted":
        return "Recently Deleted"
    return "Library"


def area_key(item: dict) -> str:
    area = item.get("area")
    if area == "Hidden":
        return "hidden"
    if area == "Recently Deleted":
        return "deleted"
    return "photos"


def photo_dest(email: str, item: dict) -> Path:
    """Where an asset lives in the tree the panel reads."""
    return (
        EXPORT
        / email
        / "Photos"
        / album_folder(item)
        / f"{item['id'][:8]}_{item['filename']}"
    )


def on_disk(email: str, item: dict) -> bool:
    """True only when the bytes are really there (size checked).

    `zipped` used to mean "the index lists this id", so a ZIP deleted before
    it was extracted lost its photos for good: every later run skipped them.
    """
    for candidate in (photo_dest(email, item),):
        try:
            if candidate.exists() and (
                not item["size"] or candidate.stat().st_size == item["size"]
            ):
                return True
        except OSError:
            pass
    return False


def zip_batch(email: str, batch: list[dict], manifest: dict, proxies: list[str], index: dict, refresher=None) -> dict:
    folder = EXPORT / email / "zips"
    folder.mkdir(parents=True, exist_ok=True)

    sources: list[tuple[dict, Path | None]] = []
    to_download: list[tuple[int, dict, Path]] = []
    for position, item in enumerate(batch):
        dest = photo_dest(email, item)
        existing = manifest.get(item["id"])
        if existing:
            path = Path(existing[0])
            if path.exists() and (not item["size"] or path.stat().st_size == item["size"]):
                sources.append((item, path))
                continue
        if dest.exists() and (not item["size"] or dest.stat().st_size == item["size"]):
            sources.append((item, dest))
            continue
        sources.append((item, None))
        to_download.append((position, item, dest))

    downloaded: dict[int, Path] = {}
    failures: list[dict] = []
    db = _photo_db(email)
    if to_download:
        pool = ThreadPoolExecutor(max_workers=WORKERS)
        futures = {
            pool.submit(download_one, item, proxies, pos, dest, refresher): (pos, item, dest)
            for pos, item, dest in to_download
        }
        try:
            for future in as_completed(futures, timeout=BATCH_TIMEOUT):
                pos, item, dest = futures[future]
                try:
                    ok, size, error = future.result()
                except Exception as exc:  # noqa: BLE001
                    ok, size, error = False, 0, type(exc).__name__
                if ok:
                    downloaded[pos] = dest
                    _mark_photo(db, item["id"], area_key(item), dest, size)
                else:
                    failures.append({"id": item["id"], "error": error})
        except FutureTimeout:
            for future, (pos, item, dest) in futures.items():
                if not future.done():
                    failures.append({"id": item["id"], "error": "batch timeout"})
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    db.commit()
    db.close()

    ready = []
    vanished: list[tuple[int, dict]] = []
    for pos, (item, path) in enumerate(sources):
        if path is None:
            path = downloaded.get(pos)
        if path is None:
            continue
        if not path.exists():
            # The prune can move a file to S4 between the check and the ZIP;
            # a missing source must cost one file, never the whole account.
            vanished.append((pos, item))
            continue
        ready.append((item, path))
    if vanished:
        log("account", email, "re-download", len(vanished), "vanished files")
        again = ThreadPoolExecutor(max_workers=min(WORKERS, len(vanished)))
        futures = {
            again.submit(download_one, item, proxies, pos, photo_dest(email, item), refresher): (pos, item)
            for pos, item in vanished
        }
        try:
            for future in as_completed(futures, timeout=BATCH_TIMEOUT):
                pos, item = futures[future]
                try:
                    ok, size, error = future.result()
                except Exception as exc:  # noqa: BLE001
                    ok, size, error = False, 0, type(exc).__name__
                if ok:
                    ready.append((item, photo_dest(email, item)))
                else:
                    failures.append({"id": item["id"], "error": error})
        except FutureTimeout:
            for future, (pos, item) in futures.items():
                if not future.done():
                    failures.append({"id": item["id"], "error": "batch timeout"})
        finally:
            again.shutdown(wait=False, cancel_futures=True)
    if not ready:
        return {"count": 0, "bytes": 0, "failures": failures, "ids": []}

    number = len(index["batches"]) + 1
    name = f"images-{number:04d}.zip"
    zip_path = folder / name
    written: list[tuple[dict, Path]] = []
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for item, path in ready:
            try:
                zf.write(path, arcname=f"{item['id'][:8]}_{item['filename']}")
                written.append((item, path))
            except FileNotFoundError:
                failures.append({"id": item["id"], "error": "vanished before zip"})
    ready = written

    entry = {
        "file": name,
        "count": len(ready),
        "bytes": zip_path.stat().st_size,
        "ids": [item["id"] for item, _ in ready],
        "areas": {
            item["id"]: album_folder(item)
            for item, _ in ready
        },
        # The files are already in Photos/, so extraction is only needed for
        # older batches; mark this ZIP as extracted to keep the panel fast.
        "extracted": True,
    }
    index["batches"].append(entry)
    index["failed"] = failures
    index["unzipped"] = False
    save_index(email, index)
    return {"count": len(ready), "bytes": entry["bytes"], "failures": failures, "ids": entry["ids"]}


ALBUMS = ("Hidden", "Recently Deleted", "Library")


def album_paths(email: str, album: str):
    folder = EXPORT / email / "zips"
    folder.mkdir(parents=True, exist_ok=True)
    slug = album.replace(" ", "_").lower()
    return folder / f"urls-{slug}.jsonl", folder / f"urls-{slug}.meta.json"


def album_items(email: str, album: str):
    path, _ = album_paths(email, album)
    if not path.exists():
        return None
    try:
        # Signed CloudKit URLs expire.  Sending an 11-hour-old list means
        # every file is a 403/410 and the batch spends its time asking
        # CloudKit for a fresh URL (one request per image).  Treat a stale
        # list as absent so the album is enumerated again.
        if time.time() - path.stat().st_mtime > URL_MAX_AGE:
            return None
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except Exception:
        return None


def enumerate_album(api, email: str, album_name: str):
    """Phase A for one album; writes signed URLs to disk as it goes."""
    path, meta_path = album_paths(email, album_name)
    tmp = path.with_suffix(".tmp")
    files = 0
    videos = 0
    seen = 0
    with tmp.open("w") as out:
        try:
            album = api.photos.albums[album_name]
        except Exception:
            album = []
        log("account", email, "reading", album_name)
        for asset in album:
            seen += 1
            if seen % 2000 == 0:
                # A 55k-photo album can take 40+ minutes to enumerate.  The
                # watchdog needs a sign of life before the first ZIP.
                log("account", email, "reading", album_name, seen, "assets")
            asset_id = str(getattr(asset, "id", "") or "")
            if not asset_id:
                continue
            versions = getattr(asset, "versions", {}) or {}
            original = versions.get("original") or {}
            filename = str(original.get("filename") or getattr(asset, "filename", "") or "")
            is_video = Path(filename).suffix.lower() in VIDEO_EXT
            if is_video:
                videos += 1
                if not want_video(album_name):
                    continue
            url = original.get("url")
            if not url:
                continue
            files += 1
            out.write(
                json.dumps(
                    {
                        "id": asset_id,
                        "filename": filename or f"{asset_id}.bin",
                        "size": int(original.get("size") or getattr(asset, "size", 0) or 0),
                        "area": album_name,
                        "url": url,
                    }
                )
                + "\n"
            )
    if files == 0 and videos == 0:
        # An album call that failed while another process used the session
        # used to be cached as "empty", which silently skipped Hidden.
        # Re-read it once before believing the zero.
        try:
            again = api.photos.albums[album_name]
            with tmp.open("w") as out:
                for asset in again:
                    asset_id = str(getattr(asset, "id", "") or "")
                    if not asset_id:
                        continue
                    versions = getattr(asset, "versions", {}) or {}
                    original = versions.get("original") or {}
                    filename = str(original.get("filename") or getattr(asset, "filename", "") or "")
                    is_video = Path(filename).suffix.lower() in VIDEO_EXT
                    if is_video:
                        videos += 1
                        if not want_video(album_name):
                            continue
                    url = original.get("url")
                    if not url:
                        continue
                    files += 1
                    out.write(
                        json.dumps(
                            {
                                "id": asset_id,
                                "filename": filename or f"{asset_id}.bin",
                                "size": int(original.get("size") or getattr(asset, "size", 0) or 0),
                                "area": album_name,
                                "url": url,
                            }
                        )
                        + "\n"
                    )
        except Exception:
            pass
    tmp.replace(path)
    meta_path.write_text(json.dumps({"files": files, "videos": videos}))
    log("account", email, "urls ready", album_name, files, "files", videos, "videos")
    return files


def clear_albums(email: str) -> None:
    for album in ALBUMS:
        path, meta = album_paths(email, album)
        path.unlink(missing_ok=True)
        meta.unlink(missing_ok=True)


# Space below this is not enough to start another account.
PLACE_FREE = 40 * 1024**3
OVERFLOW = ROOT / "export-overflow"


def place_account(email: str) -> None:
    """Make sure this account has room on the export disk.

    export/ lives on the second 1.8 TB disk.  When it gets close to full the
    account tree is moved to export-overflow/ (the system disk) and a symlink
    is left at the original path, so every reader keeps using export/<email>.
    """
    path = EXPORT / email
    if path.is_symlink():
        return
    try:
        usage = shutil.disk_usage(EXPORT)
    except OSError:
        return
    free = f"{usage.free / 1024**3:.0f} GB free"
    if usage.free >= PLACE_FREE:
        log("place", email, "on second disk", free)
        return

    OVERFLOW.mkdir(parents=True, exist_ok=True)
    dest = OVERFLOW / email
    if dest.exists():
        # A previous run already moved the tree here; re-point the export path.
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
        if not path.exists():
            os.symlink(dest, path)
        log("place", email, "on overflow disk", free)
        return
    if not path.is_dir():
        log("place", email, "on second disk", free)
        return
    # Never move a tree that a batch is still writing into.
    zips = path / "zips"
    if zips.is_dir() and any(zips.glob("tmp-*")):
        log("place", email, "on second disk (batch running)", free)
        return
    started = time.time()
    try:
        shutil.move(str(path), str(dest))
        os.symlink(dest, path)
    except Exception as error:  # noqa: BLE001
        log("place", email, "move failed", type(error).__name__, free)
        return
    log(
        "place",
        email,
        "on overflow disk",
        free,
        f"moved in {time.time() - started:.0f}s",
    )


def process_account(account: dict, proxies: list[str]) -> dict:
    email = account["email"]
    log("account", email, "start")
    place_account(email)
    folder = EXPORT / email / "zips"
    folder.mkdir(parents=True, exist_ok=True)
    index = load_index(email)
    manifest = manifest_photos(email)
    zipped = {asset_id for batch in index["batches"] for asset_id in batch.get("ids", [])}

    api = None
    live_ids: set[str] = set()
    videos = 0
    downloaded = 0
    zipped_bytes = 0
    failures: list[dict] = []

    def refresher(item):
        nonlocal api
        try:
            if api is None:
                api = open_api_safe(account)
            album = api.photos.albums[item["area"]]
            asset = album.get(item["id"])
            versions = getattr(asset, "versions", {}) or {}
            return (versions.get("original") or {}).get("url")
        except Exception:
            return None

    def download(items):
        nonlocal downloaded, zipped_bytes
        # A file on disk is done; everything else is fetched, even when the
        # index already lists it (its ZIP may have been deleted unextracted).
        pending = [item for item in items if not on_disk(email, item)]
        for start in range(0, len(pending), BATCH):
            chunk = pending[start : start + BATCH]
            usage = shutil.disk_usage(EXPORT)
            if usage.free < MIN_FREE:
                raise RuntimeError(f"low disk: {usage.free / 1024**3:.1f} GB free")
            result = zip_batch(email, chunk, manifest, proxies, index, refresher)
            downloaded += result["count"]
            zipped_bytes += result["bytes"]
            failures.extend(result["failures"])
            zipped.update(item["id"] for item in chunk)
            log(
                "account",
                email,
                "zip",
                result["count"],
                "files",
                f"{result['bytes'] / 1e6:.0f} MB",
            )

    album_order = (ONLY_ALBUM,) if ONLY_ALBUM else ALBUMS
    for album_name in album_order:
        items = album_items(email, album_name)
        if items is None:
            if api is None:
                api = open_api_safe(account)
            enumerate_album(api, email, album_name)
            items = album_items(email, album_name) or []
        live_ids.update(item["id"] for item in items)
        videos += sum(1 for item in items if Path(item["filename"]).suffix.lower() in VIDEO_EXT)
        download(items)

    new_ids = sorted(live_ids - set(manifest))
    deleted_ids = sorted(set(manifest) - live_ids)

    if api is None:
        try:
            api = open_api_safe(account)
        except Exception as error:  # noqa: BLE001
            log("account", email, "session gone", type(error).__name__)
            api = None
    try:
        if api is None:
            raise RuntimeError("no session")
        drive_live = live_drive_ids(api)
        drive_manifest = manifest_drive_ids(email)
        drive_new = sorted(drive_live - drive_manifest)
        drive_missing = sorted(drive_manifest - drive_live)
    except Exception as error:  # noqa: BLE001
        drive_live, drive_new, drive_missing = set(), [], []
        log("account", email, "drive check failed", type(error).__name__)

    report = {
        "email": email,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "images": len(live_ids),
        "videosSkipped": videos,
        "existing": len(live_ids) - len(new_ids),
        "new": len(new_ids),
        "deleted": len(deleted_ids),
        "downloaded": downloaded,
        "zippedBytes": zipped_bytes,
        "batches": len(index["batches"]),
        "failures": failures,
        "driveLive": len(drive_live),
        "driveNew": len(drive_new),
        "driveMissing": len(drive_missing),
        "newIds": new_ids[:200],
        "deletedIds": deleted_ids[:200],
        "driveNewIds": drive_new[:200],
        "driveMissingIds": drive_missing[:200],
    }
    (folder / "report.json").write_text(json.dumps(report, indent=2))
    if not failures:
        clear_albums(email)
    log(
        "account",
        email,
        "done files",
        report["images"],
        "videos",
        report["videosSkipped"],
        "new",
        report["new"],
        "deleted",
        report["deleted"],
        "zips",
        report["batches"],
        "failures",
        len(failures),
        "drive new",
        report["driveNew"],
        "missing",
        report["driveMissing"],
    )
    return report


def main() -> None:
    global BATCH, WORKERS, LOCK, REPORT, INCLUDE_VIDEOS, INCLUDE_VIDEOS_ALL, ONLY_ALBUM
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", help="comma-separated account email(s)")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=WORKERS)
    parser.add_argument("--batch", type=int, default=BATCH)
    parser.add_argument("--shard", help="i/n: run only this shard of the account list")
    parser.add_argument("--videos", action="store_true", help="include videos in Hidden / Recently Deleted")
    parser.add_argument(
        "--videos-all",
        action="store_true",
        help="include videos in every album (Library clips are large; run this last)",
    )
    parser.add_argument("--only-hidden", action="store_true", help="export only the Hidden album")
    parser.add_argument(
        "--only",
        choices=list(ALBUMS),
        help='export only one album, e.g. --only "Recently Deleted"',
    )
    args = parser.parse_args()
    WORKERS = max(1, args.workers)
    BATCH = max(1, args.batch)
    INCLUDE_VIDEOS = bool(args.videos or args.videos_all)
    INCLUDE_VIDEOS_ALL = bool(args.videos_all)
    ONLY_ALBUM = args.only or ("Hidden" if args.only_hidden else "")

    shard_index, shard_count = 0, 1
    if args.shard:
        left, _, right = args.shard.partition("/")
        shard_index, shard_count = int(left), max(1, int(right or 1))
        if shard_count > 1 and not os.environ.get("BULK_LOCK"):
            LOCK = Path(f"/tmp/bulk_images-{shard_index}.lock")
            REPORT = STATE / f"bulk_report-{shard_index}.json"

    if LOCK.exists():
        try:
            pid = int(LOCK.read_text().strip())
            os.kill(pid, 0)
            raise SystemExit(f"already running (pid {pid})")
        except (ValueError, ProcessLookupError):
            LOCK.unlink(missing_ok=True)
    LOCK.write_text(str(os.getpid()))

    proxies = load_proxies()
    accounts = load_accounts()
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [item for item in accounts if item["email"].lower() in wanted]
    if args.limit:
        accounts = accounts[: args.limit]
    if shard_count > 1:
        # Balance by image count so both shards finish together.
        buckets: list[list[dict]] = [[] for _ in range(shard_count)]
        weights = [0] * shard_count
        ordered = sorted(
            accounts,
            key=lambda account: int((account.get("counts") or {}).get("images") or 0),
            reverse=True,
        )
        for account in ordered:
            target = min(range(shard_count), key=lambda index: weights[index])
            buckets[target].append(account)
            weights[target] += int((account.get("counts") or {}).get("images") or 0)
        accounts = buckets[shard_index]
    log(
        "start",
        len(accounts),
        "accounts",
        len(proxies),
        "proxies",
        "batch",
        BATCH,
        "workers",
        WORKERS,
        "shard",
        f"{shard_index}/{shard_count}",
    )
    reports = []
    if REPORT.exists():
        try:
            reports = json.loads(REPORT.read_text())
        except Exception:
            reports = []
    known = {row.get("email"): position for position, row in enumerate(reports) if isinstance(row, dict)}
    try:
        signal.signal(signal.SIGALRM, _alarm)
        for account in accounts:
            try:
                # A single CloudKit page can hang for ever behind a proxy;
                # abort the account and let the retry pass pick it up.
                signal.alarm(7200)
                try:
                    result = process_account(account, proxies)
                finally:
                    signal.alarm(0)
            except Exception as error:  # noqa: BLE001
                log("account", account.get("email"), "failed", type(error).__name__, str(error)[:200])
                result = {
                    "email": account.get("email"),
                    "error": f"{type(error).__name__}: {error}",
                }
            if account.get("email") in known:
                reports[known[account["email"]]] = result
            else:
                known[account.get("email")] = len(reports)
                reports.append(result)
            REPORT.write_text(json.dumps(reports, indent=2))
    finally:
        LOCK.unlink(missing_ok=True)
        good = [item for item in reports if "error" not in item]
        log(
            "finish",
            len(good),
            "ok",
            len(reports) - len(good),
            "failed",
            "images",
            sum(item.get("images", 0) for item in good),
            "zips",
            sum(item.get("batches", 0) for item in good),
            "bytes",
            sum(item.get("zippedBytes", 0) for item in good),
        )


if __name__ == "__main__":
    main()
