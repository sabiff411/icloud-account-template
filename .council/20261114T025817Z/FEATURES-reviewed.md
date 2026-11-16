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
