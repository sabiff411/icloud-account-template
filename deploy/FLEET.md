# Fleet — 2026-11-15

All 9 VPS: Ubuntu 24.04, UTC, UFW, WireGuard mesh `10.20.0.0/24`.
SSH key: `~/.ssh/icloud_fleet` (installed on all).
NFS: `10.20.0.30:/srv/icloud` mounted on session/download/OCR.

| Host | Public IP | Private | Role | Services |
|---|---|---|---|---|
| session-1 | 82.221.139.233 | 10.20.0.10 | edge/session | nginx, gate, web:3000, socket:4001, dashboard |
| download-1 | 82.221.141.4 | 10.20.0.21 | download | Python worker, bulk shard 0, unzip watcher |
| download-2 | 82.221.141.30 | 10.20.0.22 | download | Python worker, bulk shard 1, unzip watcher |
| db-mon-1 | 82.221.141.135 | 10.20.0.30 | data+ops | NFS, Postgres 16, Redis 7, Prometheus:9090, Grafana:3000, Uptime:3001 |
| ocr-1 | 82.221.141.157 | 10.20.0.41 | OCR | Python worker, scan 3 workers |
| ocr-2 | 82.221.141.162 | 10.20.0.42 | OCR | Python worker, scan 3 workers |
| ocr-3 | 82.221.141.170 | 10.20.0.43 | OCR | Python worker, scan 3 workers |
| ocr-4 | 82.221.141.190 | 10.20.0.44 | OCR | Python worker, scan 3 workers |
| ocr-5 | 82.221.141.208 | 10.20.0.45 | OCR | Python worker, scan 3 workers |

## Live now
- `http://82.221.139.233/?gate=<GATE_TOKEN>` — capture page
- `http://82.221.139.233/admin` — dashboard
- Admin socket: 7 workers connected (2 download + 5 OCR)
- NFS: `/srv/icloud/{export,sessions,store}` on db-mon, mounted everywhere
- Postgres `icloud` on `10.20.0.30:5432`, Redis `10.20.0.30:6379`
- Prometheus `10.20.0.30:9090`, Grafana `10.20.0.30:3000`, Uptime `10.20.0.30:3001`
- `node_exporter` on all 9

## Secrets
- session-1: `/root/fleet-secrets.txt` — ADMIN_PASSWORD, GATE_TOKEN, WORKER_TOKEN, ADMIN_SESSION_SECRET
- db-mon-1: `/root/fleet-secrets.txt` — DB_PASSWORD, REDIS_PASSWORD, GRAFANA_PASSWORD

## Admin Services page
- `http://82.221.139.233/admin` -> **Services** (read-only fleet health).
- `GET /api/admin/health` — admin cookie, `no-store`; probes nginx/web, Engine.IO,
  gate provider + capture SPA, NFS (`df` child), Postgres TCP, Redis AUTH/PING,
  Prometheus, S4 configuration; 9-node table; red node moves the headline.
- Worker counts push over the admin socket (`admin:workers`) on connect/disconnect.
- Env on session-1: `PROMETHEUS_URL`, `REDIS_URL`, `REDIS_PASSWORD`,
  `PG_HOST`, `PG_PORT`, `PUBLIC_IP`, `GATE_ADMIN_IPS=82.221.139.233`.
- Prometheus scrape config now carries `labels.node` for all 9 targets
  (`/opt/mon/prometheus/prometheus.yml` on db-mon-1).

## Pending
- Domain + TLS (nginx `server_name _` now). Plan: apex + `*.example.com` -> 82.221.139.233;
  nginx routes admin/grafana/status by Host; wildcard TLS needs DNS-01.
- Gate provider on `:4100` is absent. `GATE_MODE=http` decoys ordinary visitors;
  only `?gate=<GATE_ADMIN_TOKEN>` reaches the capture page. Services shows it red.
- S4 keys are empty; Services shows S4 yellow and uploads stay on local NFS.
- S4 keys: `S4_ENDPOINT/S4_KEY/S4_SECRET` on session, rclone remote `s4:icld` on download nodes
- Proxy: `ANYIP_PROXY_URL`; currently `DOWNLOAD_DIRECT=1` for bulk
- `S4_UPLOAD=0` until the rclone remote exists; then set 1 and start `s4_upload --watch --prune`
- Admin Services health page (Prometheus/Grafana are up)
