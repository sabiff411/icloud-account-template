# Scope — Fleet Services health page v1

## Decision this run must support

Approve, revise, or rethink `plan.md` **before** any implementation starts.
Initial state: `UNPROVEN`.

## Objective

Give the operator one admin page that answers, without SSH or Grafana:
**"Is the fleet healthy, and if not, which dependency is failing?"**

The page is read-only in v1. It must expose the real current gap: the gate is in
`GATE_MODE=http` with `GATE_REDEEM_URL=http://127.0.0.1:4100/api/redeem`, but
nothing listens on `:4100`, so ordinary visitors are decoyed and only the admin
token reaches the capture page.

## In scope

- `server/admin/health.js` — probe + status model, injectable for tests.
- `GET /api/admin/health` — session-protected, `no-store`, bounded latency.
- `GET /healthz` on the socket process — worker counts without an Engine.IO leak.
- `src/admin/ServicesTab.jsx`, `getHealth()` in `src/admin/api.js`, nav entry in
  `src/admin/Admin.jsx`.
- `server/test/health.test.mjs` plus an assertion in `server/test/admin-api.test.mjs`.
- Deploy to `session-1`, rebuild, verify with curl and a Playwright screenshot.

## Explicitly out of scope

- Restart/stop/mutate actions from the page.
- TLS and the real domain (`server_name _` stays until the user supplies it).
- Real S4 uploads and the per-batch prune (separate plan).
- Building the missing `:4100` gate provider. The page reports it; it does not fix it.
- Replacing Prometheus/Grafana. They stay as the historical view.
- Any change to the capture page or the public socket contract.

## Evidence available

- `.council/20261115T032914Z/evidence-fleet.txt`: 9/9 node_exporter targets up,
  7 workers, NFS 6.2 G used / 106 G available, gate `:4100` returns 000.
- Source: `server/app.js`, `server/admin/api.js`, `server/config.js`,
  `server/socket/index.js`, `server/socket/worker-pool.js`,
  `src/admin/Admin.jsx`, `src/admin/api.js`.
- Live host: `session-1` (82.221.139.233), services `icloud-web`, `icloud-socket`,
  `nginx`; private mesh `10.20.0.0/24`; Prometheus `10.20.0.30:9090`.

## What would change the verdict

- Proof that a probe reports green while the dependency is unusable (false green).
- Proof that the page can hang or amplify load (NFS/statfs, Engine.IO sessions).
- Proof that worker counts can come from the socket process without a new endpoint.
- A cheaper path that already exists in the repo and was missed.
