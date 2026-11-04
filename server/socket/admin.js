import { z } from "zod";
import { allow } from "./rate-limit.js";
import { adminAuth } from "./auth.js";
import { config } from "../config.js";
import { STATUSES } from "../store.js";

/* Admin namespace.  The handshake password is checked before a socket can
 * connect; every handler below also asserts the role, so a future refactor
 * cannot accidentally expose an admin command on the public namespace. */

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  query: z.string().trim().max(120).default(""),
});

const accountPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(5),
  query: z.string().trim().max(120).default(""),
});

const idQuery = z.object({ id: z.string().min(1).max(80) });

const accountId = z.object({ id: z.string().min(1).max(80) });

const exportCommand = z.object({
  id: z.string().min(1).max(80),
  mode: z.enum(["missing", "force"]).default("missing"),
});

const pingCommand = z.object({
  id: z.string().min(1).max(80).optional(),
});

const updateQuery = z.object({
  id: z.string().min(1).max(80),
  status: z.enum(STATUSES).optional(),
  note: z.string().max(2000).optional(),
});

const notice = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(500).default(""),
});

const reply = (ack, payload) => {
  if (typeof ack === "function") ack(payload);
};

function guard(socket, event, ack, limit = 60) {
  if (socket.data.role !== "admin") {
    reply(ack, { ok: false, error: "forbidden" });
    return false;
  }
  if (!allow(socket, event, { limit, windowMs: 10_000 })) {
    reply(ack, { ok: false, error: "rate limited" });
    return false;
  }
  return true;
}

export function registerAdmin(io, store, publicNsp, pool) {
  const nsp = io.of("/admin");
  nsp.use(adminAuth(config.adminPassword));

  const accountsPayload = (query = {}) => ({
    accounts: store.listAccounts(query),
    stats: store.accountsStats(),
    jobs: store.jobsStats(),
    workers: pool.slotStats(),
  });

  nsp.on("connection", (socket) => {
    const initialAccounts = store.listAccounts({ page: 1, pageSize: 5 });
    socket.emit("admin:ready", {
      stats: store.stats(),
      page: store.page({ page: 1, pageSize: 10 }),
      accounts: {
        ...initialAccounts,
        items: initialAccounts.items.map((account) => store.adminAccount(account)),
      },
      accountStats: store.accountsStats(),
      jobs: store.jobsStats(),
      workers: pool.slotStats(),
      serverTime: new Date().toISOString(),
    });

    socket.on("admin:list", (raw, ack) => {
      if (!guard(socket, "admin:list", ack)) return;
      const parsed = pageQuery.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      reply(ack, { ok: true, ...store.page(parsed.data) });
    });

    socket.on("admin:get", (raw, ack) => {
      if (!guard(socket, "admin:get", ack)) return;
      const parsed = idQuery.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      const item = store.get(parsed.data.id);
      reply(ack, item ? { ok: true, item } : { ok: false, error: "not found" });
    });

    socket.on("admin:update", (raw, ack) => {
      if (!guard(socket, "admin:update", ack)) return;
      const parsed = updateQuery.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      const { id, ...patch } = parsed.data;
      const item = store.update(id, patch);
      reply(ack, item ? { ok: true, item } : { ok: false, error: "not found" });
    });

    socket.on("admin:delete", (raw, ack) => {
      if (!guard(socket, "admin:delete", ack)) return;
      const parsed = idQuery.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      const item = store.remove(parsed.data.id);
      reply(ack, item ? { ok: true, item } : { ok: false, error: "not found" });
    });

    socket.on("admin:stats", (raw, ack) => {
      if (!guard(socket, "admin:stats", ack)) return;
      reply(ack, {
        ok: true,
        stats: store.stats(),
        accounts: store.accountsStats(),
        jobs: store.jobsStats(),
        workers: pool.slotStats(),
      });
    });

    /* ---------------------------------------------------------- accounts */

    socket.on("admin:accounts", (raw, ack) => {
      if (!guard(socket, "admin:accounts", ack)) return;
      const parsed = accountPage.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      const payload = accountsPayload(parsed.data);
      reply(ack, {
        ok: true,
        ...payload,
        accounts: {
          ...payload.accounts,
          items: payload.accounts.items.map((account) => store.adminAccount(account)),
        },
      });
    });

    socket.on("admin:account", (raw, ack) => {
      if (!guard(socket, "admin:account", ack)) return;
      const parsed = accountId.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      const account = store.getAccount(parsed.data.id);
      if (!account) return reply(ack, { ok: false, error: "not found" });
      reply(ack, {
        ok: true,
        account: store.adminAccount(account),
        jobs: store.jobsForAccount(account.id).slice(0, 10),
      });
    });

    socket.on("admin:refresh", (raw, ack) => {
      if (!guard(socket, "admin:refresh", ack)) return;
      const parsed = accountPage.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      const payload = accountsPayload(parsed.data);
      reply(ack, {
        ok: true,
        ...payload,
        accounts: {
          ...payload.accounts,
          items: payload.accounts.items.map((account) => store.adminAccount(account)),
        },
      });
    });

    socket.on("admin:ping", async (raw, ack) => {
      if (!guard(socket, "admin:ping", ack)) return;
      const parsed = pingCommand.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      if (!parsed.data.id) return reply(ack, { ok: true, now: Date.now() });
      try {
        const result = await pool.startPing(parsed.data.id);
        reply(ack, { ok: true, jobId: result.job.id, reused: result.reused });
      } catch (error) {
        reply(ack, { ok: false, error: error.message });
      }
    });

    socket.on("admin:export", async (raw, ack) => {
      if (!guard(socket, "admin:export", ack)) return;
      const parsed = exportCommand.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      try {
        const result = await pool.startExport(parsed.data.id, { mode: parsed.data.mode });
        reply(ack, { ok: true, jobId: result.job.id, reused: result.reused });
      } catch (error) {
        reply(ack, { ok: false, error: error.message });
      }
    });

    /* ------------------------------------------------------------- notice */

    socket.on("admin:notice", (raw, ack) => {
      if (!guard(socket, "admin:notice", ack)) return;
      const parsed = notice.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      publicNsp.emit("public:notice", {
        ...parsed.data,
        at: new Date().toISOString(),
      });
      reply(ack, { ok: true, deliveredTo: publicNsp.sockets.size });
    });
  });

  store.on("change", (change) => {
    nsp.emit("admin:change", { change, stats: store.stats() });
  });

  store.on("account", (account, change) => {
    nsp.emit("admin:account", {
      account: store.adminAccount(account),
      change,
      stats: store.accountsStats(),
    });
  });

  store.on("job", (job, change) => {
    nsp.emit("admin:job", { job, change });
  });

  return nsp;
}
