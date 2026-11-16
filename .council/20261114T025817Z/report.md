# Council report — dashboard feature inventory and improvement plan

**Verdict:** REVISE · **Score:** 5/10 readiness to implement · **Confidence:** High — every P1 citation was re-read and three probes reproduced, but there is no live iCloud run, no live verify on `example.harvest`, no 1k render, and no real 500-account campaign. Production `S4_*` config and campaign size are unknown and move the score materially.
**Panel:** client, devil's advocate, architecture, correctness, performance · **Debate:** 1 round (only contested points; all converged) · **Scope:** `FEATURES.md` §4 plus the dashboard source it touches · **Run:** `.council/20261114T025817Z/`
**Bias note:** every seat is the same base model. The direction (REVISE) is unanimous, so treat that as shared-model risk, not independent proof. No formal `[CORRELATED-BIAS-RISK]` flag: scores spread 4–6 and two seats flipped on new evidence in debate.

## Executive summary

This is a plan review of the operator console for the iCloud capture system, based on 28 screenshots, the real 330 MB export, and the dashboard source. The feature list is sound; the implementation contract is not. Four P0 items are each scoped on a false statement about existing behaviour — jobs already persist, `verify` already reconciles per area, the account record has no priority field, and the manifest has no dashboard reader and no named owner. All four P0 acceptance criteria fail as written, and the plan's centrepiece (coverage) would create a second answer to "what is missing" that differs from the existing one by 29 files. Rewrite §3–§4 and the acceptance tests first; the product does not need rethinking. The cost is one focused rewrite plus five small state-machine fixes, not a rebuild.

## Consensus (≥3 seats raised it independently, and it verified)

- **P1 `[VERIFIED]` `[CONSENSUS]` `server/store.js:205-207` — restart strands every in-flight job.** Symptom: an operator deploys during an export; the job becomes `unknown`, the account stays `exporting`, and the pool's running-requeue branch is dead because `markStaleJobs()` (`store.js:130`) runs before the pool is built (`socket/index.js:14` vs `:35`). Four IDs, one defect. Fix: requeue `unknown` on boot; keep the account status. No bytes are lost; the work is silently restarted.
- **P1 `[VERIFIED]` `[CONSENSUS]` `server/store.js:169-173` — the 1000-job trim evicts active jobs.** Symptom: at campaign scale an older running job is sliced out, its completion is dropped at `worker-pool.js:1097-1098`, and the account never reaches done. The verifier struck the "worker slot leak" clause (`worker:ready` restores slots); the stuck record is the real impact. Fix: cap terminal jobs only.
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:94` + `python/worker/verify.py:264-276` — P0-2 is not new reconciliation.** Symptom: the console would show two "missing" numbers; the existing Verify panel says live 104 / exported 104, while a disk counter says 142 files and reports 20 photos that are not missing. Fix: extend `account.verify.areas` with `read_ok`/unread, bytes and last-export; render it; no web SQLite.
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:94` — one unit for "downloaded".** `example.harvest` has 113 distinct manifest keys (`done` 104 photos + 9 hidden), 113 unique disk basenames, 142 files after 20 live-photo proxies and 9 duplicated Hidden stills. Fix: downloaded = distinct manifest key with status `done|skipped`; 142 is a diagnostic.
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:82-83` — jobs are already durable.** `store.js:145` loads them and `:169-173` flushes all fields; only a list/retry surface is missing. The acceptance's `failed` state has no writer: the vocabulary is `queued/running/twofa/unknown/done/error/cancelled`.
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:95` — P0-3's priority is decorative.** `updateAccount` copies a fixed whitelist (`store.js:398-416`) and `defaultAccount` declares no priority/order/note (`:50-117`); `unshift` makes A,B,C dispatch C,B,A (`worker-pool.js:731`) and the boot sort ignores operator order (`:171-179`).
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:96` — P0-4 is Python-side.** The manifest has no reason/attempt column (`exporter.py:212`), failure writes `status='failed'` with size 0 (`:961`), `verify` counts failed rows as missing (`verify.py:30,269`), and the export mode enum has no key-list retry (`admin.js:36-38`).
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:102` — P1-1's premise is wrong.** 20 of 142 tiles are `.mp4`, 122 are stills; `kind='photo'` returns 0 without `vlm-index.json`; the select never refetches (`PhotosTab.jsx:129`). Images-only = `item.video === false`.
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:104` — global search already exists.** The All view (`LibraryTab.jsx:424,432`, `library.js:762`) searches notes, OCR, contacts, calendar and seeds across accounts; screenshot 18. P1-3 is saved searches, deep links and catalog cost.
- **P1 `[VERIFIED]` `[CONSENSUS]` `FEATURES.md:28,33,45` — inventory stale in three places.** Rows are `<button>` (`Admin.jsx:82`), Submissions is TOTAL 5 with editable selects (`:184-194`; screenshot 14), and "Scan all" is exposed (`LibraryTab.jsx:452`). The manual-connect clause was conceded in debate.
- **P1 `[VERIFIED]` `[CONSENSUS]` `server/admin/library.js:717` — the All view's cost is the rebuild.** `buildCatalog` runs inline behind a 120 s TTL while the tab polls every 30 s: ~57 ms per 1k-photo account, ~7.1 s per 500-account rebuild. P1-3 must include serving the last good catalog and rebuilding off the request path.

## Disputes — ruled

| # | Ruling | Deciding evidence (phase) |
|---|---|---|
| D1 | ARCH-1 stays P2; Python owns the matrix | verifier node:sqlite create probe + README one-writer + `worker-pool.js:1255` |
| D2 | Reuse `verify.areas` **with** `read_ok` | correctness/devil debate r1: `verify.py:212-219,269`; `OverviewTab.jsx:34-44` |
| D3 | Downloaded = distinct manifest key = 113 | manifest 104+9 vs disk 142/113 |
| D4 | P0-1 = list + retry/cancel + last message + vocabulary | `store.js:145,169-173`; CL-6 |
| D5 | Restart cluster = one defect, four IDs | three probes + construction order |
| D6 | Eviction stands; slot-leak clause struck | verifier: `worker:ready` restores slots |
| D7 | Use real states or map `failed` = error/unknown/cancelled | no `failed` writer |
| D8 | P0-3 persistence is one P1 | both whitelists + boot sort + `unshift` |
| D9 | PERF-6 stays P1 on the rate guard alone | verifier corrected the MAX_QUEUE off-by-one |
| D10 | P0-4 Python-side; failed ∉ missing | `exporter.py:212,961,260`; `verify.py:30,269` |
| D11 | `item.video`, not kind; fix both deps | verifier gallery probe + client S5 |
| D12 | P1-3 = saved searches + catalog cost | `library.js:762`, screenshot 18, PERF-1 |

## Findings by severity

### P0 — before this ships
**No council-P0 defect is upheld.** The worst current symptoms are the restart stranding, the eviction, and a cosmetic counter; the verifier explicitly kept all P1s at P1. "Plan-blocking before implementation" is an action-priority axis, not defect severity, and is tracked below.

### P1 — soon, scheduled (21 panel + 2 completeness confirmed)
- `[VERIFIED]` `[EXISTING_DEFECT]` restart cluster `store.js:205-207`; eviction `store.js:169-173`.
- `[VERIFIED]` `[EXISTING_DEFECT]` two count paths disagree by 29 (`worker-pool.js:1108`; `export-counts.js:117`).
- `[VERIFIED]` `[EXISTING_DEFECT]` `account.counts` is the export tree, not live iCloud (`worker-pool.js:1114`); a matrix sourced from it reads missing 0.
- `[VERIFIED]` `[PLAN_RISK]` P0-2 duplicate/unit; P0-3 persistence; P0-4 Python schema; P1-1 premise; P1-3 duplicate.
- `[VERIFIED]` `[PLAN_RISK]` CL-10 inventory errors (three, after amendment).
- `[VERIFIED]` `[PLAN_RISK]` P0-1 acceptance names a nonexistent `failed` state; P0-2 renders a failed live read as "complete".
- `[VERIFIED]` `[PLAN_RISK]` bulk 500 collides with 60/10 s and MAX_QUEUE (`admin.js:69,74`; `worker-pool.js:559`).
- `[VERIFIED]` `[EXISTING_DEFECT]` `/library` rebuild and 30 s poll (`library.js:717`; `LibraryTab.jsx:264`).
- `[VERIFIED]` `[EXISTING_DEFECT]` thumbnails fork Python per tile (`thumbs.js:66`) — one-time cold-grid cost, downgraded from P1 because scan thumbs already exist.
- `[VERIFIED]` `[PLAN_RISK]` `P0-3` selection has no single owner; `P0-4` retry cannot target a failure set.
- `[VERIFIED]` `[PLAN_RISK]` `[COMPLETENESS]` CB-1: the mock's `job:export_done` sends no `totals.areas` and `/tmp/mock-manifest.sqlite3`, so the matrix's evidence path is unreachable.
- `[VERIFIED]` `[EXISTING_DEFECT]` `[COMPLETENESS]` CB-2: the mock has no scan slot and no scan/verify/import handlers, so P0-1/P0-3 states cannot be exercised.

### P2 — structural, plan it (27 panel incl. 3 downgrades + 4 completeness)
- `[VERIFIED]` Update allowlist/defaultAccount drops new fields; LIFO insert; boot sort ignores order.
- `[VERIFIED]` Cancelled-job guard is dead (`worker-pool.js:1193`); `failed`/`error`/`unknown` semantics.
- `[VERIFIED]` Photos kind filter never refetches; Library kind filter drops payload (`LibraryTab.jsx:309`).
- `[VERIFIED]` S4 HEAD storm (dormant without `S4_*`), per-item gallery HEADs, pageSize=0 + 426 B/item, whole-store sync flush, per-account push payload.
- `[VERIFIED]` `[COMPLETENESS]` CB-3: `admin-api.test.mjs` is red — `:225` expects 401 while `api.js:209` returns 200 `{ok:false}`; `:310` expects All=3 while Drive is included.
- `[VERIFIED]` `[COMPLETENESS]` CB-6: CONNECTED excludes `done`; LOCKED counts the whole error bucket.
- `[VERIFIED]` `[COMPLETENESS]` CB-7: "Hide all N" counts the filtered list but the server hides every visible account.

### P3 — nits
- Three P3 findings: duplicate thumb/preview/play stats; seed clustering should be per account first; listing caches never evict.

## Dropped and refuted

- **0 REFUTED.** Every P1 survived; three were downgraded: ARCH-1 (ownership gap, not user-visible), PERF-2 (dormant without production `S4_*`), PERF-5 (thumbs already exist after scan).
- **CL-10 manual-connect clause conceded** in debate: `JSON.stringify([])` is `"[]"`, truthy, so the fallback never fires; screenshot 02b shows `[]`. The other three inventory errors stand.
- **CB-5 dropped** as covered by CL-7/COR-6/ARCH-5/DA-6 — both whitelists are already named in COR-6's fix.
- **No quote mismatches, no missing files, no line-out-of-range.** 57/57 citations verified.

## Completeness audit

The panel assumed the mock could exercise every job state and that the manifest was a readable oracle. The blind auditor found seven consequences the panel missed; six survived dedupe: the unreachable matrix fixture (CB-1), the mock's missing handlers (CB-2), the **red admin-api test** (CB-3), the global Library kind-filter bug (CB-4), the wrong CONNECTED/LOCKED counters (CB-6), and the Hide-all confirmation mismatch (CB-7). CB-1 folds into P0-2; CB-4 into P1-1; CB-3 must be fixed before "test on disk" can be used as acceptance evidence; CB-2 must be fixed before job-state screenshots are credible.

## What would change this verdict

A corrected §4 that names one producer and one unit per P0, uses the real job vocabulary and `item.video`, and adds restart, >1000-job, failed-live-read and 500-account acceptance cases would move this to **SHIP at 8–9**; evidence that production sets `S4_*` and runs 500 accounts would instead drop it to **3** by re-promoting the catalog/HEAD storm.

## Verification ledger

| Check | Result |
|---|---|
| `check_citations.py` (panel) | VERIFIED 51, FUZZY 0, MISMATCH 0, blocking 0 |
| `check_citations.py` (completeness) | VERIFIED 6, blocking 0 |
| `verification_command` runs | 24 P1: 21 CONFIRMED, 0 REFUTED, 3 DOWNGRADE |
| blind finals | median 5, spread 2 (architecture 4, client 5, correctness 5, devil 5, performance 6) |
| phases on disk | scope, map, five reviews, five reflections, two challenge records, debate r1, completeness blind + audit, citations, verify, five finals, judge ruling |
| code tests | Python 67/67, store OK, socket 11/11, session OK, verify-counts OK, views OK, capture backend OK; **admin-api RED** (`200 !== 401`) |

## Transcripts

`review-<seat>.json` · `challenge-client.json` · `challenge-devil-advocate.json` · `debate-*-r1.md` · `reflect-*.json` · `completeness-blind.json` · `completeness-audit.json` · `verify.json` · `final-*.json` · `judge-ruling.json` / `.md` · `evidence-citations*.txt`.

## First-plan challenge and client acceptance

Initial status **UNPROVEN**. Gate **PASS**: client 6 scenarios (1 supported, 5 refuted), devil 7 (6 supported, 1 refuted), both written before peers and before approval. Client acceptance: gate scenarios **1 pass, 5 fail, 0 untested** (S5 Photo filter stale passes; S1 matrix exists, S2 global search exists, S3 no `failed` state, S4 restart strands, S6 urls export still active fail). Plan criteria: **3 pass** (demo labelled), **1 fail** (test/screenshot on disk — red suite), **2 untested** (/public contract), **4 fail** (export gate; all four P0 acceptance criteria fail as written). Unresolved critical assumptions: no live verify on `example.harvest` (screenshot 21 is post-hoc and already shows the mixed unit), no real restart/>1000-job run, no 1k render, production S4/campaign size unknown, Node/busy-timeout unproven if the web ever reads SQLite.
