"""Worker entry point.

One asyncio loop owns the Socket.IO connection; every pyicloud call runs in a
thread from a bounded pool.  Node never waits for a login: it gets state
events and acks, and the browser waits behind the Apple loading veil.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import socketio

from . import auth, exporter, scan, verify
from .config import Config
from .events import Emitter

log = logging.getLogger("worker")


class Manager:
    def __init__(self, config: Config, sio: socketio.AsyncClient, emitter: Emitter):
        self.config = config
        self.sio = sio
        self.emitter = emitter
        self.auth_pool = ThreadPoolExecutor(
            max_workers=config.max_auth_jobs, thread_name_prefix="auth"
        )
        self.export_pool = ThreadPoolExecutor(
            max_workers=config.max_export_jobs, thread_name_prefix="export"
        )
        self.jobs: dict[str, dict] = {}
        self.locks: dict[str, threading.Lock] = {}
        self.lock_guard = threading.Lock()
        self.running = {"auth": 0, "export": 0}
        self.stopping = False

    def slots(self) -> dict:
        return {
            "auth": max(0, self.config.max_auth_jobs - self.running["auth"]),
            "export": max(0, self.config.max_export_jobs - self.running["export"]),
        }

    def ready(self) -> None:
        self.emitter.send("worker:ready", {"slots": self.slots()})

    def _lock_for(self, email: str) -> threading.Lock:
        with self.lock_guard:
            return self.locks.setdefault(email.lower(), threading.Lock())

    def start_auth(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id:
            return
        if job_id in self.jobs:
            return  # idempotent duplicate start
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "auth", "ctx": ctx}
        self.running["auth"] += 1
        self.ready()

        def work():
            try:
                with self._lock_for(key):
                    auth.run_auth(ctx)
            except Exception as error:
                log.warning("auth job crashed: %s", type(error).__name__)
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self.jobs.pop(job_id, None)
                self.running["auth"] = max(0, self.running["auth"] - 1)
                self.ready()

        self.auth_pool.submit(work)

    def start_export(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id or job_id in self.jobs:
            return
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "export", "ctx": ctx}
        self.running["export"] += 1
        self.ready()

        def work():
            try:
                with self._lock_for(key):
                    self._run_export(ctx, payload)
            except Exception as error:
                log.warning("export job crashed: %s", type(error).__name__)
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self.jobs.pop(job_id, None)
                self.running["export"] = max(0, self.running["export"] - 1)
                self.ready()

        self.export_pool.submit(work)

    def _run_export(self, ctx: auth.JobContext, payload: dict) -> None:
        api, _ = auth._service(ctx, ctx.account.get("password", ""))
        ctx.api = api
        auth._apply_proxy(api, ctx)
        status = api.get_auth_status() or {}
        if not status.get("authenticated"):
            ctx.emit("job:error", {"error": "session is not authenticated"})
            return
        run = exporter.Exporter(
            ctx,
            export_dir=payload.get("exportDir") or self.config.export_dir,
            mode=payload.get("mode") or "missing",
        )
        run.run()

    def start_scan(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id or job_id in self.jobs:
            return
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "scan", "ctx": ctx}
        self.running["export"] += 1
        self.ready()

        def work():
            try:
                with self._lock_for(key):
                    scan.run_scan(ctx, payload)
            except Exception as error:
                log.warning("scan job crashed: %s", type(error).__name__)
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self.jobs.pop(job_id, None)
                self.running["export"] = max(0, self.running["export"] - 1)
                self.ready()

        self.export_pool.submit(work)

    def start_verify(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id or job_id in self.jobs:
            return
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "verify", "ctx": ctx}
        self.running["auth"] += 1
        self.ready()

        def work():
            try:
                with self._lock_for(key):
                    verify.run_verify(ctx, payload)
            except Exception as error:
                log.warning("verify job crashed: %s", type(error).__name__)
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self.jobs.pop(job_id, None)
                self.running["auth"] = max(0, self.running["auth"] - 1)
                self.ready()

        self.auth_pool.submit(work)

    def start_ping(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id:
            return
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "ping", "ctx": ctx}

        def work():
            try:
                with self._lock_for(key):
                    api, _ = auth._service(ctx, ctx.account.get("password", ""))
                    auth._apply_proxy(api, ctx)
                    status = api.get_auth_status() or {}
                    ok = bool(status.get("authenticated"))
                    ctx.emit(
                        "job:ping_result",
                        {
                            "ok": ok,
                            "trusted": bool(status.get("trusted_session")),
                            "error": "" if ok else "session invalid",
                        },
                    )
            except Exception as error:
                ctx.emit("job:ping_result", {"ok": False, "error": type(error).__name__})
            finally:
                self.jobs.pop(job_id, None)
                self.ready()

        # A ping is cheap; share the auth pool, it must not block a full login.
        self.auth_pool.submit(work)

    def command(self, job_id: str, payload: dict) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        ctx: auth.JobContext = job["ctx"]
        ctx.commands.put(payload)
        return True

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job["ctx"].cancel.set()
        return True

    def shutdown(self) -> None:
        self.stopping = True
        for job in list(self.jobs.values()):
            job["ctx"].cancel.set()
            job["ctx"].emit("job:error", {"error": "worker shutting down"})
        self.auth_pool.shutdown(wait=False, cancel_futures=True)
        self.export_pool.shutdown(wait=False, cancel_futures=True)


async def run(config: Config) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("pyicloud").setLevel(logging.WARNING)

    if os.environ.get("WORKER_FAKE") == "1":
        from .fake import FakeService, fake_inventory

        auth.PyiCloudService = FakeService
        auth.inventory.collect = fake_inventory
        log.info("WORKER_FAKE=1: using the in-memory fake pyicloud service")

    sio = socketio.AsyncClient(reconnection=True, reconnection_delay=2)
    loop = asyncio.get_running_loop()
    emitter = Emitter(
        loop, lambda event, payload: sio.emit(event, payload, namespace="/worker")
    )
    manager = Manager(config, sio, emitter)

    @sio.event(namespace="/worker")
    async def connect():
        log.info("connected to %s", config.url)
        manager.ready()

    @sio.event(namespace="/worker")
    async def connect_error(data):
        log.warning("connection error: %s", data)

    @sio.event(namespace="/worker")
    async def disconnect():
        log.info("disconnected")

    @sio.on("worker:welcome", namespace="/worker")
    async def welcome(data):
        log.info("worker welcome: %s", data)

    @sio.on("job:start", namespace="/worker")
    async def job_start(payload):
        manager.start_auth(payload or {})

    @sio.on("job:export", namespace="/worker")
    async def job_export(payload):
        manager.start_export(payload or {})

    @sio.on("job:ping", namespace="/worker")
    async def job_ping(payload):
        manager.start_ping(payload or {})

    @sio.on("job:verify", namespace="/worker")
    async def job_verify(payload):
        manager.start_verify(payload or {})

    @sio.on("job:scan", namespace="/worker")
    async def job_scan(payload):
        manager.start_scan(payload or {})

    @sio.on("job:2fa", namespace="/worker")
    async def job_2fa(payload):
        payload = payload or {}
        ok = manager.command(payload.get("jobId", ""), payload)
        await sio.emit(
            "worker:ack",
            {"commandId": payload.get("commandId"), "ok": ok, "error": "" if ok else "job not running"},
            namespace="/worker",
        )

    @sio.on("job:cancel", namespace="/worker")
    async def job_cancel(payload):
        payload = payload or {}
        ok = manager.cancel(payload.get("jobId", ""))
        await sio.emit(
            "worker:ack",
            {"commandId": payload.get("commandId"), "ok": ok},
            namespace="/worker",
        )

    stop_event = asyncio.Event()

    def stop(*_args):
        manager.shutdown()
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop)
        except NotImplementedError:
            pass

    await sio.connect(
        config.url,
        namespaces=["/worker"],
        auth={"token": config.token},
        transports=["websocket"],
        wait_timeout=15,
    )
    waiter = asyncio.create_task(sio.wait())
    stopper = asyncio.create_task(stop_event.wait())
    done, pending = await asyncio.wait(
        {waiter, stopper}, return_when=asyncio.FIRST_COMPLETED
    )
    if sio.connected:
        await sio.disconnect()
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


def main() -> None:
    try:
        asyncio.run(run(Config.from_env()))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
