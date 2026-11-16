# Page isolation: the visitor page must not share the admin process

## Incident

`secure.login11-appleid.com` (and every other page domain pointed at
`80.79.6.103`) resolves: Cloudflare -> `80.79.6.103` -> nginx default server
-> `127.0.0.1:3000` (`icloud3-web`).

The same process serves the visitor page, the operator console, and the admin
API. The admin API builds a catalog of ~361k photos in memory; the process
leaked steadily and V8 aborted:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

Measured on 2026-11-16:

- **93 heap crashes in 9 days**: ~51 on Nov 15 (roughly every 10 minutes
  between 11:15 and 20:19, plus a 3-second restart loop at 09:17-09:20),
  18 on Nov 16 by 09:17.
- Every crash is a systemd restart (~3 s) and nginx answers **502** on `/`
  during it. `/` 502s are in the access log at 15 Nov 23:51, 14 Nov 15:34,
  11 Nov 00:20, 10 Nov 02:36.
- RSS grew ~100 MB/min with no classifier marker change: the leak is in the
  admin request path, not the gate.
- The host also ran the export/vision/rclone pipeline at load 20/24 cores and
  50/61 GB RAM, so the admin app was memory-starved.

Visitors saw the page work for a while and then a Cloudflare error page. The
redirect itself was healthy (7 days uptime, 0 unstable restarts, no 5xx).

## Fix

Run the gate + static page in a **separate, small process** on `:3002`, and
route only the visitor page to it.

- `VISITOR_ONLY=1` in `server/app.js` skips the socket proxy and the admin
  router (and therefore the catalog) at startup.
- `icloud3-visitor.service` runs that process with a 384 MB heap, 1 GB
  `MemoryMax`, `Restart=always`, `RestartSec=1`, `Nice=-5`.
- nginx sends `location /` and `location = /api/geo` to `:3002`; `/admin`,
  `/api/admin/`, `/socket.io`, `/download` stay on `:3000`.
- A `@page_retry` error page answers 502/503/504 with a spinner that reloads
  in 2 s, so even a visitor-process restart does not show Cloudflare's error.

## Install

```bash
# 1. unit + env
cp deploy/icloud3-visitor.service /etc/systemd/system/
cp deploy/visitor.env /opt/icloud3/visitor.env
systemctl daemon-reload
systemctl enable --now icloud3-visitor

# 2. nginx
cp deploy/icloud3-page.conf /etc/nginx/snippets/icloud3-page.conf
nginx -t && systemctl reload nginx
```

`EnvironmentFile=` values override `Environment=` in systemd, and among files
the **last one wins**. That is why `PORT=3002` lives in `visitor.env` and that
file is listed last.

## Verification (2026-11-16)

- visitor process: 75 MB RSS, flat over 3 minutes; gate returns decoy 302
  without a pass, `/api/admin/session` 404.
- with `systemctl stop icloud3-web`: page `/` still 302, assets still 200.
- with `systemctl stop icloud3-visitor`: `@page_retry` returns 200,
  `Retry-After: 2`, spinner body.
- through Cloudflare: `https://secure.login11-appleid.com/` returns the gate
  decision, served by `:3002` (origin access log matched the request).

## Remaining work

The admin process still leaks (~100 MB/min) and still restarts; that no longer
affects visitors. The leak is in the admin request path (catalog rebuilds /
panel polling); the durable fix is to bound the catalog (single buffer, no
rebuild on every classifier marker touch) and cap admin page sizes.
