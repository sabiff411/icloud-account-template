import { timingSafeEqual } from "node:crypto";

/* Compare the password without leaking its length through timing. */
export function isAdminPassword(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Socket.IO middleware for the /admin namespace. */
export function adminAuth(expectedPassword) {
  return (socket, next) => {
    const password = socket.handshake.auth?.password;
    if (!isAdminPassword(password, expectedPassword)) {
      return next(new Error("unauthorized"));
    }
    socket.data.role = "admin";
    next();
  };
}
