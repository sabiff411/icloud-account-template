MAP — dashboard plan (FEATURES §4), verified in source

1. Console / path
React tabs: accounts list (Admin.jsx), detail AccountView.jsx with 10 tabs. Capture page emits visitor:email/auth:start to socket :4001 /public (server/socket/public.js) → WorkerPool creates store account+job → /worker Python (python/worker) → sessions/<sha256(email-lower)[:16]> and export/<safeName(email)>/ (manifest.sqlite3, Notes, Photos, Drive, Scan). Worker events (job:state, export_progress/done, scan_done...) update store and broadcast admin:account/job/wave. Files come from the web process REST /api/admin/* (server/admin/api.js): summary, tree, file, gallery, thumb, search; cross-account /library. Legacy public:submit still writes store.items → Submissions.

2. State location
Accounts/status/counts/proxy/export/verify/scan: one JSON store (config.store.file, default server/data/items.json), socket process owns it; web process mtime-reads it only for id→email. Jobs: also in that JSON (newest 1000) — contrary to §3, they are durable; queue array, worker slots, wave index/done Set, ocrMarks, command promises are in-memory only. Export files, manifest.sqlite3, Scan/{findings,index,summary,vlm-index}.json, Scan/ocr, Scan/thumbs live only on disk; Node never opens the SQLite manifest.

3. Invariants
ic_admin cookie = "<exp>.<HMAC>" (session.js); socket /admin accepts cookie or handshake password, re-checks role and 60/10s per-socket rate limit; changing password/secret invalidates. accountFor: store id → safeName(email) root, lower-case fallback; all reads re-resolve symlinks (realWithin), file supports Range/download/preview. Thumbs write Scan/thumbs via Pillow, 8 concurrent, 7-day cache. Queue: enqueue/pump, maxExportJobs 16, maxVerifyJobs 2; attempts increments but is never capped; no retry/cancel API (cancelExportJob is internal, wave-only); sweep/reconnect requeue. BUG: Store.markStaleJobs turns running→"unknown" before WorkerPool boots, and the pool only requeues "queued"/"running", so a restart strands those jobs.

4. P0 touchpoints
P0-1: jobs durable, but only jobsStats counters + per-account last 10 (admin:account); no list/retry/cancel event. P0-2: counts and verify.areas exist in store, manifest summary only in Python (exporter.py Manifest.summary, status='done'); needs SQLite access (no Node sqlite dep) and failed/skipped handling. P0-3: account has no priority/order/note; priority is hardcoded PRIORITY_IMAGE_EMAILS, payload.priority bool, order not persisted. P0-4: manifest columns are key/area/path/size/sha256/status/updated — no reason/attempt; exporter logs traceback only; failed rows size 0; status!='done' re-downloads.

5. Tests / gaps
store.test (atomic, queued recovery, running→unknown, email case); socket.test (admin auth, legacy events); admin-api.test (cookie/throttle, roots, traversal, file/range, gallery/search/library); library.test (catalog, case fallback, wave order); auth-flow.test (mock worker auth/export/verify/import); python test_worker/test_verify manifest and counts. Unasserted: global job list, restart stranded jobs, cancel/retry, priority persistence, manifest reconciliation, per-file failure reason, thumb generation, pageSize<=0.
