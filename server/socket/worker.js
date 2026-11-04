import { timingSafeEqual } from "node:crypto";

/* /worker namespace. One shared token; workers are trusted infrastructure. */

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function registerWorkerNamespace(io, pool, { token }) {
  const nsp = io.of("/worker");
  nsp.use((socket, next) => {
    if (!safeEqual(socket.handshake.auth?.token, token)) {
      return next(new Error("unauthorized worker"));
    }
    socket.data.role = "worker";
    next();
  });

  nsp.on("connection", (socket) => {
    pool.addWorker(socket);
    socket.emit("worker:welcome", {
      maxAuthJobs: pool.settings.maxAuthJobs,
      maxExportJobs: pool.settings.maxExportJobs,
      message: "Send worker:ready with your free slots",
    });

    socket.on("worker:ready", (payload) => pool.ready(socket, payload ?? {}));
    socket.on("worker:ack", (payload) => pool.ack(payload?.commandId, payload ?? {}));

    socket.on("job:state", (payload) => pool.handleState(socket, payload ?? {}));
    socket.on("job:2fa", (payload) => pool.handle2fa(socket, payload ?? {}));
    socket.on("job:result", (payload) => pool.handleResult(socket, payload ?? {}));
    socket.on("job:account_info", (payload) => pool.handleAccountInfo(socket, payload ?? {}));
    socket.on("job:export_progress", (payload) => pool.handleExportProgress(socket, payload ?? {}));
    socket.on("job:export_done", (payload) => pool.handleExportDone(socket, payload ?? {}));
    socket.on("job:error", (payload) => pool.handleError(socket, payload ?? {}));
    socket.on("job:ping_result", (payload) => pool.handlePingResult(socket, payload ?? {}));
    socket.on("job:verify_result", (payload) => pool.handleVerifyResult(socket, payload ?? {}));
    socket.on("job:import_progress", (payload) => pool.handleImportProgress(socket, payload ?? {}));
    socket.on("job:import_result", (payload) => pool.handleImportResult(socket, payload ?? {}));
    socket.on("job:scan_progress", (payload) => pool.handleScanProgress(socket, payload ?? {}));
    socket.on("job:scan_done", (payload) => pool.handleScanDone(socket, payload ?? {}));

    socket.on("disconnect", () => pool.removeWorker(socket));
  });

  return nsp;
}
