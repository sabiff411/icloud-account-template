import { config } from "./config.js";
import { createApp } from "./app.js";
import { geo } from "./geo/index.js";

const app = createApp();
const server = app.listen(config.httpPort, () => {
  console.log(`[web] http://127.0.0.1:${config.httpPort}`);
  console.log(`[web] geo proxies configured: ${geo.proxyCount}`);
});

function shutdown(signal) {
  console.log(`[web] ${signal}, closing`);
  server.close(() => {
    geo.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
