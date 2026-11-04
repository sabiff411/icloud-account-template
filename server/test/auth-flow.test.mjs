import { io } from "socket.io-client";

/* End-to-end Node test for the auth/2FA/export contracts, using a fake Python
 * worker. Start the socket server first (npm run socket) then:
 *   node server/test/auth-flow.test.mjs
 */

const URL = process.env.SOCKET_URL || "http://127.0.0.1:4001";
const TOKEN = process.env.WORKER_TOKEN || "change-me";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TAG = Date.now();

function connect(nsp, auth = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(URL + nsp, { auth, transports: ["websocket"] });
    const timer = setTimeout(() => reject(new Error("connect timeout " + nsp)), 6000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function once(socket, event, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting ${event}`));
    }, timeout);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const call = (socket, event, data) =>
  new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, data, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

async function main() {
  // Wrong token must be rejected.
  try {
    await connect("/worker", { token: "wrong" });
    check("worker rejects wrong token", false);
  } catch (error) {
    check("worker rejects wrong token", /unauthorized/.test(error.message));
  }

  const worker = await connect("/worker", { token: TOKEN });
  worker.emit("worker:ready", { slots: { auth: 10, export: 4 } });
  check("worker connects", true);

  const pub = await connect("/public");
  const statePromise = once(pub, "auth:state");
  const startPromise = once(worker, "job:start");
  const start = await call(pub, "auth:start", {
    email: `flow-${TAG}@example.com`,
    password: "pw-123",
    userAgent: "TestAgent/1.0",
    language: "en-US",
    timezone: "Europe/Paris",
  });
  check("auth:start ack", start.ok && start.jobId && start.accountId, start.jobId ?? "");
  const jobStart = await startPromise;
  check(
    "worker receives job:start",
    jobStart.jobId === start.jobId &&
      jobStart.account.email === `flow-${TAG}@example.com` &&
      jobStart.account.password === "pw-123" &&
      jobStart.fingerprint.userAgent === "TestAgent/1.0"
  );

  const queued = await statePromise;
  check("public sees auth state", queued.state === "auth" || queued.state === "queued");

  const twofaPromise = once(pub, "auth:2fa");
  worker.emit("job:2fa", {
    jobId: start.jobId,
    method: "sms",
    options: [
      { id: "trusted_device", kind: "trusted_device", label: "Trusted device" },
      { id: "sms:0", kind: "sms", label: "+1 ••• ••• 1234" },
    ],
    notice: "Code sent",
  });
  const twofa = await twofaPromise;
  check("auth:2fa reaches browser", twofa.method === "sms" && twofa.options.length === 2);

  const commandPromise = once(worker, "job:2fa");
  const resultPromise = once(pub, "auth:result");
  const submit = call(pub, "auth:submit_2fa", {
    jobId: start.jobId,
    choiceId: "sms:0",
    code: "123456",
  });
  const command = await commandPromise;
  worker.emit("worker:ack", { commandId: command.commandId, ok: true });
  const submitAck = await submit;
  check("2FA command acked", submitAck.ok && command.action === "submit");
  worker.emit("job:result", {
    jobId: start.jobId,
    status: "ok",
    message: "Code accepted",
    account: { trusted: true, proxy: { exitIp: "203.0.113.9" } },
  });
  const result = await resultPromise;
  check("auth:result ok", result.status === "ok" && result.account.trusted === true);

  const admin = await connect("/admin", {
    password: process.env.ADMIN_PASSWORD || "change-me-admin",
  });
  const accounts = await call(admin, "admin:accounts", { page: 1, pageSize: 10 });
  check(
    "admin sees account",
    accounts.ok &&
      accounts.accounts.items.some(
        (account) => account.id === start.accountId && account.status === "connected"
      ),
    `count=${accounts.accounts?.items?.length}`
  );

  const exportStart = once(worker, "job:export");
  const adminEvents = [];
  admin.on("admin:account", (event) => adminEvents.push(event));
  const exportAck = await call(admin, "admin:export", {
    id: start.accountId,
    mode: "missing",
  });
  const exportJob = await exportStart;
  check("admin export dispatched", exportAck.ok && exportJob.jobId === exportAck.jobId);
  worker.emit("job:export_progress", {
    jobId: exportAck.jobId,
    area: "photos",
    done: 2,
    total: 3,
    bytes: 100,
    overallDone: 2,
    overallTotal: 3,
  });
  worker.emit("job:export_done", {
    jobId: exportAck.jobId,
    manifest: "/tmp/manifest.sqlite3",
    totals: { done: 3, total: 3, bytes: 300 },
  });
  let doneSeen = false;
  for (let i = 0; i < 30 && !doneSeen; i += 1) {
    if (adminEvents.some((event) => event.account?.status === "done")) doneSeen = true;
    else await wait(100);
  }
  check("export completes account", doneSeen);

  // Duplicate submission joins the running job.
  const dupWorker = once(worker, "job:start");
  const dupA = await call(pub, "auth:start", {
    email: `dup-${TAG}@example.com`,
    password: "a",
    userAgent: "UA",
  });
  await dupWorker;
  const dupB = await call(pub, "auth:start", {
    email: `dup-${TAG}@example.com`,
    password: "b",
    userAgent: "UA",
  });
  check("duplicate email joins job", dupA.jobId === dupB.jobId && dupB.reused === true);

  // Invalid credentials route.
  const invalidPromise = once(pub, "auth:result");
  worker.emit("job:result", {
    jobId: dupA.jobId,
    status: "invalid",
    message: "Incorrect Apple Account or password.",
  });
  const invalid = await invalidPromise;
  check("invalid result reaches browser", invalid.status === "invalid");

  // A locked Apple Account is an error with a reason, not a bad password.
  const lockedDispatch = once(worker, "job:start");
  const lockedStart = await call(pub, "auth:start", {
    email: `locked-${TAG}@example.com`,
    password: "pw",
    userAgent: "UA",
  });
  await lockedDispatch;
  const lockedResultPromise = once(pub, "auth:result");
  worker.emit("job:result", {
    jobId: lockedStart.jobId,
    status: "error",
    reason: "locked",
    code: "-20209",
    unlockUrl: "https://iforgot.apple.com/example",
    message: "This Apple Account has been locked for security reasons.",
  });
  const lockedResult = await lockedResultPromise;
  check(
    "locked result reaches browser",
    lockedResult.status === "error" && lockedResult.reason === "locked"
  );
  const lockedAccount = await call(admin, "admin:account", { id: lockedStart.accountId });
  check(
    "locked account flagged in admin",
    lockedAccount.ok &&
      lockedAccount.account.locked === true &&
      lockedAccount.account.lockCode === "-20209" &&
      /iforgot/.test(lockedAccount.account.unlockUrl)
  );

  // Live verification: a job, a result, and the stored per-area report.
  const verifiedEvents = [];
  admin.on("admin:account", (event) => verifiedEvents.push(event));
  const verifyDispatch = once(worker, "job:verify");
  const verifyAck = await call(admin, "admin:verify", { id: lockedStart.accountId });
  const verifyJob = await verifyDispatch;
  check("admin verify dispatched", verifyAck.ok && verifyJob.jobId === verifyAck.jobId);
  worker.emit("job:verify_result", {
    jobId: verifyAck.jobId,
    areas: { photos: { live: 3, exported: 2, missing: 1 }, notes: { live: 2, exported: 2, missing: 0 } },
    missing: { photos: ["missing-photo"], notes: [] },
  });
  let verified = null;
  for (let i = 0; i < 30 && !verified; i += 1) {
    const event = verifiedEvents.find(
      (item) => item.account?.id === lockedStart.accountId && item.account?.verify
    );
    if (event) verified = event.account;
    else await wait(100);
  }
  check(
    "verify result stored",
    verified?.verify?.areas?.photos?.missing === 1 &&
      verified?.verify?.missing?.photos?.[0] === "missing-photo"
  );

  // Ten parallel accounts, each on its own browser socket (real visitors).
  const startedPayloads = [];
  worker.on("job:start", (payload) => startedPayloads.push(payload));
  const browsers = [];
  for (let i = 0; i < 10; i += 1) {
    const browser = await connect("/public");
    const email = `parallel-${TAG}-${i}@example.com`;
    const ack = await call(browser, "auth:start", {
      email,
      password: "pw",
      userAgent: "UA",
    });
    browsers.push({ browser, jobId: ack.jobId });
  }
  for (let i = 0; i < 30 && startedPayloads.length < 10; i += 1) await wait(100);
  const started = startedPayloads.map((payload) => payload.jobId);
  check(
    "ten auth jobs dispatched",
    started.length === 10 && new Set(started).size === 10,
    `got=${started.length}`
  );
  const resultPromises = browsers.map(({ browser }) => once(browser, "auth:result"));
  browsers.forEach(({ jobId }) => {
    worker.emit("job:result", { jobId, status: "ok", account: { trusted: true } });
  });
  const allResults = await Promise.all(resultPromises);
  check("ten results delivered", allResults.every((item) => item.status === "ok"));

  // The worker must have all ten slots back before the test disconnects it,
  // otherwise a result still in flight is requeued and leaks a slot.
  let freeSlots = 0;
  for (let i = 0; i < 30; i += 1) {
    freeSlots = (await call(admin, "admin:stats", {})).workers.auth;
    if (freeSlots >= 10) break;
    await wait(100);
  }
  check("worker slots return to ten", freeSlots >= 10, `free=${freeSlots}`);
  browsers.forEach(({ browser }) => browser.close());

  pub.close();
  admin.close();
  worker.close();
}

main()
  .catch((error) => check("unexpected error", false, error.stack))
  .finally(() => {
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
