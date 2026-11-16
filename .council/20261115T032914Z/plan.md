# Plan — Fleet Services health page v1

Status: **UNPROVEN**. Nothing below is implemented yet.

## 1. Problem

The fleet is up (9 VPS, 7 workers, NFS, Postgres/Redis, Prometheus 9/9), but the
only way to know that is SSH plus Grafana. The dashboard shows accounts and
workers, not infrastructure. The gate is silently broken for normal visitors:
`GATE_MODE=http` points at `127.0.0.1:4100`, nothing listens there, and the gate
decoy redirects anyone without the admin token. The operator cannot see that from
the panel.

## 2. Status model

Every check returns:

```json
{
  "id": "nfs",
  "label": "Shared NFS",
  "group": "data",
  "status": "green|yellow|red",
  "detail": "6.2 GB used, 106 GB free (5.5%)",
  "dependency": "db-mon-1:/srv/icloud",
  "checkedAt": "2026-11-15T03:29:14.000Z",
  "latencyMs": 3
}
```

`overall` is `red` if any check is red, else `yellow` if any is yellow, else
`green`. A check that cannot be evaluated is `red` with the reason in `detail`,
never `green`.

Thresholds:

| Check | green | yellow | red |
|---|---|---|---|
| web | request answered | — | process answer failed |
| socket `/healthz` | 200 + JSON | 200 but 0 workers | unreachable / timeout |
| gate http mode | status endpoint answers JSON | answers but not `ok` (e.g. `mode_paused`) | unreachable |
| gate db mode | DB file exists and is readable | file missing | unreadable |
| nfs | statfs ok, < 75 % used | >= 75 % used | statfs error / timeout / >= 90 % |
| postgres | TCP 5432 accepts | — | refused / timeout |
| redis | `AUTH` + `PING` -> `PONG` | `NOAUTH` (password missing) | refused / timeout / `-ERR` |
| prometheus | `/-/ready` + targets parsed | some targets down | unreachable |
| s4 | configured + heartbeat < 10 min | configured, no/stale heartbeat, or env empty | configured and last run failed |
| workers | >= 1 per expected role | fewer than expected | 0 |

Postgres is **TCP-only** in v1; the detail string must say
`"TCP 5432 reachable (auth not checked)"` so the green is not overclaimed.

## 3. Backend

### 3.1 `server/admin/health.js`

- `collectHealth({ env, probes, now })` — pure orchestration, probes injected.
- `probeTcp(host, port, timeoutMs)` — `node:net`, resolves `{ ok, ms, error }`.
- `probeRedis(url, password)` — raw RESP `AUTH` (if a password is set) then
  `PING`; accepts `+PONG`; reads at most 256 bytes.
- `probeHttp(url, timeoutMs)` — `fetch` with `AbortSignal.timeout`.
- `probeNfs(dir)` — `fs.promises.statfs` (NFSv4), computes used ratio.
- `probeGate(env)` — if `GATE_MODE=db`, `fs.access(GATE_DB_PATH)`; else
  `POST GATE_STATUS_URL` with `x-gate-secret` and body `{ ip: "127.0.0.1", dev: "" }`.
- `probePrometheus(base)` — `/-/ready`, then `/api/v1/targets?state=active`.
- `probeSocket(base)` — `GET http://127.0.0.1:${SOCKET_PORT}/healthz`.
- All probes run through `Promise.allSettled` with a 1200 ms per-probe budget and
  a 2500 ms overall guard. No new npm dependency.
- Results are cached for 5 s (`HEALTH_CACHE_MS`) so several admin tabs do not
  multiply probes.

### 3.2 Socket `/healthz`

`server/socket/index.js` currently answers every request with `socket.io server`.
Change the plain HTTP handler to:

- `GET /healthz` -> `200 {"ok":true,"uptime":…,"workers":{...},"accounts":…}`
- anything else -> the existing text response, so Engine.IO paths are untouched.

`WorkerPool` gets `snapshot()` returning `{ workers, auth, export, scan, queued }`
from its existing maps (same numbers already emitted in `admin:ready`).

This removes the need for the web process to open an Engine.IO client, and it
gives the backend the worker count without the frontend merging it.

### 3.3 Route

In `server/admin/api.js`, after `router.use(requireSession)`:

```js
router.get("/health", asyncRoute(async (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json(await collectHealth());
}));
```

Unauthenticated callers get the existing 401 shape. The route never writes
anything and never touches the store.

### 3.4 Fleet map

`server/admin/fleet.js` exports the 9 nodes from `deploy/FLEET.md`
(`id`, `publicIp`, `privateIp`, `role`). `FLEET_NODES_JSON` overrides it.
The node table is joined to Prometheus target health by private IP; a target that
is absent is `red` with `"no node_exporter target"`.

## 4. Frontend

- `src/admin/api.js`: `getHealth()` -> `getJson("/api/admin/health")`.
- `src/admin/ServicesTab.jsx`:
  - top row: overall pill, `9/9 nodes`, `7 workers`, last refresh, Refresh button;
  - a "Needs attention" list, red first, each row `label — detail — dependency`;
  - grouped cards: Edge (web, socket, gate, nginx via PANEL_URL), Data (NFS,
    Postgres, Redis), Workers (counts by role), Storage (S4, disk), Monitoring
    (Prometheus, Grafana link, Uptime link);
  - node table with role, private IP, node_exporter state, and the service the
    node owns;
  - auto-refresh every 15 s, paused when the tab is hidden; a failed fetch keeps
    the last data and marks it `stale`, never blank.
- `Admin.jsx`: add `Services` next to `Accounts | Library | Crypto | Submissions`
  with `view === "services"` and `<ServicesTab />`.

Styling follows the existing panel: white cards, `#e5e5ea` borders, 12 px text,
green `#1a7f37`, yellow `#9a6700`, red `#c4000a`, no external UI dependency.

## 5. Tests

- `server/test/health.test.mjs`:
  - all probes ok -> `overall=green`;
  - nfs 76 % -> `yellow`, 91 % -> `red`;
  - gate unreachable -> `red` and `dependency` contains `4100`;
  - one probe rejects -> that check `red`, others still returned;
  - 2 s probe -> total call returns and marks the slow check `red`;
  - cache returns the same object within 5 s.
- `server/test/admin-api.test.mjs`: `GET /api/admin/health` without a cookie is
  401; with a session it is 200 and has `checks` + `nodes`.
- `npm run build` and `node server/test/health.test.mjs`.

## 6. Deploy + acceptance evidence

1. Build and rsync `dist/`, `server/`, `package.json` to `session-1:/opt/icloud3`.
2. `systemctl restart icloud-web icloud-socket`; both active.
3. `curl -b <admin cookie> http://127.0.0.1:3000/api/admin/health` returns
   `overall`, 9 nodes, 7 workers, gate red, S4 yellow.
4. Playwright screenshot of `/admin` -> Services, 1440x950, no console errors.
5. Fault injection: stop `prometheus-node-exporter` on `ocr-1` for 30 s ->
   the ocr-1 row goes red and the Prometheus card turns yellow with
   `8/9 targets up`; restart and confirm green again.
6. `GET /api/admin/health` without the cookie is 401.

Acceptance is only met when 3, 4, 5 and 6 are attached under `evidence/`.

## 7. Known weaknesses (must be stated, not hidden)

- Postgres green is TCP-only; auth and query health are not proven.
- `statfs` on a hard-mounted NFS can block in the kernel; the 1200 ms race
  returns a red result but the request thread may stay until the mount recovers.
- The gate probe proves the provider answers, not that a freshly issued token
  redeems; that needs a token fixture and is a follow-up.
- `nginx` is inferred from `PANEL_URL` answering, not from its process.
- Worker counts prove sockets are connected, not that a worker is doing work;
  `queued` and last job age are the next signal.
- The same base model reviews this plan, so agreement is not independent proof.
