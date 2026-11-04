import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "socket.io";
import { config } from "../config.js";
import { Store } from "../store.js";
import { registerPublic } from "./public.js";
import { registerAdmin } from "./admin.js";
import { registerWorkerNamespace } from "./worker.js";
import { WorkerPool } from "./worker-pool.js";
import { startBot } from "../telegram/bot.js";

/* The separate Socket.IO process.  It owns the store; the web process never
 * touches it.  The Telegram bot runs here too, because it shares that store. */

export function startSocketServer() {
  const store = new Store({ file: config.store.file, seed: config.store.seed });

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("socket.io server\n");
  });

  const io = new Server(httpServer, {
    cors: { origin: config.socketCorsOrigin, methods: ["GET", "POST"] },
    maxHttpBufferSize: 100_000,
  });

  const pool = new WorkerPool({ io, store });
  const publicNsp = registerPublic(io, store, pool);
  registerAdmin(io, store, publicNsp, pool);
  registerWorkerNamespace(io, pool, { token: config.worker.token });

  const bot = startBot({ store, pool, io });
  pool.onEvent = (type, payload) => {
    bot?.onPoolEvent?.(type, payload);
  };

  // A cheap keepalive probe; the worker uses the stored trusted session.
  const keepalive = setInterval(() => {
    const cutoff = Date.now() - config.worker.keepaliveHours * 3600_000;
    for (const account of store.accounts.values()) {
      if (!["connected", "done"].includes(account.status)) continue;
      const last = account.lastPingAt ? Date.parse(account.lastPingAt) : 0;
      if (last > cutoff) continue;
      pool.startPing(account.id).catch(() => {});
    }
  }, 30 * 60_000);
  keepalive.unref?.();

  httpServer.listen(config.socketPort, () => {
    console.log(
      `[socket] ws://127.0.0.1:${config.socketPort} (/public, /admin, /worker)`
    );
  });

  function close() {
    clearInterval(keepalive);
    bot?.stop().catch(() => {});
    io.close();
    httpServer.close();
    store.flush();
  }

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  return { io, store, pool, httpServer, bot, close };
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) startSocketServer();
