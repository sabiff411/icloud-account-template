import { timingSafeEqual } from "node:crypto";
import { readCookie, verifySession } from "../admin/session.js";

/* Compare the password without leaking its length through timing. */
export function isAdminPassword(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Socket.IO middleware for the /admin namespace.
 *
 * Accepts the password (scripts, tests, first login) or the signed `ic_admin`
 * cookie issued by POST /api/admin/login. The cookie is the normal path: the
 * browser reconnects after a reload without asking for the password again. */
export function adminAuth(options) {
  const settings = typeof options === "string" ? { password: options } : options ?? {};
  return (socket, next) => {
    const password = socket.handshake.auth?.password;
    if (isAdminPassword(password, settings.password)) {
      socket.data.role = "admin";
      return next();
    }
    const token = readCookie(socket.handshake.headers?.cookie);
    if (verifySession(token, settings).ok) {
      socket.data.role = "admin";
      return next();
    }
    next(new Error("unauthorized"));
  };
}
