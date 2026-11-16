import crypto from "node:crypto";

/* Pre-signed URLs for MEGA S4 (S3).
 *
 * The export is mirrored to an S3 bucket, so the panel can hand the browser a
 * direct link instead of streaming gigabytes through this process.  The bucket
 * stays private; every link is signed for a limited time.
 *
 * Env: S4_ENDPOINT, S4_REGION, S4_BUCKET, S4_KEY, S4_SECRET, S4_TTL.
 */

const ENDPOINT = String(process.env.S4_ENDPOINT || "").replace(/\/+$/, "");
const HOST = ENDPOINT.replace(/^https?:\/\//, "");
const BUCKET = String(process.env.S4_BUCKET || "icld");
const REGION = String(process.env.S4_REGION || "eu-amsterdam-1");
const KEY = String(process.env.S4_KEY || "");
const SECRET = String(process.env.S4_SECRET || "");
const TTL = Math.max(60, Number(process.env.S4_TTL || 43_200));
/* A presigned link is stable for a window, so the browser can cache the
 * object.  Without this every panel request signed a fresh URL and the image
 * was downloaded again; the bucket is the same object. */
const URL_CACHE_MS = Math.max(0, Number(process.env.S4_URL_CACHE_MS || 21_600_000));
const URL_BUCKET_MS = 5 * 60_000;
const urlCache = new Map(); // `${method}:${ttl}:${key}` -> {url, at, until}

export const s4Enabled = Boolean(ENDPOINT && BUCKET && KEY && SECRET);

/** RFC 3986, as SigV4 canonicalisation requires (encodeURIComponent leaves !'()*). */
function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalPath(key) {
  return `/${BUCKET}/${String(key)
    .split("/")
    .map(rfc3986)
    .join("/")}`;
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * A signed GET URL for one object, or "" when S4 is not configured.
 * `key` is the object key, e.g. "name@icloud.com/Photos/Library/x.jpg".
 */
export function s4url(key, ttl = TTL, method = "GET", extra = []) {
  if (!s4Enabled || !key) return "";
  const extraKey = extra.length ? JSON.stringify(extra) : "";
  const cacheKey = `${String(method).toUpperCase()}:${ttl}:${key}:${extraKey}`;
  const hit = urlCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.url;
  // Round to a five-minute boundary: the same key yields the same URL inside
  // the window, which is what lets the browser cache it.  TTL is 12 h by
  // default, so the rounded start is still safely inside the signature.
  const signedAt = Math.floor(Date.now() / URL_BUCKET_MS) * URL_BUCKET_MS;
  const amzDate = new Date(signedAt)
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const path = canonicalPath(key);
  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${KEY}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(ttl)],
    ["X-Amz-SignedHeaders", "host"],
    ...extra,
  ];
  params.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  const query = params
    .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    query,
    `host:${HOST}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, day), REGION), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const url = `${ENDPOINT}${path}?${query}&X-Amz-Signature=${signature}`;
  if (URL_CACHE_MS > 0) {
    if (urlCache.size > 20_000) urlCache.clear();
    // Never hand back a URL that is about to expire: leave 30 s of margin.
    const expiresAt = signedAt + ttl * 1000;
    const until = Math.min(Date.now() + URL_CACHE_MS, expiresAt - 30_000);
    if (until > Date.now()) urlCache.set(cacheKey, { url, at: Date.now(), until });
  }
  return url;
}

const seen = new Map(); // key -> {ok, at}
const HIT_MS = 5 * 60_000;
const MISS_MS = 30_000;

/* A profile gallery asks about thousands of keys at once; without a cap the
 * existence checks alone would open thousands of sockets to S4. */
const LIMIT = 24;
let active = 0;
const waiting = [];

function acquire() {
  if (active < LIMIT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

/**
 * Does the object exist in S4 yet?
 *
 * The mirror runs for hours, so the panel must not point the browser at a key
 * that is still uploading: if it is missing, the caller falls back to the
 * local file route and nobody sees a broken tile.
 */
export async function s4exists(key) {
  if (!s4Enabled || !key) return false;
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? HIT_MS : MISS_MS)) return hit.ok;
  let ok = false;
  await acquire();
  try {
    const response = await fetch(s4url(key, 300, "HEAD"), {
      method: "HEAD",
      signal: AbortSignal.timeout(4_000),
    });
    ok = response.ok;
  } catch {
    ok = false;
  } finally {
    release();
  }
  if (seen.size > 20_000) seen.clear();
  seen.set(key, { ok, at: Date.now() });
  return ok;
}

/** A signed URL that makes the browser save the object, not display it. */
export function s4DownloadUrl(key, filename) {
  const safe = String(filename || "download").replaceAll('"', "'");
  return s4url(key, TTL, "GET", [
    ["response-content-disposition", `attachment; filename="${safe}"`],
  ]);
}

/** Object key for a path relative to an account directory. */
export function s4Key(email, rel) {
  if (!email || !rel) return "";
  return `${email}/${String(rel).replace(/^\/+/, "")}`;
}
