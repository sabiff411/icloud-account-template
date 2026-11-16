import { config, securityWarnings } from "./config.js";
import { attachSocketProxy, createApp } from "./app.js";
import { geo } from "./geo/index.js";

const app = createApp();
const server = app.listen(config.httpPort, () => {
  console.log(`[web] http://127.0.0.1:${config.httpPort}`);
  console.log(`[web] geo proxies configured: ${geo.proxyCount}`);
});
attachSocketProxy(server);

function shutdown(signal) {
  console.log(`[web] ${signal}, closing`);
  // Stop accepting at once and drop idle keep-alive sockets, so the couple of
  // seconds a restart takes are not filled with 502s in the browser.
  server.close(() => {
    geo.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  // One long-lived request must not hold the unit down for 15 seconds.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
