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
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import socketio

from . import auth, exporter, import_out, inventory, scan, session_vault, verify
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
        self.scan_pool = ThreadPoolExecutor(
            max_workers=config.max_scan_jobs, thread_name_prefix="scan"
        )
        self.jobs: dict[str, dict] = {}
        self.locks: dict[str, threading.Lock] = {}
        self.lock_guard = threading.Lock()
        self.running = {"auth": 0, "export": 0, "scan": 0}
        self.stopping = False

    def slots(self) -> dict:
        return {
            "auth": max(0, self.config.max_auth_jobs - self.running["auth"]),
            "export": max(0, self.config.max_export_jobs - self.running["export"]),
            "scan": max(0, self.config.max_scan_jobs - self.running["scan"]),
        }

    def ready(self) -> None:
        self.emitter.send("worker:ready", {"slots": self.slots()})

    def _lock_for(self, email: str) -> threading.Lock:
        with self.lock_guard:
            return self.locks.setdefault(email.lower(), threading.Lock())

    def _hold(self, key: str, what: str, timeout: float) -> tuple[threading.Lock, bool]:
        """Take the per-account lock, but never wait on it forever.

        A verify job can spend minutes enumerating a large library.  Notes are
        tiny and must not sit behind it, so a long-running lock holder only
        delays the other job briefly; both then run their own pyicloud Service
        instance and simply share the session file.
        """
        lock = self._lock_for(key)
        acquired = lock.acquire(timeout=timeout)
        if not acquired:
            log.warning(
                "%s for %s waited %.0fs for the account lock; running concurrently",
                what,
                key,
                timeout,
            )
        return lock, acquired

    @staticmethod
    def _release(lock: threading.Lock, acquired: bool) -> None:
        if acquired:
            try:
                lock.release()
            except RuntimeError:
                pass

    def finish_auth(self, job_id: str) -> None:
        if self.jobs.pop(job_id, None) is None:
            return
        self.running["auth"] = max(0, self.running["auth"] - 1)
        self.ready()

    def watch_auth(self, job_id: str, ctx, timeout_s: int) -> None:
        """Free the slot even if the login never answers.

        Apple can leave a request open for a very long time; the account then
        looks "auth" for ever and the panel spins.  After the deadline the job
        is failed cleanly, so the operator sees an error and can retry.
        """
        def hit():
            if job_id not in self.jobs:
                return
            log.warning("auth %s exceeded %ss; failing the job", job_id[:8], timeout_s)
            self.finish_auth(job_id)
            try:
                ctx.emit("job:error", {"error": "timeout", "message": f"no answer in {timeout_s}s"})
            except Exception:
                pass

        timer = threading.Timer(max(30, timeout_s), hit)
        timer.daemon = True
        timer.start()

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
            lock, acquired = self._hold(key, f"auth {key}", 120)
            try:
                auth.run_auth(ctx)
            except Exception as error:
                log.warning("auth job crashed: %s\n%s", type(error).__name__, traceback.format_exc())
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self._release(lock, acquired)
                self.finish_auth(job_id)

        # One dedicated thread per login, not a shared pool: a wedged pyicloud
        # call must never consume a slot that another account is waiting for.
        threading.Thread(target=work, name=f"auth-{job_id[:8]}", daemon=True).start()
        self.watch_auth(job_id, ctx, self.config.auth_timeout_s)

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
            lock, held = self._hold(key, "export", 90.0)
            try:
                self._run_export(ctx, payload)
            except Exception as error:
                log.warning("export job crashed: %s\n%s", type(error).__name__, traceback.format_exc())
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self._release(lock, held)
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

    def start_import(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id or job_id in self.jobs:
            return
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "import", "ctx": ctx}
        self.running["export"] += 1
        self.ready()

        def work():
            try:
                with self._lock_for(key):
                    import_out.run_import(ctx, payload)
            except Exception as error:
                log.warning("import job crashed: %s\n%s", type(error).__name__, traceback.format_exc())
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self.jobs.pop(job_id, None)
                self.running["export"] = max(0, self.running["export"] - 1)
                self.ready()

        self.export_pool.submit(work)

    def start_scan(self, payload: dict) -> None:
        job_id = payload.get("jobId")
        if not job_id or job_id in self.jobs:
            return
        ctx = auth.JobContext(job_id, payload, self.emitter)
        key = ctx.account.get("email", "")
        self.jobs[job_id] = {"type": "scan", "ctx": ctx}
        self.running["scan"] += 1
        self.ready()

        def work():
            lock, held = self._hold(key, "scan", 30.0)
            try:
                scan.run_scan(ctx, payload)
            except Exception as error:
                log.warning("scan job crashed: %s\n%s", type(error).__name__, traceback.format_exc())
                ctx.emit("job:error", {"error": type(error).__name__})
            finally:
                self._release(lock, held)
                self.jobs.pop(job_id, None)
                self.running["scan"] = max(0, self.running["scan"] - 1)
                self.ready()

        self.scan_pool.submit(work)

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
                log.warning("verify job crashed: %s\n%s", type(error).__name__, traceback.format_exc())
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
        # A ping shares the auth slots, so it must count against them or the
        # server keeps seeing free slots and dispatches an unbounded burst.
        self.running["auth"] += 1

        def work():
            lock = None
            held = False
            try:
                # Never block an auth slot on another job's per-account lock:
                # a verify that is walking a huge library holds it for minutes,
                # and ten blocked pings starve the whole queue (slots read 0).
                lock, held = self._hold(key, "ping", 45.0)
                api, _ = auth._service(ctx, ctx.account.get("password", ""))
                auth._apply_proxy(api, ctx)
                ok, trusted, limited = auth.check_alive(api, ctx)
                result = {
                    "ok": ok,
                    "trusted": trusted,
                    "limited": limited,
                    "error": "" if ok else "session invalid",
                }
                if limited:
                    result["error"] = "limited: web token missing (browser refresh needed)"
                if ok:
                    # A ping is also the cheap way to refresh the counters the
                    # panel shows (album lengths, contacts, mail, ...); the
                    # full verify stays for the diff.
                    try:
                        counts = inventory.quick_counts(api)
                        if counts:
                            result["counts"] = counts
                    except Exception as error:
                        log.info("ping counts skipped: %s", type(error).__name__)
                ctx.emit("job:ping_result", result)
            except Exception as error:
                ctx.emit("job:ping_result", {"ok": False, "error": type(error).__name__})
            finally:
                if lock is not None:
                    self._release(lock, held)
                self.jobs.pop(job_id, None)
                self.running["auth"] = max(0, self.running["auth"] - 1)
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
    async def disconnect(reason=None):
        # The reason (ping timeout, transport error, server disconnect) is
        # what tells an operator why an export job was requeued.
        log.info("disconnected: %s", reason)

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

    @sio.on("job:import", namespace="/worker")
    async def job_import(payload):
        manager.start_import(payload or {})

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
    vault_stop = threading.Event()

    def vault_loop() -> None:
        """Snapshot every session every 10 minutes; the immediate snapshot
        after a login still happens in auth._finish."""
        while not vault_stop.is_set():
            try:
                session_vault.snapshot_all(config.sessions_dir)
            except Exception as error:
                log.info("vault pass skipped: %s", error)
            vault_stop.wait(600)

    threading.Thread(target=vault_loop, name="session-vault", daemon=True).start()

    def stop(*_args):
        vault_stop.set()
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
