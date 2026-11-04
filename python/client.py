#!/usr/bin/env python3
"""Socket.IO client template.

Connects to the /public namespace by default, sends a hello + an optional
submission, and prints everything the server pushes.  With --admin it connects
to /admin using ADMIN_PASSWORD and lists the first page of submissions.

    pip install -r python/requirements.txt
    python python/client.py
    ADMIN_PASSWORD=change-me-admin python python/client.py --admin

The server address defaults to http://127.0.0.1:4001; override with SOCKET_URL.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os

import socketio

DEFAULT_URL = os.getenv("SOCKET_URL", "http://127.0.0.1:4001")


def pretty(label: str, payload) -> None:
    print(f"[{label}] {json.dumps(payload, ensure_ascii=False)}")


async def run(admin: bool, url: str, email: str | None) -> None:
    namespace = "/admin" if admin else "/public"
    auth = {"password": os.getenv("ADMIN_PASSWORD", "")} if admin else {}
    sio = socketio.AsyncClient(reconnection=True)

    @sio.event(namespace=namespace)
    async def connect() -> None:
        print(f"[connected] {url} {namespace}")

    @sio.event(namespace=namespace)
    async def connect_error(data) -> None:
        print(f"[connect_error] {data}")

    @sio.event(namespace=namespace)
    async def disconnect() -> None:
        print("[disconnected]")

    # The server emits these; registering them keeps the template honest.
    for event in ("public:state", "public:count", "public:notice"):
        sio.on(event, lambda data, e=event: pretty(e, data), namespace=namespace)
    for event in ("admin:ready", "admin:change"):
        sio.on(event, lambda data, e=event: pretty(e, data), namespace=namespace)

    await sio.connect(url, namespaces=[namespace], auth=auth, wait_timeout=10)
    try:
        if admin:
            result = await sio.call(
                "admin:list",
                {"page": 1, "pageSize": 5},
                namespace=namespace,
                timeout=10,
            )
            pretty("admin:list", result)
            stats = await sio.call("admin:stats", {}, namespace=namespace, timeout=10)
            pretty("admin:stats", stats)
            print("[hint] emit admin:update / admin:delete / admin:notice from here.")
        else:
            await sio.call(
                "public:hello",
                {"page": "/sign-in"},
                namespace=namespace,
                timeout=10,
            )
            if email:
                result = await sio.call(
                    "public:submit",
                    {"email": email, "code": "000000", "page": "/verify"},
                    namespace=namespace,
                    timeout=20,
                )
                pretty("public:submit", result)
            print("[hint] press Ctrl-C to disconnect.")

        await sio.wait()
    finally:
        if sio.connected:
            await sio.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin", action="store_true", help="use /admin")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--email", help="send a demo public:submit")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.admin, args.url, args.email))
    except (KeyboardInterrupt, asyncio.CancelledError):
        # Ctrl-C: the client disconnects in run()'s finally block.
        pass


if __name__ == "__main__":
    main()
