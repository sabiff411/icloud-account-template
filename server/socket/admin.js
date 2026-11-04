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

const idQuery = z.object({ id: z.string().min(1).max(80) });

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

function guard(socket, event, ack) {
  if (socket.data.role !== "admin") {
    reply(ack, { ok: false, error: "forbidden" });
    return false;
  }
  if (!allow(socket, event, { limit: 60, windowMs: 10_000 })) {
    reply(ack, { ok: false, error: "rate limited" });
    return false;
  }
  return true;
}

export function registerAdmin(io, store, publicNsp) {
  const nsp = io.of("/admin");
  nsp.use(adminAuth(config.adminPassword));

  nsp.on("connection", (socket) => {
    socket.emit("admin:ready", {
      stats: store.stats(),
      page: store.page({ page: 1, pageSize: 10 }),
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
      reply(ack, { ok: true, stats: store.stats() });
    });

    // Demo of an admin-only feature: push a notice to every public visitor.
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

    socket.on("admin:ping", (ack) => {
      if (!guard(socket, "admin:ping", ack)) return;
      reply(ack, { ok: true, now: Date.now() });
    });
  });

  // Live updates: every connected admin sees store changes immediately.
  store.on("change", (change) => {
    nsp.emit("admin:change", { change, stats: store.stats() });
  });

  return nsp;
}
