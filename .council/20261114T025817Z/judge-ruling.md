# Judge ruling — dashboard improvement plan (FEATURES.md §4)

**Verdict: REVISE · Score: 5/10 readiness to implement · Confidence: high**
Initial state UNPROVEN. Challenge gate **PASS**: client 6 scenarios (1 supported, 5 refuted), devil 7 (6 supported, 1 refuted), both ≥3 and pre-debate. Panel: 51 findings, 51 citation-VERIFIED; 24 P1 → 21 CONFIRMED, 3 DOWNGRADE (ARCH-1, PERF-2, PERF-5), 0 REFUTED. Completeness: 6 kept, 1 dropped, all VERIFIED. Five blind finals: 4, 5, 5, 5, 6 — all REVISE; median 5.

## 1. Ruling

The feature list is right; the implementation contract is not. Every P0 item is scoped on a false statement about existing behaviour: jobs already persist, verify already reconciles per area, the account record has no priority field, and the manifest has no dashboard reader and the plan names no owner. All four P0 acceptance criteria fail as written, and two of them (P0-1's "failed" state, P0-2's two units) cannot be written at all without a decision. This is a focused rewrite of §3–§4 and the acceptance tests, not a re-think of the products.

## 2. Severity: no P0, and why

No reviewer called a defect P0; `verify.json.p1_that_should_become_p0` is empty. The contract's P0 needs an existing defect plus a symptom sentence naming who sees what. The worst current symptoms are:

- **Restart** (ARCH-4/COR-4/CL-4/DA-1): an operator deploys mid-export; the job becomes `unknown`, the account stays `exporting`, and the pool's requeue branch is dead because `markStaleJobs()` (`server/store.js:130`) runs before the pool is built (`server/socket/index.js:14` vs `:35`). A manual re-export works; no bytes are lost.
- **Eviction** (ARCH-3/COR-5/DA-2): past 1000 newer jobs, an older running job is trimmed (`store.js:169-173`), its completion returns at `worker-pool.js:1097-1098`, and the account never reaches done. Only at campaign scale; the file is on disk.
- **Header** (CB-6): CONNECTED 0 after successful exports; cosmetic and one line to fix.

"Plan-blocking before implementation" is tracked as **action priority P0** on the four P0-item rewrites: the item cannot be accepted until its premise and test are rewritten. That is a different axis from defect severity. **No council-P0 defect is invented in this ruling.**

## 3. The four P0 contracts (answers to Q3–Q6)

**P0-2 — one producer, one unit, one unread marker.** Reuse `account.verify.areas` (COR-1/ARCH-1), but not as-is (DA-3): a failed album read currently yields `live 0 / missing 0` and OverviewTab prints `complete` (`verify.py:212-219,269-276`; `OverviewTab.jsx:34-44`). Add `read_ok` in `enumerate_live`, emit `{unread:true}` and no missing count, render a tri-state with last-verified, and inject one failed album read in the acceptance. Do **not** open `manifest.sqlite3` in the web process: ARCH-1's stale/empty-reader risk is conditional (verifier: `new DatabaseSync(<missing path>)` creates an empty DB; node:sqlite exists at `server/gate.js:24`), but the ownership rule stands — Python produces, the web renders.
**Unit for "downloaded": the distinct manifest key (asset id) with status IN ('done','skipped').** For `example.harvest` that is 113 (photos 104 + hidden 9), equal to 113 unique disk basenames; 142 is the file count after 20 live-photo proxies and 9 duplicated Hidden stills. 142 and 124+18 are diagnostics, not the denominator. The live column uses the same key scheme from verify; the acceptance must show 113 on both oracles side by side, plus a zero-download account and one unread album. Fix the mock to send `totals.areas` and a real manifest path (CB-1).

**P0-1 — the gap is a read, not a store.** Jobs load (`store.js:145`) and flush all fields (`:169-173`); `admin:account` returns only the last 10. Build: a paginated `admin:jobs`, pool-level retry/cancel, a stored last-message (DA-7), the real vocabulary `queued/running/twofa/unknown/done/error/cancelled` (no writer of `failed` — `worker-pool.js:1158` writes `error`, `store.js:206` writes `unknown`), the dead cancelled guard fixed (`worker-pool.js:1193`), boot requeue of `unknown`, and a trim that never evicts non-terminal jobs. Acceptance adds restart and >1000-job cases.

**P0-3 — persist before you pin.** `updateAccount` copies a fixed whitelist (`store.js:398-416`) and `defaultAccount` declares no priority/order/note (`store.js:50-117`), so the badge is decorative. Add both, sort the boot queue by operator order first (`worker-pool.js:171-179`), insert by explicit order (today `unshift` makes A,B,C dispatch C,B,A — COR-7), and give selection one owner: the URL. Bulk: one `admin:exportMany` with its own limit returning per-id queued/rejected. The 60/10s guard (`admin.js:69,74`) rejects a 500-call loop; `MAX_QUEUE=500` (`worker-pool.js:559`) rejects once the queue is partly full. The verifier corrected the "rejects the last request" clause: exactly 500 fits with an empty queue. Accept 500 with a partly full queue.

**P0-4 — Python-side, and verify must stop counting failed as missing.** The manifest has seven columns (`exporter.py:212`); a failure writes `status='failed'`, size 0, empty sha (`:961`). Add an idempotent ALTER for reason + attempt, count failed in the summary (`:260`), accept an explicit key list for retry (the mode enum at `admin.js:36-38` has none), and change `missing` to `live − (done ∪ skipped ∪ failed)` (`verify.py:30,269`) with failed surfaced separately. Acceptance asserts a seeded failure does **not** increment missing (DA-5), not merely that a row renders.

## 4. P1 corrections (Q7–Q8)

**P1-1:** the premise is wrong on the cited tree — 20 of 142 tiles are `.mp4`, 122 are stills; `kindCounts` is `{"unclassified":142}` and `kind='photo'` returns 0 because `Scan/vlm-index.json` is absent. "Photo filter gives the same set" is a stale screenshot: `PhotosTab.jsx:129` omits `kind` from the deps. Implement images-only as `item.video === false`, not `kind`; fix the deps in PhotosTab and `LibraryTab.jsx:309` (CB-4); group still+proxy as one tile; assert both no-`.mp4` and still+proxy-once.

**P1-3:** the All view already searches every account (`LibraryTab.jsx:424,432`; `library.js:762`; screenshot 18). Re-scope to saved searches + URL-restorable query/deep link and add the catalog cost: `buildCatalog` is inline (`api.js:407`) behind a 120 s TTL (`library.js:717`) while the tab polls every 30 s (`LibraryTab.jsx:264`), ~7.1 s per 500-account rebuild. Serve the last good catalog and rebuild off the request path; size the test at 500. PERF-2 (S4 HEAD storm) stays P2 until production config is known.

## 5. Disputes (full text in judge-ruling.json)

| # | Ruling | Deciding evidence (round) |
|---|---|---|
| D1 | ARCH-1 stays P2; design stays Python-owned | verifier node:sqlite create + README one-writer + `worker-pool.js:1255` (phase 6, devil C7) |
| D2 | Reuse verify.areas **with** `read_ok` | correctness/devil debate r1: `verify.py:212-219,269`, `OverviewTab.jsx:34-44` |
| D3 | Downloaded = distinct manifest key = 113 | manifest 104+9, disk 142/113, client map_validation:58 |
| D4 | P0-1 = list + retry/cancel + last message + vocabulary | `store.js:145,169-173`; CL-6 phase 6 |
| D5 | Restart cluster = one defect, four IDs | three probes + store/pool construction order |
| D6 | Eviction defect stands; slot-leak clause struck | verifier: `worker:ready` restores slots (`__main__.py:164-165`, `worker-pool.js:1460`) |
| D7 | Use real states or map `failed` = error/unknown/cancelled | no `failed` writer; manifest noun collision |
| D8 | P0-3 persistence = one P1 | both whitelists + boot sort + `unshift` at `:731` |
| D9 | PERF-6 P1 on the 60/10s guard alone | verifier counter-case corrected MAX_QUEUE off-by-one |
| D10 | P0-4 Python-side; failed ∉ missing | `exporter.py:212,961,260`; `verify.py:30,269` |
| D11 | `item.video`, not kind; fix both deps | verifier gallery probe + client S5 |
| D12 | P1-3 is saved searches + catalog cost | `library.js:762`, screenshot 18, PERF-1 |

## 6. CL-10 amendment (Q9)

The client's own debate conceded the manual-connect sub-claim: `JSON.stringify([], null, 1)` is `"[]"`, truthy, so `ManualConnectModal.jsx:192`'s fallback never fires; screenshot 02b shows `[]`. **Three claims survive**, all re-verified: rows are a native `<button>` (`Admin.jsx:82`), submissions show TOTAL 5 with an editable status select (`:184-194`; screenshot 14), and "Scan all" is a working button (`LibraryTab.jsx:377-382,452`). Apply the amendment verbatim; "at least four places" → "at least three". Keep P1 because the plan's P1-2/P1-6 scope rests on those sentences, but note P2 is defensible for the two inventory errors alone.

## 7. Completeness (Q10)

All six kept findings change an action; none changes a P0 verdict. **CB-2 (P1)** is the one to do before any job-state screenshot: the mock advertises no scan slot and has no `job:scan/verify/import` handler, so the demo's 3 scans sit `queued` and 0 jobs are `running`. **CB-1 (P1)** folds into P0-2's fixture. **CB-3 (P2) is a red test**: `admin-api.test.mjs:225` expects 401 while `api.js:209` returns 200 `{ok:false}`; `:310` expects All=3 while Drive makes 4. Fix both before Global criterion 1 ("test on disk") is usable. **CB-4 (P2)** folds into P1-1. **CB-6 (P2)** and **CB-7 (P2)** are real but local: wrong CONNECTED/LOCKED counters, and a "Hide all N" confirmation that can clear the visible list after a one-row search. CB-5 was correctly dropped — CL-7 already names both whitelists.

## 8. Client acceptance (Q11)

Gate scenarios: **pass 1** (S5, Photo filter stale), **fail 5** (S1 matrix exists, S2 global search exists, S3 no `failed` state, S4 restart strands, S6 urls export still active), **untested 0**. Plan criteria: criterion 3 (demo labelled) **pass**; criterion 1 (test or screenshot on disk) **fail** (not currently trustworthy) (red suite, missing screenshots); criterion 2 (/public unchanged) **untested** (out of scope); criterion 4 (export gate) **fail**. All four P0 acceptance criteria **fail as written**.

Unresolved critical assumptions: no live verify run on `example.harvest` (screenshot 21 is post-hoc and already shows the mixed unit); production S4/campaign size unknown; no real socket restart or >1000-job run (probes only); no 1k render or proof that scanned accounts get kinds; Node version/busy-timeout if the web ever reads SQLite; /public tests not run.

## 9. What would change this verdict

A corrected §4 that names one producer and one unit per P0, uses the real job vocabulary and `item.video`, and adds restart, >1000-job, failed-live-read and 500-account acceptance cases would move this to **SHIP at 8–9**. Evidence that production sets `S4_*` and runs 500 accounts would instead drop it to **3** by re-promoting PERF-2 and making the catalog rebuild minutes.

## 10. Not examined

Source files were not re-read; every citation comes from the council evidence. Screenshots were not opened. `review-*.json`, `reflect-*.json`, `completeness-blind.json`, `map.md`, `evidence-tests.txt`, `evidence-demo.txt` and `evidence-screens.md` were not read. The plan's P1-2, P1-4..7 and P2 items were not independently verified. No live iCloud, OCR, 1k render, socket process, 500-account campaign or production deployment was observed. The two challenge records were read only to confirm the ≥3-scenario gate.
