# Council report — Fleet Services health page

**Verdict:** SHIP · **Score:** 8/10 · **Confidence:** Medium — the page and probes are verified live, but the fleet’s two operational gaps (gate `:4100`, S4 keys) are outside this change, and no one has frozen the NFS server with the panel open.
**Panel:** client, devil’s advocate, correctness, completeness auditor, verifier, judge · **Debate:** 1 round · **Scope:** `plan.md` / `plan-v2.md`, `server/admin/{health,fleet,storage,api}.js`, `server/socket/worker-pool.js`, `src/admin/{ServicesTab,useAdminSocket,Admin,api}.js[x]`, `server/test/{health,admin-api}.test.mjs` · **Run:** `.council/20261115T032914Z/`
`[CORRELATED-BIAS-RISK]` all seats are the same base model; no seat flipped a factual position without new evidence, and two P1s were found independently by all three reviewers.

## Executive summary

This is a read-only Services page for the nine-node fleet, backed by a new authenticated `GET /api/admin/health` and a live worker-count push over the existing admin socket. The thing that matters most is that it tells the truth today: **9/9 nodes green, 7/7 workers, NFS 6 %, Postgres and Redis green, Prometheus 9/9, gate RED because `:4100` is missing, S4 YELLOW because the keys are empty.** It survives review after two P1s were fixed — the db-mon target join and the NFS `statfs`/sync-walk exposure — and it is deployed on session-1. The remaining cost is operational, not code: build the gate provider, supply S4 credentials, and attach the domain/TLS. The page itself costs one small read-only route and a socket event.

## Consensus (≥3 seats raised it independently, and it verified)

- **P1 `[VERIFIED]` `[CONSENSUS]` C1 — db-mon-1 was red on a healthy fleet.** Prometheus scrapes it as `host.docker.internal:9100`, not `10.20.0.30`, so a private-IP join could never match. Fixed twice: `health.js` falls back label → alias → private IP, and the scrape config now carries `labels.node` for all nine. Live: 9/9 rows green. Cost: one alias and one config reload.
- **P1 `[VERIFIED]` `[CONSENSUS]` C2 — a timed-out `statfs` kept one of four libuv threads.** With `/srv/icloud` mounted `hard,timeo=600`, a hung mount could pin the pool and stall the web tier. The health probe now runs `df` in a killable child (13 ms while four FIFOs starved the pool), and after the judge the panel’s own `/storage` walk is bounded-concurrency `fsp`, not `statSync`. Cost: one helper and one async walk.
- **P2 `[VERIFIED]` `[CONSENSUS]` C3 — S4 had no heartbeat producer.** The card is now “configured + newest `s4-complete.json`”, labelled as such; it is yellow until keys exist. Open by configuration, not by code.
- **P2 `[VERIFIED]` `[CONSENSUS]` C4 — Redis/Postgres had no credential path.** Added `REDIS_URL/REDIS_PASSWORD/PG_HOST/PG_PORT`; Redis does RESP `AUTH` + `PING`; `NOAUTH` is red. Live: PONG.
- **P3 `[VERIFIED]` `[CONSENSUS]` C5 — the socket binds `0.0.0.0`, not loopback.** Moot once `/healthz` was dropped; the documentation falsehood remains in `map.md:27`.

## Disputes — ruled

| Issue | Positions | Ruling | Decided by |
|---|---|---|---|
| D1 / CLI-2 edge probes | client P1 vs live `PANEL_URL` | Upheld in reduced form, then fixed: v1 probe names were ambiguous and bare `/` follows the gate’s 302 | verifier curls: `/api/health` 200, `/socket.io` `0{...}`, bare `/` 302 apple |
| D2 / `/healthz` | client drop vs correctness works | Correctness won: drop the endpoint, read `admin:ready`. Socket process untouched for the page deploy | debate-r1 D2 + live socket uptime 02:24 → web-only restart 04:26 |
| D3 / socket exposure | client P3 vs devil/correctness P2 | P3, then moot: no new endpoint; UFW admits only `10.20.0.0/24` | debate-r1 D3 + UFW read |
| Judge J-1 | exact-host allowlist vs CIDR | Fixed: `PUBLIC_IP` + `ipInList` (CIDR) | source `health.js` + test |
| Judge J-2 | any 200 is capture green | Fixed: the probe requires the capture SPA title, not `quietBotPage` | live `capture SPA served` |

## Findings by severity

### P0 — before this ships
None.

### P1 — fixed
- `[VERIFIED]` `[EXISTING_DEFECT]` C1 db-mon join → alias + labels; live 9/9.
- `[VERIFIED]` `[EXISTING_DEFECT]` C2 statfs/threadpool → df child + async storage walk; 0.89 s request, non-blocking.
- `[VERIFIED]` U-1 storage sync NFS walk → bounded-concurrency `fsp`; `diskOf` df child. The route still takes ~0.9 s on the test account; it no longer blocks the loop.

### P2 — scheduled
- C3 S4 card is configured-state only until keys exist; newest marker, 24 h.
- S4 worker role localisation: the card is a total (`7/7`), not per-role; carrying `node`/`role` in `worker:ready` is the follow-up.
- `probeS4` stats one marker per account; bound it before S4 is enabled with thousands of accounts.
- Postgres green is TCP-only; auth is not checked (stated in the detail).
- Gate provider `:4100` is absent; ordinary visitors are decoyed. **Operational P1, out of scope.**
- S4 endpoint/bucket/key/secret are empty. **Operational P1, out of scope.**

### P3 — nits
- `map.md:27` still says the socket binds 127.0.0.1; it binds `0.0.0.0`.
- Re-shot at 1440×1900 (`screenshots/fleet-services-final-tall.png`): node table, Workers, Storage and Monitoring are all in frame.
- The gate row could say “known gap: `:4100` not built” explicitly; the detail now says “start the :4100 provider”.

## Dropped and refuted

- `[REFUTED]` COM-6 — `PANEL_URL` defaults to loopback. Live `PANEL_URL=http://82.221.139.233`; the probe crosses nginx.
- `[REFUTED]` “the screenshot shows capture 302” — the current file shows `capture path HTTP 200` / `capture SPA served`.
- `[QUOTE-MISMATCH]` U-1 in `findings.json` — expected: `storage.js` was changed after verification; the primary source quote no longer matches. The verifier had confirmed the defect, and the post-fix code is in the tree.

## Completeness audit

The auditor found three things the panel missed: U-1 (the panel shell still `statSync`ed the NFS tree), U-2 (the edge handshake leaked Engine.IO sessions; measured ~45–60 s, downgraded P3, close packet added), and U-3 (the gate token in the nginx log; fixed with `GATE_ADMIN_IPS`). It also independently confirmed C1 and C2, which is signal but not proof — same base model.

## What would change this verdict

A fault-injection run that freezes the NFS server for 60 s with the admin panel open and shows `/api/admin/health` and a visitor capture page still answering would retire the last fault-conditional P1; if both hang, the verdict moves to REVISE. Separately, the visitor path is not truly live until the `:4100` gate provider exists.

## Verification ledger

| Check | Result |
|---|---|
| `check_citations.py` | VERIFIED 16, QUOTE-MISMATCH 1 (U-1 after fix), blocking 0 |
| verifier | FIXED-IN-V2 3 (C1, C2, CLI-2), CONFIRMED 2 (U-1, U-3), DOWNGRADE 1 (U-2), REFUTED 0 |
| blind finals | median 8, spread 1 (8, 8, 7) |
| acceptance | 9/9 nodes; 401 anon; gate stub green→red; ocr-1 fault 8/9 red→green; worker 7/7→6/7 yellow→7/7; socket 11/11; tall screenshot |
| phases on disk | 0–9, including `challenge-*.json`, `review-*.json`, `debate-r1.md`, `verification.json`, `completeness-*.json`, `finals.json`, `judge.json` |

## Post-judge fixes (shipped after the ruling)

- Worker counts push on connect/disconnect; live 7/7 → 6/7 YELLOW → 7/7 GREEN.
- `overall` includes node rows; with a healthy gate, one dead exporter turns the headline red (verified).
- `joinNodeHealth` extracted and tested for label, alias, private-IP and missing-target branches.
- `storage.js` async walk; `diskOf` df child.
- Capture probe requires the SPA and matches `GATE_ADMIN_IPS` by CIDR through `PUBLIC_IP`.
- Gate detail names the missing `:4100` provider.

## First-plan challenge and client acceptance

Initial state: UNPROVEN. Challenge records: `challenge-client.json`, `challenge-devil-advocate.json`, `challenge-correctness.json` (≥3 investigated counterexamples each). Acceptance criteria: all pass except the fault-conditional hung-NFS test, which remains untested and is stated above. Plan revisions: v1 → v2 (node join, df child, no `/healthz`, edge URLs, injectable collector, cache), then the post-judge fixes. No automatic approval; the score is 8 because two operational gaps remain outside the change.

## Transcripts

`scope.md` · `map.md` · `plan.md` · `plan-v2.md` · `review-<seat>.json` · `challenge-<seat>.json` · `issue-table.md` · `debate-r1.md` · `completeness-blind.json` · `completeness-audit.json` · `verification.json` · `findings.json` · `finals.json` · `judge.json` · `evidence-fleet.txt` · `evidence-acceptance.txt`.
