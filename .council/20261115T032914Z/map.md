# Map — Fleet Services health page v1

## 1. Admin router mount / requireSession
- `server/app.js:56-68` mounts `createAdminRouter({...})` at `/api/admin`, before `/api/geo` (70), gate (104), static (107), SPA fallback (124), 404 (136), error (141).
- Mount order vs gate is not load-bearing for API: `/api/` is exempt (`server/gate.js:473-479`, applied 580).
- `requireSession` defined `server/admin/api.js:177-182`; applied globally at `api.js:217`, after `/login` (184), `/logout` (204), `/session` (210). `/storage` (411) and `/library` (435) re-add it redundantly.

## 2. api.js shape
- Imports 1-29; `asyncRoute` 37-39 (`Promise.resolve(...).catch(next)`); factory 125-135.
- Router error handler 743-746; catalog warm timer 751-753; `return router` 755.
- `GET /health` fits immediately after 217 (before `accountFor`, 219). Below 743 it loses the JSON error contract.

## 3. Socket HTTP server / pool
- `server/socket/index.js:20-23`: `http.createServer` callback answers every path `socket.io server`; `new Server(httpServer)` 25-33; `listen` 108. A `/healthz` branch belongs in that callback, keeping the default text for Engine.IO paths.
- Pool: `this.workers` Map `socket.id -> {socket, slots, connectedAt}` (`worker-pool.js:105`, 1450-1456); `this.queue` 106. `slots` set `{auth,export}` at 1453, overwritten by `ready()` 1458-1464 from `workerSlots` 75-84 (also `scan`). `removeWorker` 1503-1506. `workerCount()` 1534-1536; `slotStats()` 1538-1546 reads `workers.size`, sums `worker.slots.auth/export`, `queue.length` — the fields a `snapshot()` would read.

## 4. Admin.jsx
- `view` state `src/admin/Admin.jsx:259`; nav buttons 368-405 call `setView`; content chain 718-723 (`submissions`/`crypto`/`library`, then AccountView).
- Services: button after Submissions (398-405); `view === "services"` branch first in the 718 chain.

## 5. Tests
- `server/test/admin-api.test.mjs`: temp tree 13-24, fixture store 120-140, express+router 183-200, port 0 203-205, cookie helper 206-233, teardown 385-386. Add the health assertion in the request section near 300.
- Unit style: `server/test/library.test.mjs:1-12` and `views.test.mjs:1-12` import functions directly and assert. One npm script per file (`package.json:22-40`); no runner.

## 6. Invariants
- Store owned by socket; web reads `storeFile` mtime-cached only (`socket/index.js:14-15`, `api.js:31-35`, 158-171).
- Web/socket split: web proxies `/socket.io` (`app.js:38-54`, 150-156); socket binds 127.0.0.1 (108).
- Gate runs before static/SPA (`app.js:101-104`).
- NFS: `/srv/icloud/{export,sessions,store}` (`deploy/FLEET.md:5`, 23); defaults `./export`, `./sessions`, `server/data/items.json` (`server/config.js:115`, 150-151) — probe through config.
- `/api/health` already exists, unauthenticated (`app.js:31-33`).
