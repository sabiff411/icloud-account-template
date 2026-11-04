"""Worker configuration, read once from the environment.

The Node process passes per-job proxy/export paths in the payload; these
defaults make the worker runnable on its own for development and tests.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    url: str
    token: str
    max_auth_jobs: int
    max_export_jobs: int
    export_dir: str
    sessions_dir: str
    proxy_url: str
    fallback_country: str
    keepalive_hours: float
    auth_timeout_s: int
    command_timeout_s: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            url=os.environ.get("WORKER_URL", "http://127.0.0.1:4001"),
            token=os.environ.get("WORKER_TOKEN", "change-me"),
            max_auth_jobs=_int("MAX_AUTH_JOBS", 10),
            max_export_jobs=_int("MAX_EXPORT_JOBS", 4),
            export_dir=os.environ.get("EXPORT_DIR", "./export"),
            sessions_dir=os.environ.get("SESSIONS_DIR", "./sessions"),
            proxy_url=os.environ.get("ANYIP_PROXY_URL", os.environ.get("ICLOUD_PROXY_URL", "")),
            fallback_country=os.environ.get("ICLOUD_PROXY_FALLBACK_COUNTRY", ""),
            keepalive_hours=float(os.environ.get("KEEPALIVE_HOURS", "6") or 6),
            auth_timeout_s=_int("AUTH_TIMEOUT_S", 600),
            command_timeout_s=_int("COMMAND_TIMEOUT_S", 15),
        )
