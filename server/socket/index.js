import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "socket.io";
import { config } from "../config.js";
import { Store } from "../store.js";
import { registerPublic } from "./public.js";
import { registerAdmin } from "./admin.js";
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

  const publicNsp = registerPublic(io, store);
  registerAdmin(io, store, publicNsp);

  const bot = startBot({ store });

  httpServer.listen(config.socketPort, () => {
    console.log(`[socket] ws://127.0.0.1:${config.socketPort} (/public, /admin)`);
  });

  function close() {
    bot?.stop().catch(() => {});
    io.close();
    httpServer.close();
  }

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  return { io, store, httpServer, bot, close };
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) startSocketServer();
