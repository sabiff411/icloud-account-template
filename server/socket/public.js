import { z } from "zod";
import { allow } from "./rate-limit.js";
import { cleanIp, countryName } from "../ip.js";
import { geo } from "../geo/index.js";

/* Public namespace.  Anonymous visitors may only emit the two events listed
 * here; everything else (including every admin command) is simply unknown. */

const hello = z.object({
  page: z.string().trim().max(120).default("/"),
});

const submit = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().max(200).default(""),
  code: z.string().trim().max(12).default(""),
  page: z.string().trim().max(120).default("/verify"),
});

const reply = (ack, payload) => {
  if (typeof ack === "function") ack(payload);
};

export function registerPublic(io, store) {
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

      // Never send the full record to the anonymous visitor.  The store's
      // "change" event below already broadcasts the new count.
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
