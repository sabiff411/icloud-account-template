"""Durable, verified snapshots of an iCloud session.

The cookie jar is the only thing standing between a captured account and a
second 2FA prompt.  This module keeps it:

  * snapshots every ``*.session`` / ``*.cookiejar`` file,
  * stores a sha256 manifest and only adds a snapshot when something changed,
  * optionally encrypts with AES-256-GCM (``SESSION_VAULT_KEY``),
  * keeps the last N snapshots and a ``latest`` pointer,
  * restores the newest valid snapshot into an empty session dir,
  * verifies a snapshot against its manifest.

Nothing here talks to iCloud or the store; it is safe to call from any job,
from a timer, or from the CLI::

    PYTHONPATH=python python3 -m worker.session_vault --backup-all --sessions-root sessions
    PYTHONPATH=python python3 -m worker.session_vault --restore you@example.com --sessions-root sessions
    PYTHONPATH=python python3 -m worker.session_vault --verify-all
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:  # AES-GCM is optional: without a key the vault is durable but plaintext
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # pragma: no cover - only when the dependency is absent
    AESGCM = None  # type: ignore

MAGIC = b"SV1"
SESSION_SUFFIXES = (".session", ".cookiejar", ".cookies")
DEFAULT_KEEP = 30
_LOCK_NAME = ".vault.lock"


def _root(vault: str | Path | None = None) -> Path:
    return Path(vault or os.environ.get("SESSION_VAULT_DIR", "sessions-vault"))


def _keep(keep: int | None = None) -> int:
    if keep:
        return max(3, int(keep))
    try:
        return max(3, int(os.environ.get("SESSION_VAULT_KEEP", DEFAULT_KEEP)))
    except ValueError:
        return DEFAULT_KEEP


def _key() -> bytes | None:
    passphrase = os.environ.get("SESSION_VAULT_KEY", "").strip()
    if not passphrase:
        return None
    if AESGCM is None:
        raise RuntimeError("SESSION_VAULT_KEY is set but cryptography is not installed")
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), b"session-vault-v1", 200_000, dklen=32)


def _session_files(session_dir: Path) -> list[Path]:
    return sorted(
        p for p in session_dir.iterdir()
        if p.is_file() and p.name.endswith(SESSION_SUFFIXES)
    )


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _encode(data: bytes, key: bytes | None) -> bytes:
    if key is None:
        return data
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, data, None)


def _decode(data: bytes, key: bytes | None) -> bytes:
    if key is None:
        return data
    if not data.startswith(MAGIC):
        # A plaintext snapshot from before the key was added.
        return data
    nonce, body = data[len(MAGIC):len(MAGIC) + 12], data[len(MAGIC) + 12:]
    return AESGCM(key).decrypt(nonce, body, None)


def _latest(vault_dir: Path) -> Path | None:
    link = vault_dir / "latest"
    try:
        target = link.resolve()
        if target.is_dir():
            return target
    except OSError:
        pass
    snapshots = sorted(p for p in vault_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
    return snapshots[-1] if snapshots else None


def verify(snapshot: Path, key: bytes | None = None) -> tuple[bool, list[str]]:
    """Check every file against the manifest.  Returns (ok, errors)."""
    errors: list[str] = []
    try:
        manifest = json.loads((snapshot / "manifest.json").read_text())
    except (OSError, ValueError) as error:
        return False, [f"manifest: {error}"]
    key = key if key is not None else _key()
    for row in manifest.get("files") or []:
        name = row.get("name") or ""
        path = snapshot / name
        if not path.exists():
            errors.append(f"{name}: missing")
            continue
        try:
            data = _decode(path.read_bytes(), key)
        except Exception as error:  # wrong key / truncated file
            errors.append(f"{name}: cannot decode ({type(error).__name__})")
            continue
        if hashlib.sha256(data).hexdigest() != row.get("sha256"):
            errors.append(f"{name}: hash mismatch")
        elif len(data) != row.get("bytes"):
            errors.append(f"{name}: length mismatch")
    return (not errors), errors


def snapshot(session_dir: str | Path, email: str = "", vault: str | Path | None = None,
             keep: int | None = None) -> Path | None:
    """Snapshot the session dir if it changed.  Returns the snapshot dir or None."""
    session_dir = Path(session_dir)
    files = _session_files(session_dir)
    if not files:
        return None

    vault_dir = _root(vault) / session_dir.name
    vault_dir.mkdir(parents=True, exist_ok=True)
    key = _key()

    import fcntl  # Linux only; the worker runs on Linux

    lock_path = vault_dir / _LOCK_NAME
    with open(lock_path, "w") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            digests = {p.name: _digest(p) for p in files}
            previous = _latest(vault_dir)
            if previous:
                try:
                    old = json.loads((previous / "manifest.json").read_text())
                    old_map = {row["name"]: row["sha256"] for row in old.get("files") or []}
                    if old_map == digests:
                        return previous
                except (OSError, ValueError, KeyError):
                    pass

            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            temp = vault_dir / f".{stamp}.tmp"
            temp.mkdir(parents=True, exist_ok=True)
            manifest = {
                "email": email,
                "created": stamp,
                "encrypted": key is not None,
                "files": [],
            }
            for path in files:
                raw = path.read_bytes()
                (temp / path.name).write_bytes(_encode(raw, key))
                manifest["files"].append({
                    "name": path.name,
                    "bytes": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                })
            (temp / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True))
            final = vault_dir / stamp
            temp.rename(final)

            link = vault_dir / "latest"
            try:
                if link.is_symlink() or link.exists():
                    link.unlink()
                link.symlink_to(final.name)
            except OSError:
                pass

            snapshots = sorted(p for p in vault_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
            for old in snapshots[:-_keep(keep)]:
                shutil.rmtree(old, ignore_errors=True)
            return final
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def restore(session_dir: str | Path, snapshot_dir: str | Path | None = None,
            vault: str | Path | None = None) -> Path | None:
    """Restore the newest valid snapshot into ``session_dir``."""
    session_dir = Path(session_dir)
    vault_dir = _root(vault) / session_dir.name
    snap = Path(snapshot_dir) if snapshot_dir else _latest(vault_dir)
    if not snap or not snap.is_dir():
        return None
    ok, errors = verify(snap)
    if not ok:
        # try the one before latest
        candidates = sorted(p for p in vault_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
        for candidate in reversed(candidates[:-1]):
            ok, errors = verify(candidate)
            if ok:
                snap = candidate
                break
        else:
            raise RuntimeError(f"no valid session snapshot: {'; '.join(errors[:3])}")
    key = _key()
    session_dir.mkdir(parents=True, exist_ok=True)
    for row in json.loads((snap / "manifest.json").read_text()).get("files") or []:
        data = _decode((snap / row["name"]).read_bytes(), key)
        (session_dir / row["name"]).write_bytes(data)
    return snap


def restore_if_empty(session_dir: str | Path, email: str = "", vault: str | Path | None = None) -> Path | None:
    session_dir = Path(session_dir)
    if _session_files(session_dir):
        return None
    return restore(session_dir, vault=vault)


def snapshot_all(sessions_root: str | Path, vault: str | Path | None = None) -> int:
    """Back up every session directory that changed.  Returns snapshots written."""
    root = Path(sessions_root)
    if not root.is_dir():
        return 0
    written = 0
    for session_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        try:
            if snapshot(session_dir, vault=vault):
                written += 1
        except Exception as error:  # one bad dir must not stop the rest
            print(f"[vault] {session_dir.name}: {error}", file=sys.stderr)
    return written


def _cli() -> int:
    parser = argparse.ArgumentParser(description="iCloud session vault")
    parser.add_argument("--sessions-root", default="sessions")
    parser.add_argument("--vault", default=None)
    parser.add_argument("--backup-all", action="store_true")
    parser.add_argument("--restore", metavar="EMAIL")
    parser.add_argument("--verify-all", action="store_true")
    parser.add_argument("--keep", type=int, default=None)
    args = parser.parse_args()

    if args.backup_all:
        count = snapshot_all(args.sessions_root, args.vault)
        print(f"[vault] backed up {count} session(s)")
        return 0

    if args.restore:
        from .proxy import stable_ssid
        target = Path(args.sessions_root) / stable_ssid(args.restore)
        snap = restore(target, vault=args.vault)
        if not snap:
            print(f"[vault] no snapshot for {args.restore}", file=sys.stderr)
            return 1
        print(f"[vault] restored {args.restore} from {snap}")
        return 0

    if args.verify_all:
        root = _root(args.vault)
        bad = 0
        for account in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
            for snap in sorted(p for p in account.iterdir() if p.is_dir() and not p.name.startswith(".")):
                ok, errors = verify(snap)
                if not ok:
                    bad += 1
                    print(f"[vault] BAD {snap}: {'; '.join(errors[:3])}", file=sys.stderr)
        print(f"[vault] verified, {bad} bad snapshot(s)")
        return 1 if bad else 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
