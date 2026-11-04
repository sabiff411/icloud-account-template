/* Client address + country header helpers.
 *
 * The app is normally behind a reverse proxy (nginx, Cloudflare, a Runpod
 * proxy, ...), so `req.socket.remoteAddress` is the proxy.  We only trust
 * forwarded headers; set `trust proxy` on the Express app to the same topology
 * if you need Express itself to evaluate them. */

const PRIVATE =
  /^(::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function clientIp(req) {
  const headers = req.headers ?? {};

  const candidates = [
    headers["cf-connecting-ip"],
    headers["true-client-ip"],
    headers["x-real-ip"],
    // x-forwarded-for may contain a chain; the first entry is the client.
    String(headers["x-forwarded-for"] ?? "").split(",")[0],
    req.socket?.remoteAddress,
    req.ip,
  ];

  for (const value of candidates) {
    const ip = cleanIp(value);
    if (ip) return ip;
  }
  return "";
}

export function cleanIp(value) {
  if (!value) return "";
  let ip = String(value).trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1") ip = "127.0.0.1";
  return ip;
}

export function isPrivateIp(ip) {
  return !ip || PRIVATE.test(ip) || ip === "localhost";
}

export function countryHeader(req) {
  const h = req.headers ?? {};
  const raw =
    h["cf-ipcountry"] ?? h["x-country-code"] ?? h["x-vercel-ip-country"] ?? "";
  const code = String(raw).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : "";
}

export function countryName(code) {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
