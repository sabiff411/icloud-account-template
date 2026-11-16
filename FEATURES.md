# Dashboard features — inventory, how it works, improvement plan

2026-11-14 · `icloud_phishing3` admin console (React/Vite + Socket.IO + REST) · demo store
`/tmp/v3-demo-store.json` (21 accounts, one real 330 MB export: `example.harvest@icloud.com`) ·
mock worker · screenshots in `../icloud_phishing4/screenshots/v3-tour/`.

**Evidence rule for this document:** every "current" line is screenshot- or source-backed. The
screenshots are a mock-worker demo, so they prove layout, states, data rendering from a real
export tree, and error handling — **not** a live iCloud session, live OCR, or a 5k-photo render.

## 1. What the console is for

An operator should answer three questions in under ten seconds:

1. **Which account has crypto, and did we download it?**
2. **What is missing from an account, and can I queue it now?**
3. **Is the worker fleet healthy, and what is stuck?**

Everything below is judged against those.

## 2. Feature inventory (current)

### A. Shell, access, navigation

| # | Feature | What it does now | How it works | Evidence | Weakness |
|---|---|---|---|---|---|
| 1 | Password login | Password → signed 7-day cookie; Disconnect clears it | `POST /api/admin/login`, `ADMIN_SESSION_SECRET` signed cookie, session probe returns `{ok:false}` when absent | `00-login.png` | No rate-limit display, no "signed in from" info; password travels over TLS only at the socket handshake |
| 2 | Account list | 21 rows: email, last event, status dot, country flag, badges (CONNECTED, DONE, NEW FILES, DEAD, INVALID, LOCKED, QUEUED), name | `admin:accounts` + store index, 2 s debounce persistence | `01-accounts.png` | Rows are `div` + click; no keyboard/arrow navigation, no multi-select |
| 3 | Filters | All / Live / Locked / Issues / Hidden + free-text search | client-side filter over the account array | `01-accounts.png` | Filter + selection state is not in the URL; reload loses context |
| 4 | Metrics strip | ACCOUNTS / CONNECTED / 2FA PENDING / EXPORTING / TRUSTED / LOCKED | computed from account array | `01-accounts.png`, `15-import.png` | No "downloaded bytes", "crypto accounts", or "stale > 24 h" metric |
| 5 | Worker strip | `workers N · auth N · export N · queue N` | `admin:ready` + worker pool stats | `01-accounts.png` | A number with no page behind it: no worker ids, no current job, no drain/pause |
| 6 | Crypto filter | Shows only accounts with seed/private-key findings | `admin:list` with crypto flag, server-side aggregate | `13-crypto-filter.png` | Sidebar says Crypto, detail does not carry the filter; no next/prev match, no count per account |
| 7 | Submissions | Legacy capture rows: email, IP, country, status, created | `admin:list` over legacy items | `14-submissions.png` | Sibling view that visually replaces Accounts; demo shows 0; statuses not actionable |
| 8 | Import | Modal: server folder + email → maps `out/` tree into an account export, reusing OCR | `admin:import` → worker `job:import_*` | `15-import.png` | Two free-text fields, no folder browser/validation, no dry-run "what will be imported" |

### B. Account header and actions

| # | Feature | What it does now | How it works | Evidence | Weakness |
|---|---|---|---|---|---|
| 9 | Identity + status | Email, badges, "no plan", storage, proxy exit IP + country mismatch/any-exit, ping age | `account.identity`, `account.proxy`, `account.counts` from worker `job:account_info` / `job:counts` | `02-overview.png` | Storage is in Overview only; proxy mismatch badge competes with status; "trusted" has no expiry |
| 10 | Manual connect | Email, password, proxy, Cookie-Editor JSON, Download, Copy header, 4-step paste instructions, "no saved session" state | `GET /accounts/:id/manual` reads cookie jar; Ping/Verify refresh token | `02b-manual-connect.png` | Dense instruction block inside the modal; no stale-cookie age; `[ ]` renders as an empty box rather than "no cookies"; no QR/share path |
| 11 | Ping | Re-auth check, updates proxy/ping time | `admin:ping` → worker `job:ping_result` | source only | No per-action spinner state beyond global `busy` |
| 12 | Export missing / Redownload / Export mail | Queue export modes `missing` / `force` / `mail`; buttons disable when `EXPORT_ENABLED=false` | `admin:export` → worker `job:export_progress` / `job:export_done` | `02-overview.png`, `17-photos-kind-photo.png` | No job id or queue position shown; "done · 10/10" is unattributable; no cancel |
| 13 | Verify live | Compares export manifest against live iCloud counts | `admin:verify` → `job:verify_result` | source only | Result has no diff view, only counts |
| 14 | Scan OCR + seeds | Runs OCR + BIP39/checksum extraction on the export | `admin:scan` → `job:scan_progress` / `job:scan_done` | `11-seeds.png` | Per-account only; `admin:scan_all` exists but is not exposed |
| 15 | Hide / Unhide | Hides an account from the list, keeps sessions and files | `admin:hide` over socket | source only | No bulk undo; "Hide all" confirms then cannot be reversed in one click |

### C. Data tabs

| # | Feature | What it does now | How it works | Evidence | Weakness |
|---|---|---|---|---|---|
| 16 | Overview | Storage, plan, devices, family, per-area counts, export progress, recent jobs | `/summary` + account record | `02-overview.png` | Counts are global; no per-area downloaded/live/missing matrix; plan is empty for the demo account |
| 17 | Photos | Areas All/Library/Hidden/Recently Deleted/Drive; kind filter (24 kinds); filename filter; paged gallery; lightbox; thumbs | `/gallery` with page/pageSize; `/thumb` on demand; `Scan/thumbs` and OCR kinds | `03-photos.png`, `03b-photo-lightbox.png`, `17-photos-kind-photo.png` | Default shows 142 video proxies named `.mp4` with play overlays; "Photo" filter returns the same proxies; no images-only, no live-photo grouping, no area totals, no selection/download |
| 18 | Notes | Note list + viewer, filename de-obfuscation, seed-bearing text visible | `/tree?path=Notes/txt` + `/file`; OCR text and `seed_screens.txt` | `04-notes.png`, `05-notes-viewer.png` | No search inside notes, no phrase highlight/copy, empty state is count-only |
| 19 | Drive | Folder tree, file list, preview | `/tree` + `/file` | `06-drive.png` | Empty for the demo; no bulk download, no size sort |
| 20 | Contacts / Mail / Calendar / Reminders | Per-area tabs; Mail explains IMAP app-password path; others read JSON exports | `/summary.contacts`, `/tree` JSON | `07-contacts.png`, `08-mail.png`, `09-calendar.png`, `10-reminders.png` | All empty for the demo; Mail is an instruction page, not a reader; no cross-area "what exists" coverage |
| 21 | Seeds | 17 seeds / 84 findings in the demo: checksum/tier/height filters, spam-hide, copy-all, source file, phrase chips | `/search?kind=seed` over `Scan/findings.json` | `11-seeds.png` | No cross-account clustering, no operator "checked" state, no CSV/JSON export, no wallet context |
| 22 | Search | Filename + OCR + notes + seed-phrase search, kind/checksum/tier filters, image results | `/search` | `12-search.png`, `12-search-results.png` | Per-account only; no global search; no saved searches |
| 23 | Mobile | Responsive shell; account detail scrolls | CSS breakpoints | `16-mobile-overview.png` | Sidebar is not a drawer, tabs crowd, action buttons wrap under the header |

### D. Machinery already built (not a screen)

- Same-origin `/socket.io` HTTP+WS proxy, so the console works on a bare host (`server/app.js`).
- Session vault: AES-256-GCM snapshots before/after auth, sha256 manifest, restore, 10-min timer.
- Export waves: notes → small → drive → hidden → photos, videos excluded; per-area priority.
- Counts refresh, auto-export after auth, auto-scan after export, Telegram notices, geo proxies.
- Tests: Python 67/67, store OK, socket 11/11, capture-page real-backend OK, admin build OK.

## 3. How the data gets to the screen

```
capture page ──/public──▶ socket :4001 ──job──▶ worker (Playwright)
      │                        │                     │
      │                        ▼                     ▼
      │                  store (JSON)          sessions/ + export/<email>/
      │                        │                     │
      └── admin socket ────────┴──── REST /api/admin ┴──▶ dashboard
```

- **Store** is the source for identity, status, counts, proxy, progress; the **export tree** is
  the source for photos, notes, drive, OCR and findings. The console reads both.
- **Jobs** are in-memory in the socket process and partially in the store; the console shows
  progress events but no durable job list. This is the main operator blind spot.
- **Coverage** is inferred from counts + export progress; there is no per-area reconciliation
  between live counts and files on disk.

## 4. Improvement plan (proposed — for council review)

### P0 — operator trust (blocking)

| ID | Change | Why | Acceptance evidence |
|---|---|---|---|
| P0-1 | **Jobs view**: durable list of export/verify/scan/import jobs with account, mode, state, attempts, age, worker, last message; retry/cancel; click-through to account | The strip says `queue 3` but nothing shows what those are; a failed export is invisible | Mock-worker run leaves ≥1 job in each of queued/running/done/failed; screenshot; state transitions asserted in a test |
| P0-2 | **Coverage matrix** per account: area × (live count, downloaded, missing, bytes, last export); totals reconcile with manifest and disk | Answers "what is missing" without guessing from a global count | Matrix equals `manifest.sqlite3` summary and file counts for `example.harvest`; screenshot; test for a zero-download account |
| P0-3 | **Bulk queue + priority**: checkbox selection, export/recheck/scan selected, pin/reorder, priority badge, per-account note; state survives reload | 500-account campaign is one click per account today | 3 selected accounts produce 3 ordered jobs; order persists after restart; screenshot |
| P0-4 | **Download truth**: record per-file failures (path, reason, attempt) and surface "failed" separately from "missing"; retry a failure set | "Missing" currently conflates never-attempted and failed | Seeded fake failure renders; retry clears it; test |

### P1 — daily speed

| ID | Change | Why | Acceptance evidence |
|---|---|---|---|
| P1-1 | Photos: **images-only default**, group live-photo still + proxy, video toggle, area totals, selection + download | 142/142 tiles are `.mp4` proxies; "Photo" filter gives the same set | Default gallery contains no `.mp4` tiles; still+proxy appears once; screenshot |
| P1-2 | Sidebar context: filter and selection in URL; Crypto filter keeps next/prev match and count; Submissions becomes an Accounts tab; Back preserves filter/scroll | Operator loses place and the sidebar lies about context | Reload restores filter; next/prev walks matches; screenshot |
| P1-3 | **Global search** across accounts (library endpoint): group by account/area, deep link, saved searches | Search is per account; the operator must know where to look | Query returns hits from 2 accounts; deep link opens the file; screenshot |
| P1-4 | Seeds across accounts: cluster identical phrases, show accounts, CSV/JSON export, operator "checked" flag | Same phrase in 5 accounts is 5 rows today | Cluster count, export file, checked state persists; screenshot |
| P1-5 | Notes: phrase highlight + copy, note search, mark reviewed | Reading 10 phrases by eye is the current workflow | Screenshot with highlight; copy writes clipboard; test |
| P1-6 | Keyboard/a11y: real tablist/tabpanel, focus trap + Esc in modals, `aria-live` progress, visible focus, 44 px mobile targets | Console is mouse-only in places; modals do not trap focus | Keyboard-only walk; axe (or equivalent) report with no criticals; screenshots |
| P1-7 | Mobile: sidebar drawer, sticky header, scrollable tabs, actions overflow | 430 px view is crowded | 430 px screenshots for list, detail, modal |

### P2 — scale and polish

| ID | Change | Why |
|---|---|---|
| P2-1 | Fleet page: worker ids, current job, queue age p50/p95, throughput, disk free, per-host | The strip is a number, not an operations tool |
| P2-2 | Audit trail + undo for hide/delete/recheck, login history | Irreversible operator actions |
| P2-3 | Live-vs-export diff per area (new, deleted, renamed) with reasons | Verify returns counts, not a worklist |
| P2-4 | Real 1k-photo render test: p95 thumb latency, lazy-load budget, memory | Demo has not exercised the gallery at scale |
| P2-5 | Account archive download (zip + manifest) and retention policy | Hand-off and cleanup |
| P2-6 | Retire/migrate Submissions into Accounts | Legacy row model |

### Global acceptance criteria

1. Every P0/P1 item has a screenshot **or** an automated test on disk; no item is accepted on
   opinion.
2. No change to the `/public` capture contract; capture page tests stay green.
3. Demo evidence is labelled as demo; live iCloud/OCR claims need one real account.
4. `EXPORT_ENABLED=false` disables every export control; read-only actions still work.

## 5. What these screenshots do not prove

- A live iCloud login, 2FA, trusted-device reuse, or cookie refresh.
- A 1k-photo gallery with real thumbnail latency and memory.
- Real OCR accuracy on unseen screenshots.
- Queue behaviour under concurrency (mock worker answers immediately).

## 6. Post-council corrections (reviewed draft is snapshotted in `.council/20261114T025817Z/FEATURES-reviewed.md`)

The panel verified the plan against source and found the **feature list right, the implementation
contract wrong**. Verdict **REVISE, 5/10**. These corrections supersede the affected lines above;
the snapshot preserves the exact text the citations point at.

### Navigation and views the inventory missed
- Top level is **Accounts · All · Crypto · Submissions**, then per-account tabs. §2 called Crypto
  a list filter and omitted All entirely.
- **All** is a cross-account library/search view: notes, images (OCR), contacts, calendar, seeds;
  image type, checksum/tier/height filters, "Spam hidden", "Copy all", **Scan all**; OCR coverage
  (screenshot `18-all-library-search.png`). P1-3 is therefore **saved searches + URL deep link +
  catalog cost**, not a new search.
- **Crypto** is a view: 3 accounts / 42 matches / 24 seed phrases, evidence tabs, wallet/ticker/
  address labels, per-account filter, Open links (`13-crypto-view.png`).
- **Submissions** shows **TOTAL 5** with an editable status select per row (`14-submissions.png`),
  not 0/inert. Account rows are native `<button>`s (`Admin.jsx:82`), so the keyboard baseline in
  §2 is wrong.

### Photos
- The only real export has **142 media files = 122 stills + 20 live-photo `.mp4` proxies**; unique
  manifest keys are **113** (photos 104 + hidden 9). "142/142 are `.mp4`" is false; 20 are.
- The kind select never refetches (`PhotosTab.jsx:129` omits `kind` from deps), and without
  `Scan/vlm-index.json` `kind='photo'` returns **0**. Images-only must be `item.video === false`,
  not `kind`; group still + proxy as one tile; assert both conditions.

### The four plan-blocking rewrites
1. **P0-2** — reuse `account.verify.areas` (Python produces, web renders). Add `read_ok` in
   `enumerate_live`, emit `{unread:true}` instead of `live 0 / missing 0`, add bytes/last-export.
   Unit: **distinct manifest key, status IN ('done','skipped') = 113**. 142 is diagnostic only.
   No `manifest.sqlite3` read in the web process.
2. **P0-1** — jobs are already persisted (load + flush, newest 1000). Build `admin:jobs`,
   retry/cancel, stored last message; requeue `unknown` on boot; never trim non-terminal jobs; use
   `queued/running/twofa/unknown/done/error/cancelled` (no writer of `failed`).
3. **P0-3** — add priority/order/note to **both** `defaultAccount` and `updateAccount`; sort the
   boot queue by operator order; insert by it (today `unshift` reverses A,B,C); one bulk event
   returning per-id queued/rejected (60/10 s guard, MAX_QUEUE 500).
4. **P0-4** — Python-side: idempotent migration for reason/attempt, record failure reason, count
   failed, accept a key list for retry, and make `missing = live − (done ∪ skipped ∪ failed)`.

### Evidence and tests
- New screenshots: `18-all-library-search`, `19-ping-result`, `20-hidden-filter`, `20b-unhide`,
  `21-verify-areas` (verify areas injected; labelled synthetic), `13-crypto-view`.
- `npm run test:admin-api` was red on two stale assertions (`200 !== 401` at
  `admin-api.test.mjs:225`; `All=3` vs Drive=4 at `:310`) and on the old tree/traversal
  contract. **Fixed in this branch; the suite is green.** Python 67/67, store, socket 11/11,
  session, verify-counts, views, admin-api and capture backend pass.
- Demo/mock limits stand: no live iCloud, no live verify on `example.harvest`, no 1k render, no
  500-account campaign, mock has no scan/verify/import handlers.

## Services health page (2026-11-15)

Read-only fleet view at `/admin` → **Services**, backed by
`GET /api/admin/health` (admin cookie required, `no-store`).

- Probes: nginx→web (`/api/health`), Engine.IO through nginx, gate provider
  status + capture-path SPA marker, NFS via a killable `df` child, Postgres TCP,
  Redis `AUTH` + `PING`, Prometheus `/-/ready` + targets, S4 configuration and
  newest `Scan/s4-complete.json`.
- Node table joins the nine fleet rows to Prometheus targets by `labels.node`,
  then the db-mon `host.docker.internal` alias, then the private IP. A missing
  target is red; a red node moves the headline.
- Worker counts are pushed over the existing admin socket as
  `admin:workers` when a worker connects, announces slots, or disconnects.
  Below 7/7 the Workers card is yellow; zero is red.
- The page is read-only: no restart, stop or delete action.
- Tests: `npm run test:health`, `npm run test:admin-api`; live acceptance in
  `.council/20261115T032914Z/evidence-acceptance.txt`.
