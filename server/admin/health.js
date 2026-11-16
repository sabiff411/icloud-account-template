import { execFile } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fleetNodes } from "./fleet.js";

const execFileP = promisify(execFile);
const RANK = { green: 0, yellow: 1, red: 2 };
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const SPEC = {
  web: { label: "Web / nginx", group: "edge" },
  socket: { label: "Socket.IO", group: "edge" },
  gate: { label: "Gate provider", group: "edge" },
  capture: { label: "Capture path", group: "edge" },
  nfs: { label: "Shared NFS", group: "data" },
  postgres: { label: "PostgreSQL", group: "data" },
  redis: { label: "Redis", group: "data" },
  prometheus: { label: "Prometheus", group: "monitoring" },
  s4: { label: "MEGA S4", group: "storage" },
};

function num(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function worst(statuses) {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green");
}

export function cleanOrigin(panelUrl, port = 3000) {
  try {
    return new URL(panelUrl).origin;
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}

/** Exact IPv4 or IPv4 CIDR, mirroring gate.js's ipInList (which is not
 *  exported).  A DNS hostname is not enough after TLS: compare the probe's
 *  public source IP. */
export function ipInList(ip, entry) {
  const value = String(ip ?? "").trim();
  const item = String(entry ?? "").trim();
  if (!value || !item) return false;
  if (item === "*") return true;
  if (item === value) return true;
  const [net, bits] = item.split("/");
  if (!bits || !value.includes(".") || !net || net.includes(":")) return false;
  const address = value.split(".").map(Number);
  const network = net.split(".").map(Number);
  const width = Number(bits);
  if (address.length !== 4 || network.length !== 4 || !Number.isFinite(width) || width < 0 || width > 32) return false;
  const pack = (octets) => ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
  return (pack(address) & mask) === (pack(network) & mask);
}

function withBudget(promise, ms, label = "probe") {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "red", detail: `${label} timed out after ${ms} ms` }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function json(url, options = {}, ms = 1200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body, headers: response.headers };
}

async function text(url, options = {}, ms = 1200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  return { ok: response.ok, status: response.status, body: await response.text().catch(() => ""), headers: response.headers };
}

/** Parse one `df -P` row.  Use df's Use% = used / (used + available), which is
 *  the number an operator sees, not (blocks - bfree) / blocks. */
export function parseDf(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  const parts = line.split(/\s+/);
  if (parts.length < 6) return null;
  const percent = Number.parseInt(String(parts[4]).replace("%", ""), 10);
  if (!Number.isFinite(percent)) return null;
  return {
    filesystem: parts[0],
    blocks: Number(parts[1]) || 0,
    used: Number(parts[2]) || 0,
    available: Number(parts[3]) || 0,
    percent,
    mount: parts.slice(5).join(" "),
  };
}

let nfsBreakerUntil = 0;
let nfsLast = null;

export function nfsTone(percent) {
  return percent >= 90 ? "red" : percent >= 75 ? "yellow" : "green";
}

async function probeDf(dir, ms = 1200) {
  const started = Date.now();
  if (Date.now() < nfsBreakerUntil && nfsLast) {
    return { ...nfsLast, detail: `${nfsLast.detail} (breaker)`, latencyMs: 0 };
  }
  try {
    const { stdout } = await execFileP("df", ["-P", dir], {
      timeout: ms,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    const row = parseDf(stdout);
    if (!row) return { status: "red", detail: "df returned an unreadable row", dependency: dir, latencyMs: Date.now() - started };
    const status = nfsTone(row.percent);
    nfsBreakerUntil = 0;
    return {
      status,
      detail: `${row.percent}% used · ${Math.round(row.available / 1024 / 1024)} GB free on ${row.mount}`,
      dependency: row.filesystem,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    nfsBreakerUntil = Date.now() + 30_000;
    nfsLast = { status: "red", detail: `df failed: ${error.message}`, dependency: dir, latencyMs: Date.now() - started };
    return nfsLast;
  }
}

function probeTcp(host, port, ms = 1200) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (status, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, detail, dependency: `${host}:${port}`, latencyMs: Date.now() - started });
    };
    const timer = setTimeout(() => done("red", `timeout after ${ms} ms`), ms);
    timer.unref?.();
    socket.once("connect", () => done("green", `TCP ${host}:${port} reachable (auth not checked)`));
    socket.once("error", (error) => done("red", error.code || error.message));
  });
}

function resp(...parts) {
  return `*${parts.length}\r\n` + parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("");
}

function probeRedis(url, password, ms = 1200) {
  const started = Date.now();
  let host = "10.20.0.30";
  let port = 6379;
  try {
    const parsed = new URL(url);
    host = parsed.hostname || host;
    port = num(parsed.port, port);
    if (parsed.password) password = decodeURIComponent(parsed.password);
  } catch {
    /* keep defaults */
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    let buffer = "";
    const done = (status, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, detail, dependency: `${host}:${port}`, latencyMs: Date.now() - started });
    };
    const timer = setTimeout(() => done("red", `timeout after ${ms} ms`), ms);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(password ? resp("AUTH", password) + resp("PING") : resp("PING")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("+PONG")) return done("green", "AUTH + PING -> PONG");
      if (buffer.includes("-NOAUTH")) return done("red", "NOAUTH: no password configured");
      if (buffer.includes("-WRONGPASS") || buffer.includes("-ERR")) return done("red", buffer.trim().slice(0, 120));
    });
    socket.once("error", (error) => done("red", error.code || error.message));
  });
}

/** Probe the visitor path through nginx, then close the Engine.IO session so a
 *  15 s refresh does not accumulate half-open clients (completeness U-2). */
async function probeSocket(origin, ms = 1200) {
  const started = Date.now();
  try {
    const result = await text(`${origin}/socket.io/?EIO=4&transport=polling`, {}, ms);
    const sid = (result.body.match(/"sid":"([^"]+)"/) || [])[1] || "";
    if (!result.ok || !result.body.startsWith("0{")) {
      return { status: "red", detail: `handshake HTTP ${result.status}`, dependency: origin, latencyMs: Date.now() - started };
    }
    if (sid) {
      try {
        await fetch(`${origin}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, {
          method: "POST",
          body: "1",
          headers: { "content-type": "text/plain" },
          signal: AbortSignal.timeout(300),
        });
      } catch {
        /* the session expires on its own */
      }
    }
    return { status: "green", detail: "Engine.IO handshake via nginx", dependency: origin, latencyMs: Date.now() - started };
  } catch (error) {
    return { status: "red", detail: error.message, dependency: origin, latencyMs: Date.now() - started };
  }
}

async function probeGate(env, ms = 1200) {
  const mode = String(env.GATE_MODE ?? "").toLowerCase();
  if (mode === "db") {
    const file = String(env.GATE_DB_PATH ?? "");
    if (!file) return { status: "red", detail: "GATE_MODE=db but GATE_DB_PATH is empty", dependency: "gate db" };
    try {
      await fs.access(file);
      return { status: "green", detail: `shared gate db readable`, dependency: file };
    } catch (error) {
      return { status: "red", detail: `gate db: ${error.code || error.message}`, dependency: file };
    }
  }
  const statusUrl =
    String(env.GATE_STATUS_URL ?? "") ||
    String(env.GATE_REDEEM_URL ?? "").replace(/\/redeem\/?$/, "/status");
  if (!statusUrl) return { status: "yellow", detail: "GATE_STATUS_URL is not set", dependency: "gate provider" };
  try {
    const result = await json(
      statusUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-gate-secret": String(env.GATE_SECRET ?? "") },
        body: JSON.stringify({ ip: "127.0.0.1", dev: "" }),
      },
      ms,
    );
    if (!result.ok) return { status: "red", detail: `status HTTP ${result.status}`, dependency: statusUrl };
    if (result.body?.ok === false) {
      return { status: "yellow", detail: `status ${result.body.reason || "not ok"}`, dependency: statusUrl };
    }
    return { status: "green", detail: "gate status endpoint answers ok", dependency: statusUrl };
  } catch (error) {
    return { status: "red", detail: `unreachable: ${error.message} (start the :4100 provider)`, dependency: statusUrl };
  }
}

async function probeCapture(env, panelUrl, ms = 1200) {
  const token = String(env.GATE_ADMIN_TOKEN ?? "");
  const origin = cleanOrigin(panelUrl, num(env.PORT, 3000));
  let host = "";
  try {
    host = new URL(panelUrl).hostname;
  } catch {
    host = "";
  }
  const adminIps = String(env.GATE_ADMIN_IPS ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  /* Prefer the admin-IP allowlist: no token in the query string, so nginx's
   * access log does not collect the gate's master bypass every 15 s. */
  const sourceIp = String(env.PUBLIC_IP ?? "").trim() || host;
  const byIp = Boolean(sourceIp && adminIps.some((entry) => ipInList(sourceIp, entry)));
  const useToken = token && !byIp;
  if (!byIp && !token) return { status: "yellow", detail: "neither GATE_ADMIN_IPS nor GATE_ADMIN_TOKEN is set", dependency: "gate session" };
  const url = useToken
    ? `${origin}/?gate=${encodeURIComponent(token)}`
    : `${origin}/`;
  try {
    const result = await text(
      url,
      {
        redirect: "manual",
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "upgrade-insecure-requests": "1",
        },
      },
      ms,
    );
    const location = result.headers.get("location") || "";
    const capturePage = /Apple Account: Sign-in and Manage/i.test(result.body);
    if (result.status === 302 && location.includes("apple.com")) {
      return { status: "red", detail: "gate sent the admin path to the decoy", dependency: "gate session" };
    }
    if (result.status === 302 && !location.includes("apple.com")) {
      return { status: "green", detail: `capture path HTTP 302 -> ${location}`, dependency: "gate session" };
    }
    if (result.status === 200 && capturePage) {
      return { status: "green", detail: "capture SPA served", dependency: "gate session" };
    }
    return { status: "red", detail: `capture path HTTP ${result.status}${capturePage ? "" : " (not the capture SPA)"}`, dependency: "gate session" };
  } catch (error) {
    return { status: "red", detail: error.message, dependency: "capture path" };
  }
}

async function probeS4(env, exportDir, ms = 1200) {
  const configured = Boolean(env.S4_ENDPOINT && env.S4_KEY);
  if (!configured) {
    return { status: "yellow", detail: "not configured: S4_ENDPOINT / S4_KEY empty", dependency: "MEGA S4" };
  }
  let newest = 0;
  try {
    const entries = await fs.readdir(exportDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const stat = await fs.stat(path.join(exportDir, entry.name, "Scan", "s4-complete.json"));
            newest = Math.max(newest, stat.mtimeMs);
          } catch {
            /* no completed upload for this account */
          }
        }),
    );
  } catch (error) {
    return { status: "yellow", detail: `export tree unreadable: ${error.code || error.message}`, dependency: exportDir };
  }
  if (!newest) return { status: "yellow", detail: "configured, no completed upload yet", dependency: exportDir };
  const hours = (Date.now() - newest) / 3600_000;
  return {
    status: hours <= 24 ? "green" : "yellow",
    detail: `newest completed upload ${hours.toFixed(1)} h ago`,
    dependency: "newest s4-complete.json",
  };
}

export function joinNodeHealth(nodes, targets) {
  return nodes.map((node) => {
    const target =
      targets.find((item) => item.node === node.id) ||
      targets.find((item) => item.instance === node.prometheus) ||
      targets.find((item) => item.instance.startsWith(`${node.privateIp}:`));
    const up = target?.health === "up";
    return {
      id: node.id,
      role: node.role,
      privateIp: node.privateIp,
      health: target?.health || "missing",
      status: up ? "green" : "red",
      detail: up ? "node_exporter up" : target ? `node_exporter ${target.health}` : "no node_exporter target",
    };
  });
}

async function probePrometheus(base, env, ms = 1200) {
  const started = Date.now();
  const fleet = fleetNodes(env);
  try {
    const ready = await text(`${base}/-/ready`, {}, ms);
    if (!ready.ok) return { status: "red", detail: `/-/ready HTTP ${ready.status}`, dependency: base, latencyMs: Date.now() - started };
    const result = await json(`${base}/api/v1/targets?state=active`, {}, ms);
    if (!result.ok || !result.body?.data) {
      return { status: "red", detail: `targets HTTP ${result.status}`, dependency: base, latencyMs: Date.now() - started };
    }
    const targets = (result.body.data.activeTargets || []).map((target) => ({
      instance: target.labels?.instance || "",
      node: target.labels?.node || "",
      health: target.health || "unknown",
    }));
    const nodes = joinNodeHealth(fleet.nodes, targets);
    const up = targets.filter((target) => target.health === "up").length;
    const status = targets.length > 0 && up === targets.length ? "green" : up > 0 ? "yellow" : "red";
    return {
      status,
      detail: `${up}/${targets.length} targets up${fleet.warning ? ` · ${fleet.warning}` : ""}`,
      dependency: base,
      latencyMs: Date.now() - started,
      nodes,
    };
  } catch (error) {
    return {
      status: "red",
      detail: error.message,
      dependency: base,
      latencyMs: Date.now() - started,
      nodes: fleet.nodes.map((node) => ({ ...node, health: "missing", status: "red", detail: "prometheus unreachable" })),
    };
  }
}

export function defaultProbes({ env = process.env, exportDir = env.EXPORT_DIR || "./export", panelUrl = env.PANEL_URL || `http://127.0.0.1:${num(env.PORT, 3000)}` } = {}) {
  const origin = cleanOrigin(panelUrl, num(env.PORT, 3000));
  return {
    web: async () => {
      try {
        const result = await json(`${origin}/api/health`, {}, 1200);
        return result.ok && result.body?.ok
          ? { status: "green", detail: `nginx -> web HTTP ${result.status}`, dependency: origin }
          : { status: "red", detail: `nginx -> web HTTP ${result.status}`, dependency: origin };
      } catch (error) {
        return { status: "red", detail: error.message, dependency: origin };
      }
    },
    socket: () => probeSocket(origin),
    gate: () => probeGate(env),
    capture: () => probeCapture(env, panelUrl),
    nfs: () => probeDf(exportDir),
    postgres: () => probeTcp(env.PG_HOST || "10.20.0.30", num(env.PG_PORT, 5432)),
    redis: () => probeRedis(env.REDIS_URL || "redis://10.20.0.30:6379", env.REDIS_PASSWORD || ""),
    prometheus: () => probePrometheus(env.PROMETHEUS_URL || "http://10.20.0.30:9090", env),
    s4: () => probeS4(env, exportDir),
  };
}

/** Create a cached collector.  The in-flight promise is cached too, so N tabs
 *  opened at once share one sweep (correctness COR-5). */
export function createHealthCollector({
  env = process.env,
  exportDir = env.EXPORT_DIR || "./export",
  panelUrl = env.PANEL_URL || `http://127.0.0.1:${num(env.PORT, 3000)}`,
  probes = defaultProbes({ env, exportDir, panelUrl }),
  budgetMs = 1200,
  cacheMs = 5000,
  now = Date.now,
} = {}) {
  let inflight = null;
  let last = null;
  let lastAt = 0;

  async function run() {
    const settled = await Promise.all(
      Object.entries(probes).map(async ([id, probe]) => {
        const started = now();
        try {
          const result = await withBudget(Promise.resolve().then(probe), budgetMs, id);
          return { id, ...result, latencyMs: result?.latencyMs ?? now() - started };
        } catch (error) {
          return { id, status: "red", detail: error.message || "probe failed", latencyMs: now() - started };
        }
      }),
    );
    const checks = settled.map((result) => ({
      id: result.id,
      label: SPEC[result.id]?.label || result.id,
      group: SPEC[result.id]?.group || "other",
      status: result.status || "red",
      detail: result.detail || "",
      dependency: result.dependency || "",
      latencyMs: result.latencyMs || 0,
    }));
    const nodes = settled.find((result) => result.id === "prometheus")?.nodes || [];
    return {
      generatedAt: new Date(now()).toISOString(),
      // A dead node must move the headline too: the Prometheus check is only
      // yellow for 8/9, but the node row is red and the operator must see it.
      overall: worst([...checks.map((check) => check.status), ...nodes.map((node) => node.status || "red")]),
      checks,
      nodes,
    };
  }

  return async function collect() {
    if (inflight) return inflight;
    if (last && now() - lastAt < cacheMs) return last;
    inflight = run()
      .then((result) => {
        last = result;
        lastAt = now();
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
