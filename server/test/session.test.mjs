import assert from "node:assert/strict";
import {
  signSession,
  verifySession,
  readCookie,
  sessionCookie,
  clearCookie,
} from "../admin/session.js";
import { adminAuth } from "../socket/auth.js";

/* Signed panel session: cookie round-trip, tamper, expiry, socket fallback. */

const opts = { password: "pw", secret: "s3cr3t" };
const token = signSession({ ...opts, ttlMs: 60_000, now: 1_000_000 });

assert.equal(verifySession(token, { ...opts, now: 1_000_001 }).ok, true);
assert.equal(verifySession(token, { ...opts, now: 1_000_001 }).exp, 1_060_000);
assert.equal(verifySession(token, { ...opts, now: 2_000_000 }).ok, false, "expired");
assert.equal(
  verifySession(token.replace(/.$/, (c) => (c === "a" ? "b" : "a")), { ...opts, now: 1_000_001 }).ok,
  false,
  "tampered"
);
assert.equal(verifySession("", opts).ok, false);
assert.equal(verifySession("not-a-token", opts).ok, false);
const derived = signSession({ password: "pw", ttlMs: 60_000, now: 1_000_000 });
assert.equal(
  verifySession(derived, { password: "other", now: 1_000_001 }).ok,
  false,
  "with no explicit secret the key follows the password"
);
assert.equal(
  verifySession(derived, { password: "pw", now: 1_000_001 }).ok,
  true
);

const cookie = sessionCookie(token, 600);
assert.match(cookie, /^ic_admin=/);
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /SameSite=Lax/);
assert.match(cookie, /Path=\//);
assert.match(cookie, /Max-Age=600/);
assert.equal(readCookie(`a=1; ${cookie.split(";")[0]}; b=2`, "ic_admin"), token);
assert.equal(readCookie("a=1; ic_admin=hello%20world", "ic_admin"), "hello world");
assert.equal(readCookie(undefined, "ic_admin"), "");
assert.equal(clearCookie(), "ic_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");

/* Socket middleware: cookie OR password; anything else is rejected. */
const fresh = signSession({ ...opts, ttlMs: 3600_000 });
const cookiePair = sessionCookie(fresh, 3600).split(";")[0];

function run(auth, headers = {}) {
  const socket = { handshake: { auth, headers }, data: {} };
  let error = null;
  adminAuth({ password: "pw", secret: "s3cr3t" })(socket, (err) => {
    error = err ?? null;
  });
  return { error, socket };
}

assert.equal(run({ password: "pw" }).error, null, "password accepted");
assert.equal(run({}, { cookie: `x=1; ${cookiePair}` }).error, null, "cookie accepted");
assert.equal(run({}, { cookie: "x=1" }).error?.message, "unauthorized");
assert.equal(run({}, {}).error?.message, "unauthorized");

// The old string signature still works.
let legacyError = "unset";
adminAuth("pw")(
  { handshake: { auth: { password: "pw" }, headers: {} }, data: {} },
  (err) => {
    legacyError = err ?? null;
  }
);
assert.equal(legacyError, null, "string signature");

console.log("session test ok");
