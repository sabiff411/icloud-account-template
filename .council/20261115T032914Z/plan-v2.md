# Plan v2 — Fleet Services health page

Status: **REVISED** after the blind round and debate. Still UNPROVEN until the acceptance
evidence exists. This file supersedes `plan.md`; the original stays for the record.

## Changes from v1 (finding -> change)

1. **C1 node join.** Use a `node` label from Prometheus (`labels.node`), with a fallback
   that strips `:port` from `labels.instance` and maps `host.docker.internal` to `db-mon-1`.
   `deploy/FLEET.md` remains the fleet map; every node also gets `prometheusInstance`.
   Absent target = red, but acceptance asserts **all 9 rows green before fault injection**.
2. **C2 statfs.** Replace `fs.promises.statfs` with `execFile("df", ["-P", dir])`,
   `timeout: 1200`, `SIGKILL`, single-flight (one in flight), 30 s circuit breaker after a
   timeout, and last-good value served `stale`. No libuv threadpool involvement.
3. **S10 ratio.** Use `df`'s `Use%` = `used / (used + avail)`, not `(blocks-bfree)/blocks`
   (5.5 % vs 5.2 % on the live mount).
4. **D2 socket endpoint.** Drop `/healthz` from v1. Worker counts come from the existing
   `admin:ready` payload in `src/admin/useAdminSocket.js`; no socket edit, no socket restart.
   This makes COR-7, DEV-5, COR-8 and CLI-8 moot except for the `map.md` correction.
5. **D1 edge probes.** Never probe bare `/` with redirect-follow. Probe:
   - `GET ${PANEL_URL}/api/health` (exempt from the gate) -> 200 JSON `ok:true`;
   - `GET ${PANEL_URL}/socket.io/?EIO=4&transport=polling` via nginx -> 200 body starts `0{`;
   - `GET ${PANEL_URL}/?gate=${GATE_ADMIN_TOKEN}` with `redirect:"manual"` -> 302 whose
     `Location` is not `https://www.apple.com/`. This proves the admin capture path.
6. **C4 credentials.** Add `REDIS_URL`, `REDIS_PASSWORD`, `PG_HOST`, `PG_PORT` to
   `server/config.js` and `.env.example`; copy them into `/opt/icloud3/.env` on session-1
   from db-mon-1's secrets. `NOAUTH` is **red** (`server requires a password, none set`).
7. **C3 S4.** No run heartbeat exists. Report: `configured` from `S4_ENDPOINT/S4_KEY`;
   `lastUploadAt` from the newest `Scan/s4-complete.json` under `EXPORT_DIR`; green only
   when configured and a marker exists within 24 h; yellow when unconfigured or no marker.
   No red in v1. The label says `newest completed upload`, not `heartbeat`.
8. **S5 cache.** Cache the in-flight promise (`inflight`), not only the resolved value.
9. **S6 injectable route.** `createAdminRouter({ ..., health })`; `app.js` passes the real
   collector; the API test injects a fixed collector and asserts the whole payload.
10. **S8 fleet override.** Parse `FLEET_NODES_JSON` lazily in `try/catch`; on failure fall
    back to the built-in list and mark the node check `yellow: invalid FLEET_NODES_JSON`.
11. **S9 signature.** `collectHealth({ env = process.env, probes = defaultProbes, now = Date.now() } = {})`.
12. **S4 worker roles.** Do not promise per-role coverage. The UI shows the aggregate
    `workers/auth/export/queued` it already receives; the backend has no worker data.
13. **S3 gate acceptance.** Add a stub provider on `127.0.0.1:4100` returning
    `{ok:true}`; assert gate green and overall not red; stop it; assert red.
14. **Map correction.** `server/socket/index.js:108` calls `listen(port)` with no host, so it
    binds `0.0.0.0`; UFW admits `:4001` only from `10.20.0.0/24`.

## Checks (backend, no worker data)

| id | group | probe | green | yellow | red |
|---|---|---|---|---|---|
| web | edge | `GET PANEL_URL/api/health` | 200 `ok:true` | — | non-200 / timeout |
| socket | edge | Engine.IO handshake via `PANEL_URL/socket.io` | 200 `0{` | — | non-200 / no `0{` |
| gate | edge | `POST GATE_STATUS_URL` + `GATE_ADMIN_TOKEN` capture probe | provider JSON + capture 302/200 | provider answers non-ok | provider unreachable, or capture 302 -> apple.com |
| nfs | data | `df -P EXPORT_DIR` | df ok, <75 % | >=75 % | df fails/timeout, >=90 % |
| postgres | data | TCP `PG_HOST:PG_PORT` | connect | — | refused/timeout |
| redis | data | RESP `AUTH` + `PING` | `+PONG` | — | refused/`NOAUTH`/`-ERR` |
| prometheus | monitoring | `/-/ready` + targets | all targets up | some down | unreachable |
| s4 | storage | env + newest marker | configured + <24 h | unconfigured / no marker | — |
| nodes | monitoring | 9 map rows joined to targets | 9 up | — | any down/absent |

`overall` = worst of the above. The SPA additionally downgrades to red when the admin socket
is disconnected or `workers.workers === 0`.

## API

`GET /api/admin/health` after `requireSession`:

```json
{
  "generatedAt": "...",
  "overall": "red|yellow|green",
  "checks": [ { "id":"nfs", "group":"data", "status":"green", "detail":"...", "dependency":"db-mon-1:/srv/icloud", "latencyMs":3 } ],
  "nodes": [ { "id":"db-mon-1", "role":"data+ops", "privateIp":"10.20.0.30", "status":"green", "detail":"node_exporter up" } ]
}
```

No worker fields in this payload; the UI merges them. `no-store`, 1200 ms probe budget,
2500 ms overall, 5 s in-flight cache.

## Frontend

`ServicesTab.jsx` reads `getHealth()` plus the existing `admin` socket state:
- top: overall, `9/9 nodes`, `N workers`, stale marker, Refresh;
- "Needs attention" red-first list with `label — detail — dependency`;
- cards: Edge, Data, Storage, Monitoring;
- node table: role, private IP, target state;
- worker strip: workers/auth/export/queued (existing values), no per-role claim;
- 15 s refresh, paused when hidden; a failed fetch keeps last data and marks `stale`.

`Admin.jsx`: add `Services` to the existing nav and the `view === "services"` branch.

## Tests

- `health.test.mjs`: injected probes; all-ok green; 76 % yellow; 91 % red; gate unreachable
  red; one rejection red; slow probe returns red; in-flight cache dedupes two concurrent
  calls; `df` parser handles `Use%`; invalid `FLEET_NODES_JSON` falls back yellow.
- `admin-api.test.mjs`: 401 without a cookie; 200 with a fixed injected collector and exact
  `overall/checks/nodes`.
- Gate stub test: start `127.0.0.1:4100` stub -> green; stop -> red.
- `npm run build`.

## Acceptance evidence

1. `curl -b cookie /api/admin/health` -> `overall`, **9 nodes all green**, gate red
   (provider down), S4 yellow, no worker fields.
2. Playwright screenshot `/admin` -> Services, 1440x950, no console errors; worker strip
   shows 7.
3. Fault injection: stop `prometheus-node-exporter` on `ocr-1` -> its row red, Prometheus
   yellow `8/9`; restart -> green.
4. Stub gate provider -> gate green and overall no longer red; stop -> red.
5. `GET /api/admin/health` without a cookie -> 401.
6. Total latency <= 2.5 s with the gate provider down; no `statfs` in the web process.
7. Deploy restarts only `icloud-web`; `icloud-socket` uptime is unchanged and workers stay 7.

## Known weaknesses (unchanged or narrowed)

- Postgres green is TCP-only (`auth not checked`).
- The `df` child is killable, but a hung mount still returns `red` until the circuit breaker
  recovers; the last-good value is marked stale.
- The gate status probe proves the provider answers, not that a fresh token redeems; the stub
  test and the admin-token capture probe narrow the gap.
- nginx is inferred from the edge URLs answering, not from its process.
- Worker counts prove sockets, not work; `queued` and last job age are the next signal.
- Same base model; unanimity is shared bias, not proof.
