import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/* Signed panel sessions.
 *
 * The web process sets an HttpOnly cookie after a password login; the socket
 * process (different port, same host — cookies ignore ports) verifies the same
 * token. No server-side session store: `<exp>.<hmac>` is self-contained, so a
 * restart does not log the operator out. Changing ADMIN_PASSWORD (or the
 * optional ADMIN_SESSION_SECRET) invalidates every issued cookie. */

export const COOKIE_NAME = "ic_admin";
export const DEFAULT_TTL_MS = 7 * 24 * 3600_000;

function keyFor(password, secret) {
  if (secret) return String(secret);
  return createHash("sha256").update(`ic-panel:${String(password ?? "")}`).digest("hex");
}

export function signSession({ password, secret = "", ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  const exp = Math.floor(now + ttlMs);
  const signature = createHmac("sha256", keyFor(password, secret))
    .update(String(exp))
    .digest("base64url");
  return `${exp}.${signature}`;
}

export function verifySession(token, { password, secret = "", now = Date.now() } = {}) {
  if (!token || typeof token !== "string") return { ok: false };
  const [expRaw, signature] = token.split(".");
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || !signature) return { ok: false };
  if (exp <= now) return { ok: false, exp };
  const expected = createHmac("sha256", keyFor(password, secret))
    .update(String(exp))
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, exp };
  }
  return { ok: true, exp };
}

export function readCookie(header, name = COOKIE_NAME) {
  for (const part of String(header || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    if (trimmed.slice(0, index) === name) {
      try {
        return decodeURIComponent(trimmed.slice(index + 1));
      } catch {
        return trimmed.slice(index + 1);
      }
    }
  }
  return "";
}

export function sessionCookie(token, maxAgeSec = DEFAULT_TTL_MS / 1000) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    maxAgeSec
  )}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
