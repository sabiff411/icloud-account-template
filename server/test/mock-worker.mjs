import { io } from "socket.io-client";

/* A fake worker for UI/acceptance tests. It speaks the same protocol as the
 * Python worker: one auth result, or a 2FA challenge that accepts any code.
 *
 *   node server/test/mock-worker.mjs
 */

const URL = process.env.WORKER_URL || "http://127.0.0.1:4001";
const TOKEN = process.env.WORKER_TOKEN || "change-me";

const worker = io(`${URL}/worker`, {
  auth: { token: TOKEN },
  transports: ["websocket"],
});

const jobs = new Map();

const result = (jobId, account, status, message, extra = {}) => {
  worker.emit("job:result", {
    jobId,
    status,
    message,
    account: {
      trusted: status === "ok",
      identity: account.identity ?? {
        name: "Mock Person",
        phone: "+1 ••• ••• 4567",
        plan: { featureKey: "icloud.plus" },
        storage: { used: 42_000_000_000, total: 200_000_000_000 },
        family: ["Alex"],
        devices: ["iPhone"],
      },
      counts: account.counts ?? {
        photos: 1234,
        hidden: 12,
        deleted: 3,
        notes: 41,
        contacts: 88,
        contactsPhone: 40,
        contactsEmail: 60,
        driveFiles: 120,
        driveBytes: 8_000_000,
        reminders: 9,
        calendars: 2,
        albums: 6,
      },
      ...extra,
    },
  });
};

worker.on("connect", () => {
  console.log("[mock-worker] connected");
  worker.emit("worker:ready", { slots: { auth: 10, export: 4 } });
});

worker.on("job:start", (payload) => {
  const jobId = payload.jobId;
  jobs.set(jobId, payload.account);
  const email = String(payload.account?.email || "");
  worker.emit("job:state", { jobId, state: "auth", message: "Mock sign-in" });

  setTimeout(() => {
    if (email.includes("invalid")) {
      result(jobId, payload.account, "invalid", "Incorrect Apple Account or password.");
      return;
    }
    if (email.includes("2fa")) {
      worker.emit("job:state", { jobId, state: "twofa", message: "Two-factor required" });
      worker.emit("job:2fa", {
        jobId,
        method: "sms",
        choiceId: "sms:0",
        notice: "Code sent to +1 ••• ••• 1234",
        options: [
          {
            id: "trusted_device",
            kind: "trusted_device",
            label: "Trusted device",
            detail: "Enter the code shown on your devices",
            active: false,
          },
          {
            id: "sms:0",
            kind: "sms",
            label: "+1 ••• ••• 1234",
            detail: "Text message",
            active: true,
          },
        ],
      });
      return;
    }
    result(jobId, payload.account, "ok", "Signed in");
  }, 400);
});

worker.on("job:2fa", (payload) => {
  worker.emit("worker:ack", { commandId: payload.commandId, ok: true });
  const account = jobs.get(payload.jobId) || {};
  if (payload.action === "switch") {
    worker.emit("job:2fa", {
      jobId: payload.jobId,
      method: "sms",
      choiceId: payload.choiceId,
      notice: "Switched delivery",
      options: [
        { id: "trusted_device", kind: "trusted_device", label: "Trusted device", detail: "Push" },
        { id: "sms:0", kind: "sms", label: "+1 ••• ••• 1234", detail: "Text message", active: true },
      ],
    });
    return;
  }
  if (payload.action === "resend") {
    worker.emit("job:2fa", {
      jobId: payload.jobId,
      method: "sms",
      choiceId: payload.choiceId,
      notice: "Code sent again",
      options: [
        { id: "trusted_device", kind: "trusted_device", label: "Trusted device", detail: "Push" },
        { id: "sms:0", kind: "sms", label: "+1 ••• ••• 1234", detail: "Text message", active: true },
      ],
    });
    return;
  }
  setTimeout(() => {
    result(payload.jobId, account, "ok", "Code accepted");
    jobs.delete(payload.jobId);
  }, 500);
});

worker.on("job:export", (payload) => {
  let done = 0;
  const timer = setInterval(() => {
    done += 2;
    worker.emit("job:export_progress", {
      jobId: payload.jobId,
      area: "photos",
      done,
      total: 10,
      bytes: done * 1000,
      overallDone: done,
      overallTotal: 10,
    });
    if (done >= 10) {
      clearInterval(timer);
      worker.emit("job:export_done", {
        jobId: payload.jobId,
        manifest: "/tmp/mock-manifest.sqlite3",
        totals: { done: 10, total: 10, bytes: 10000 },
      });
    }
  }, 400);
});

worker.on("job:ping", (payload) => {
  worker.emit("job:ping_result", { jobId: payload.jobId, ok: true, trusted: true });
});

worker.on("disconnect", () => console.log("[mock-worker] disconnected"));
