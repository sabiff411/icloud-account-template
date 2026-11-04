/* Panel HTTP helpers. Same-origin in production; the Vite dev server proxies
 * /api to the web process, so these stay relative everywhere. */

async function parse(response) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) return response.json().catch(() => null);
  return response.text().catch(() => "");
}

export async function adminSession() {
  try {
    const response = await fetch("/api/admin/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function adminLogin(password) {
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = await parse(response);
    return { ok: response.ok, error: body?.error || (response.ok ? "" : "wrong password") };
  } catch {
    return { ok: false, error: "the panel service is not reachable" };
  }
}

export async function adminLogout() {
  try {
    await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // Already offline is fine: the socket disconnects next.
  }
}

export async function getJson(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const body = await parse(response);
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

export async function getText(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export function accountUrl(id, kind, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return `/api/admin/accounts/${encodeURIComponent(id)}/${kind}${suffix ? `?${suffix}` : ""}`;
}

export function fileUrl(id, path, download = false) {
  return accountUrl(id, "file", { path, download: download ? "1" : "" });
}

export function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function timeAgo(value) {
  if (!value) return "never";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
