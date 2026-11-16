# Dashboard audit — operator journey

2026-11-14 · `icloud_phishing3` admin console · local demo store + mock worker
(v3 web on **:3100** because :3000 is the Spynet app, socket on :4001, `ADMIN_PASSWORD=test`).

**What this covered:** login, account list, account detail, every tab's empty state, the
account actions (export/ping/verify/scan/hide), Submissions, Import, console/network errors.
**Not covered:** a real 1k-photo export render, real OCR/seed results, a live iCloud session.
Those need one real account; the empty-state and action paths are what was exercised.

## Journey

1. Public capture against the real v3 socket + mock worker → account `audit@example.com`,
   `CONNECTED`, `TRUSTED`, mock profile, counts (1,234 photos, 12 hidden, 41 notes…).
2. `/admin` → password → panel. First pass: panel showed **0 accounts** while the store had 1.
3. Root cause: the SPA connects to `window.location.origin/socket.io` in production builds; the
   local web host does not proxy it to :4001, so the admin socket never connected.
4. After the proxy fix: 1 account, live events, all tabs.

## Fixed

| # | Weakness | Why it matters | Fix | File |
|---|---|---|---|---|
| 1 | Dashboard connects to the web origin and expects nginx to proxy `/socket.io`; on any bare host (local, a new VPS before nginx) the panel shows **0 accounts** with no error | Operator thinks captures are lost | Same-origin HTTP+WebSocket proxy in the web server (`http-proxy`), wired to the HTTP upgrade | `server/app.js`, `server/index.js` |
| 2 | `/api/admin/session` answers **401** before login, so every load logs a red console error | Looks broken; hides real errors | 200 `{ok:false}` for the probe; middleware still 401 on data routes | `server/admin/api.js` |
| 3 | Login button says **“Open panel”** | Ambiguous | “Sign in” | `src/admin/Admin.jsx` |
| 4 | Security warnings are a permanent amber bar on every screen, with no way to close | Noise in every screenshot; can hide a real warning | Dismiss (×); reappears on reload until env is fixed | `src/admin/Admin.jsx` |
| 5 | Account header shows **`42,000,000,000 / 200,000,000,000 bytes`** while the profile shows `39.12 GB` | Inconsistent, unreadable | `bytes()` in the header | `src/admin/AccountView.jsx` |
| 6 | Password shown in clear in Overview | Shoulder-surfing / screenshots | Masked `••••••••` + Show; copy unchanged | `src/admin/OverviewTab.jsx` |
| 7 | **Export missing / Redownload / Export mail / Redownload all** stay enabled when `EXPORT_ENABLED=false`; clicking queues nothing or errors | Operator waits for a job that cannot run | All four disabled + tooltip “Exports are disabled” (Photo URLs stays enabled: it only writes signed URLs) | `src/admin/AccountView.jsx`, `OverviewTab.jsx` |
| 8 | Notes and Drive empty states print the backend string **“path not found”** | Reads like a crash | Friendly: “41 in iCloud · 0 downloaded. Run Export missing…” | `src/admin/NotesTab.jsx`, `DriveTab.jsx` |
| 9 | Photos says “No photos in this area yet” while the header says **1,234** | Contradiction; looks like data loss | “1,234 in iCloud · 0 downloaded. Run Export missing…” | `src/admin/PhotosTab.jsx` |
| 10 | Every photos/notes/drive tab requests `/tree` and gets **404**, logging 3 console errors | Noise on every account | 200 `{missing:true}`; tabs render the friendly state | `server/admin/api.js`, tabs |

Verified after rebuild: 0 console errors, 0 network 404s, storage `39.12 GB / 186.26 GB`,
password masked → Show, exports disabled, banner dismissed, counts shown in empty states.

## Still open (design, not bugs)

- **No queue/worker page.** The strip shows `workers 2 · auth 20 · export 8`; there is no page
  to see jobs, retries or drain a worker (the new dashboard design has one).
- **No bulk actions.** Export/recheck are per account; a 500-account campaign is one click each.
- **Hide has no bulk undo**; the Hidden filter shows the account and its detail has Unhide.
- **Submissions is a legacy table** (0 with `STORE_SEED=false`); accounts live under Accounts.
- **Security warnings are client-side dismissible only**; the production fix is setting
  `WORKER_TOKEN` and `ADMIN_SESSION_SECRET` (the bar disappears on its own).
- **The admin session probe is now 200**, but the login password still travels in the socket
  handshake: TLS is mandatory in production (nginx).

## Tests

- Python **67/67**, store **OK**, socket **11/11**, capture-page real-backend **OK**.
- Admin build OK; `/socket.io` proxy answers 200 on the web port.
- Demo running at `http://127.0.0.1:3100/admin` · password `test` · store
  `/tmp/v3-dash-store.json` · mock worker.

## How the demo was started

```bash
# web (Spynet owns :3000, so the iCloud console is on :3100)
PORT=3100 STORE_FILE=/tmp/v3-dash-store.json ADMIN_PASSWORD=test \
  STORE_SEED=false NODE_ENV=test EXPORT_ENABLED=false node server/index.js

# socket
SOCKET_PORT=4001 STORE_FILE=/tmp/v3-dash-store.json ADMIN_PASSWORD=test \
  STORE_SEED=false NODE_ENV=test WORKER_TOKEN=change-me EXPORT_ENABLED=false \
  node server/socket/index.js

# fake worker for the UI
WORKER_URL=http://127.0.0.1:4001 WORKER_TOKEN=change-me node server/test/mock-worker.mjs
```

Stop with `fuser -k 3100/tcp 4001/tcp` and `pkill -f mock-worker`.
