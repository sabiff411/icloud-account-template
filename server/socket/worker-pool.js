import { randomUUID, createHash } from "node:crypto";
import { config } from "../config.js";

/* Dispatch and relay for the Python workers.
 *
 * Node owns the account/job records and all routing; workers own every
 * blocking call. A job is sent to exactly one worker, and its events are
 * mirrored into the browser rooms (job:<id>, account:<id>). Nothing here
 * awaits a login or a download.
 */

const ACTIVE_ACCOUNT = new Set(["queued", "auth", "twofa", "exporting"]);
const COMMAND_TIMEOUT_MS = 12_000;

function workerSlots(payload) {
  const auth = Number(payload?.slots?.auth);
  const exp = Number(payload?.slots?.export);
  return {
    auth: Number.isFinite(auth) ? Math.max(0, Math.min(auth, 100)) : 0,
    export: Number.isFinite(exp) ? Math.max(0, Math.min(exp, 100)) : 0,
  };
}

function stableSsid(email) {
  return createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16);
}

export class WorkerPool {
  constructor({ io, store, onEvent = () => {} }) {
    this.io = io;
    this.store = store;
    this.onEvent = onEvent;
    this.settings = {
      maxAuthJobs: config.worker.maxAuthJobs,
      maxExportJobs: config.worker.maxExportJobs,
    };
    this.workers = new Map(); // socket.id -> { socket, slots, connectedAt }
    this.queue = []; // job ids waiting for a free slot
    this.commands = new Map(); // commandId -> { resolve, reject, timer }
    this.waitTimers = new Map(); // jobId -> timer
  }

  /* --------------------------------------------------------------- accounting */

  workerView(account) {
    return {
      id: account.id,
      shortId: account.shortId,
      email: account.email,
      password: account.password,
      sessionDir: account.sessionDir,
      fingerprint: account.fingerprint,
      geo: account.geo,
      proxy: account.proxy,
    };
  }

  publicAccount(account) {
    return this.store.publicAccount(account);
  }

  roomFor(job, account) {
    return { job: `job:${job.id}`, account: `account:${account.id}` };
  }

  emitJob(job, _account, event, payload) {
    // Auth events belong to the job room; account-wide events use emitAccount.
    this.io.of("/public").to(`job:${job.id}`).emit(event, payload);
  }

  emitAccount(account, event, payload) {
    this.io.of("/public").to(`account:${account.id}`).emit(event, payload);
  }

  notify(type, payload) {
    try {
      this.onEvent(type, payload);
    } catch (error) {
      console.error("[worker-pool] telegram callback", error.message);
    }
  }

  /* ------------------------------------------------------------- public entry */

  async startAuth({ email, password, fingerprint, geo }) {
    const existing = this.store.activeJobForEmail(email, "auth");
    if (existing) {
      const { account, job } = existing;
      // A second tab attaches to the running job instead of opening the same
      // cookie directory twice.
      if (password) this.store.updateAccount(account.id, { password });
      return { account, job, reused: true };
    }
    if (this.queue.length >= config.worker.maxQueue) {
      throw new Error("the sign-in queue is full; try again shortly");
    }

    const prior = this.store.getAccountByEmail(email);
    const account = prior
      ? this.store.updateAccount(prior.id, {
          password,
          fingerprint,
          geo,
          status: "queued",
          lastError: "",
          sessionDir:
            prior.sessionDir ||
            this.store.sessionDirFor(email, config.icloud.sessionsDir),
          proxy: {
            ...(prior.proxy ?? {}),
            ssid: prior.proxy?.ssid || stableSsid(email),
            country: geo?.countryCode ?? prior.proxy?.country ?? "",
          },
        })
      : this.store.createAccount({
          email,
          password,
          status: "queued",
          sessionDir: this.store.sessionDirFor(email, config.icloud.sessionsDir),
          fingerprint,
          geo,
          proxy: { ssid: stableSsid(email), country: geo?.countryCode ?? "" },
        });
    const job = this.store.createJob({
      accountId: account.id,
      type: "auth",
      payload: { email },
    });
    this.enqueue(job.id);
    this.notify("auth_start", { account, job });
    this.emitJob(job, account, "auth:state", {
      state: "queued",
      jobId: job.id,
      accountId: account.id,
      message: "Queued",
    });
    return { account, job, reused: false };
  }

  async startExport(accountId, { mode = "missing", parentJobId = null } = {}) {
    if (this.queue.length >= config.worker.maxQueue) {
      throw new Error("the export queue is full; try again shortly");
    }
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("account not found");
    const active = this.store.activeJobForAccount(accountId, "export");
    if (active) return { account, job: active, reused: true, parentJobId };
    const job = this.store.createJob({
      accountId,
      type: "export",
      payload: { mode, parentJobId },
    });
    this.store.updateAccount(accountId, {
      status: "exporting",
      export: { ...(account.export ?? {}), phase: "queued" },
    });
    this.enqueue(job.id);
    this.notify("export_start", { account, job, mode });
    return { account, job, reused: false, parentJobId };
  }

  async startPing(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("account not found");
    const active = this.store.activeJobForAccount(accountId, "ping");
    if (active) return { account, job: active, reused: true };
    const job = this.store.createJob({ accountId, type: "ping" });
    this.enqueue(job.id);
    return { account, job, reused: false };
  }

  attachPublicSocket(socket, { job, account }) {
    socket.join(`job:${job.id}`);
    socket.join(`account:${account.id}`);
    socket.data.jobId = job.id;
    socket.data.accountId = account.id;
  }

  /** Replay the current state for a refreshed browser tab. */
  replay(socket, job, account) {
    this.attachPublicSocket(socket, { job, account });
    socket.emit("auth:state", {
      state: account.status,
      jobId: job.id,
      accountId: account.id,
      message: job.message ?? "",
      reused: Boolean(job.reused),
    });
    if (job.twofa) socket.emit("auth:2fa", job.twofa);
    if (job.status === "done") {
      socket.emit("auth:result", { status: "ok", account: this.publicAccount(account) });
    } else if (job.status === "invalid" || job.status === "error") {
      socket.emit("auth:result", {
        status: job.status,
        message: job.error || job.message || "",
      });
    }
    if (account.status === "connected" && account.identity) {
      socket.emit("account:info", { identity: account.identity, counts: account.counts });
    }
    if (account.export?.phase && account.export.phase !== "idle") {
      socket.emit("export:progress", account.export);
    }
  }

  /* ------------------------------------------------------------------- queue */

  enqueue(jobId) {
    if (!this.queue.includes(jobId)) this.queue.push(jobId);
    const job = this.store.getJob(jobId);
    if (job && !this.waitTimers.has(jobId)) {
      const timer = setTimeout(() => {
        this.waitTimers.delete(jobId);
        const current = this.store.getJob(jobId);
        if (current?.status !== "queued") return;
        const account = this.store.getAccount(current.accountId);
        if (!account) return;
        this.emitJob(current, account, "auth:state", {
          state: "queued",
          message: "Waiting for a worker",
        });
      }, config.worker.queueTimeoutMs);
      timer.unref?.();
      this.waitTimers.set(jobId, timer);
    }
    this.pump();
  }

  pickWorker(kind) {
    // Newest ready worker first: it just advertised free capacity. On a pool
    // of equals this spreads work without a central scheduler.
    const workers = [...this.workers.values()].reverse();
    for (const worker of workers) {
      if (worker.slots[kind] > 0) return worker;
    }
    return null;
  }

  pump() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = 0; index < this.queue.length; index += 1) {
        const job = this.store.getJob(this.queue[index]);
        if (!job || job.status !== "queued") {
          this.queue.splice(index, 1);
          index -= 1;
          continue;
        }
        const kind = job.type === "export" ? "export" : "auth";
        const worker = this.pickWorker(kind);
        if (!worker) continue;
        this.queue.splice(index, 1);
        this.dispatch(worker, job);
        progressed = true;
        break;
      }
    }
  }

  dispatch(worker, job) {
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    worker.slots[job.type === "export" ? "export" : "auth"] -= 1;
    this.store.updateJob(job.id, {
      status: "running",
      workerId: worker.socket.id,
      attempts: (job.attempts ?? 0) + 1,
      error: "",
    });
    if (job.type === "auth") {
      this.store.updateAccount(account.id, { status: "auth" });
    } else if (job.type === "export") {
      this.store.updateAccount(account.id, {
        status: "exporting",
        export: { ...(account.export ?? {}), phase: "running" },
      });
    }

    const payload = {
      jobId: job.id,
      account: this.workerView(account),
      proxy: {
        baseUrl: config.icloud.proxyUrl,
        country: account.geo?.countryCode || "",
        fallbackCountry: config.icloud.fallbackCountry,
        ssid: account.proxy?.ssid || stableSsid(account.email),
      },
      fingerprint: {
        userAgent: account.fingerprint?.userAgent || worker.socket.handshake.headers["user-agent"] || "",
        language: account.fingerprint?.language || "",
        timezone: account.fingerprint?.timezone || "",
      },
      exportDir: config.icloud.exportDir,
      sessionsDir: config.icloud.sessionsDir,
      mode: job.payload?.mode ?? "missing",
    };

    if (job.type === "export") {
      worker.socket.emit("job:export", payload);
    } else if (job.type === "ping") {
      worker.socket.emit("job:ping", payload);
    } else {
      worker.socket.emit("job:start", payload);
    }
    if (job.type === "auth") {
      this.emitJob(job, account, "auth:state", {
        state: "auth",
        jobId: job.id,
        message: "Signing in",
      });
    }
    this.notify("dispatched", { account, job });
  }

  /* ------------------------------------------------------------- worker events */

  release(job, workerId) {
    const worker = this.workers.get(workerId);
    if (worker) {
      const kind = job.type === "export" ? "export" : "auth";
      worker.slots[kind] = Math.min(worker.slots[kind] + 1, kind === "export" ? 100 : 100);
    }
    const timer = this.waitTimers.get(job.id);
    if (timer) {
      clearTimeout(timer);
      this.waitTimers.delete(job.id);
    }
    this.pump();
  }

  handleState(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const state = ["queued", "auth", "twofa", "connected", "invalid", "error", "exporting", "done", "dead"].includes(payload.state)
      ? payload.state
      : "auth";
    if (state === "twofa") this.store.updateAccount(account.id, { status: "twofa" });
    else if (state === "auth") this.store.updateAccount(account.id, { status: "auth" });
    this.store.updateJob(job.id, {
      status: state === "queued" ? "queued" : "running",
      message: payload.message ?? "",
      reused: Boolean(payload.reused),
    });
    this.emitJob(job, account, "auth:state", {
      state,
      jobId: job.id,
      message: payload.message ?? "",
      reused: Boolean(payload.reused),
    });
    this.notify("state", { account, job, state, message: payload.message });
  }

  handle2fa(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const view = {
      method: payload.method ?? "trusted_device",
      options: Array.isArray(payload.options) ? payload.options.slice(0, 12) : [],
      notice: payload.notice ?? "",
    };
    this.store.updateJob(job.id, { status: "twofa", twofa: view });
    this.store.updateAccount(account.id, { status: "twofa" });
    this.emitJob(job, account, "auth:2fa", { ...view, jobId: job.id });
    this.notify("twofa", { account, job, ...view });
  }

  handleResult(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const status = ["ok", "invalid", "error"].includes(payload.status) ? payload.status : "error";
    const resultAccount = payload.account ?? null;
    const patch = {
      trusted: Boolean(resultAccount?.trusted ?? account.trusted),
      lastError: status === "ok" ? "" : payload.message || "authentication failed",
    };
    if (resultAccount) {
      if (resultAccount.fingerprint) patch.fingerprint = resultAccount.fingerprint;
      if (resultAccount.proxy) patch.proxy = resultAccount.proxy;
      if (resultAccount.identity) patch.identity = resultAccount.identity;
      if (resultAccount.counts) patch.counts = resultAccount.counts;
      if (resultAccount.sessionDir) patch.sessionDir = resultAccount.sessionDir;
    }
    this.store.updateAccount(account.id, {
      ...patch,
      status: status === "ok" ? "connected" : status,
    });
    this.store.updateJob(job.id, {
      status: status === "ok" ? "done" : status,
      error: status === "ok" ? "" : payload.message || "",
    });
    this.emitJob(job, account, "auth:result", {
      status,
      message: payload.message ?? "",
      account: this.publicAccount(this.store.getAccount(account.id)),
    });
    this.notify("result", { account: this.store.getAccount(account.id), job, status, message: payload.message });
    this.release(job, socket.id);
  }

  handleAccountInfo(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const identity = payload.identity ?? payload.account?.identity ?? {};
    const counts = payload.counts ?? payload.account?.counts ?? {};
    const patch = { identity, counts };
    if (payload.proxy) patch.proxy = { ...(account.proxy ?? {}), ...payload.proxy };
    const updated = this.store.updateAccount(account.id, patch);
    this.emitAccount(updated, "account:info", { identity: updated.identity, counts: updated.counts });
    this.notify("account_info", { account: updated, job });
  }

  handleExportProgress(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const progress = {
      phase: "running",
      area: payload.area ?? "",
      done: Number(payload.done) || 0,
      total: Number(payload.total) || 0,
      bytes: Number(payload.bytes) || 0,
      overallDone: Number(payload.overallDone) || 0,
      overallTotal: Number(payload.overallTotal) || 0,
      areas: payload.areas ?? account.export?.areas ?? {},
      startedAt: account.export?.startedAt ?? new Date().toISOString(),
    };
    const updated = this.store.updateAccount(account.id, { export: progress });
    this.emitAccount(updated, "export:progress", progress);
    this.notify("export_progress", { account: updated, job, progress });
  }

  handleExportDone(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const totals = payload.totals ?? {};
    const updated = this.store.updateAccount(account.id, {
      status: "done",
      export: {
        ...(account.export ?? {}),
        phase: "done",
        finishedAt: new Date().toISOString(),
        done: totals.done ?? account.export?.done ?? 0,
        total: totals.total ?? account.export?.total ?? 0,
        bytes: totals.bytes ?? account.export?.bytes ?? 0,
        manifestPath: payload.manifest ?? "",
      },
    });
    this.store.updateJob(job.id, { status: "done" });
    this.emitAccount(updated, "export:done", { manifest: payload.manifest, totals });
    this.notify("export_done", { account: updated, job, totals });
    this.release(job, socket.id);
  }

  handleError(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    this.store.updateJob(job.id, { status: "error", error: payload.error ?? "worker error" });
    if (job.type === "export") {
      this.store.updateAccount(account.id, {
        status: "error",
        export: { ...(account.export ?? {}), phase: "error" },
        lastError: payload.error ?? "export failed",
      });
      this.emitAccount(account, "export:done", { error: payload.error ?? "export failed" });
    } else if (job.type === "ping") {
      this.store.updateAccount(account.id, {
        status: "error",
        lastError: payload.error ?? "ping failed",
      });
    } else {
      this.store.updateAccount(account.id, {
        status: "error",
        lastError: payload.error ?? "authentication failed",
      });
      this.emitJob(job, account, "auth:result", {
        status: "error",
        message: payload.error ?? "worker error",
      });
    }
    this.notify("error", { account: this.store.getAccount(account.id), job, error: payload.error });
    this.release(job, socket.id);
  }

  handlePingResult(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const ok = Boolean(payload.ok);
    const updated = this.store.updateAccount(account.id, {
      status: ok ? "connected" : "dead",
      trusted: ok ? Boolean(payload.trusted ?? account.trusted) : false,
      lastPingAt: new Date().toISOString(),
      lastError: ok ? "" : payload.error ?? "session dead",
    });
    this.store.updateJob(job.id, { status: ok ? "done" : "error", error: ok ? "" : payload.error ?? "" });
    this.emitAccount(updated, "account:info", {
      identity: updated.identity,
      counts: updated.counts,
      status: updated.status,
      lastPingAt: updated.lastPingAt,
    });
    this.notify("ping", { account: updated, job, ok });
    this.release(job, socket.id);
  }

  /* ---------------------------------------------------------------- commands */

  command(jobId, event, payload = {}) {
    const job = this.store.getJob(jobId);
    if (!job) return Promise.reject(new Error("job not found"));
    const worker = this.workers.get(job.workerId);
    if (!worker) return Promise.reject(new Error("worker offline"));
    const commandId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(commandId);
        reject(new Error("worker command timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.commands.set(commandId, { resolve, reject, timer });
      worker.socket.emit(event, { commandId, jobId, ...payload });
    });
  }

  ack(commandId, payload) {
    const pending = this.commands.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.commands.delete(commandId);
    if (payload?.ok) pending.resolve(payload);
    else pending.reject(new Error(payload?.error ?? "worker rejected command"));
  }

  /* -------------------------------------------------------------- connection */

  addWorker(socket) {
    this.workers.set(socket.id, {
      socket,
      slots: { auth: 0, export: 0 },
      connectedAt: new Date().toISOString(),
    });
  }

  ready(socket, payload) {
    const worker = this.workers.get(socket.id);
    if (!worker) return;
    worker.slots = workerSlots(payload);
    this.pump();
  }

  removeWorker(socket) {
    const worker = this.workers.get(socket.id);
    if (!worker) return;
    this.workers.delete(socket.id);
    for (const job of this.store.jobs.values()) {
      if (job.workerId !== socket.id) continue;
      if (job.status !== "running" && job.status !== "twofa") continue;
      this.store.updateJob(job.id, {
        status: "queued",
        workerId: null,
        error: "worker disconnected",
      });
      const account = this.store.getAccount(job.accountId);
      if (account) {
        this.store.updateAccount(account.id, { status: "queued" });
        this.emitJob(job, account, "auth:state", {
          state: "queued",
          message: "Worker reconnecting",
        });
      }
      this.enqueue(job.id);
    }
  }

  workerCount() {
    return this.workers.size;
  }

  slotStats() {
    let auth = 0;
    let exp = 0;
    for (const worker of this.workers.values()) {
      auth += worker.slots.auth;
      exp += worker.slots.export;
    }
    return { workers: this.workers.size, auth, export: exp, queued: this.queue.length };
  }

  statusShort(account) {
    if (!account) return "unknown";
    if (ACTIVE_ACCOUNT.has(account.status)) return "active";
    if (account.status === "connected" || account.status === "done") {
      return account.trusted ? "green" : "yellow";
    }
    if (account.status === "dead" || account.status === "twofa") return "red";
    return "yellow";
  }
}
