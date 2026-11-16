# Debate round 1

Only contested points. Position changes cite new evidence; no capitulation without it.

## D1 — CLI-2, edge probes (client vs live evidence)

**Opposing claim:** the live `/opt/icloud3/.env` has `PANEL_URL=http://82.221.139.233`,
so the web probe traverses nginx; the socket probe still bypasses it.

**Client — HOLD:** "Live `PANEL_URL` is peer-supplied; if the probe hits bare `/`, it is
not exempt (`gate.js:473`) and gets a 302 to apple.com (`gate.js:484`), so `fetch` reports
green off the decoy. `plan.md:66` still probes `:4001` directly. P1 if bare origin; P2 if
`/admin` is appended."

**Ruling input:** the finding survives in reduced but still release-relevant form. The plan
must name the exact edge URLs, because bare `/` follows the gate's 302 and reads green.
`/api/health` (exempt) plus `/socket.io` through nginx are the correct probes. Severity P1
for the ambiguity as written; the fix is a one-line URL change.

## D2 — CLI-5 / COR-7, socket `/healthz` (client vs correctness)

**Correctness — REVISE:** "`src/admin/Admin.jsx:361` already renders `state.status`, and
`server/socket/admin.js:108` already sends `workers: pool.slotStats()`. So v1 needs no
socket edit and no icloud-socket restart — which `removeWorker`
(`worker-pool.js:1504-1512`) makes lossy."

**Client — REVISE:** "Concede dropping `/healthz` — `plan.md:93` needs it. Keep only the
restart gate: `worker-pool.js:1507-1514` requeues running jobs while Python keeps
exporting and reconnects in 2 s (`__main__.py:348`). Restart with no running/twofa job;
acceptance asserts 7 workers and queue drains. P3."

**Resolution:** drop `/healthz` from v1. Worker counts come from the existing
`admin:ready` payload in the SPA. No socket process change, no socket restart. COR-7 is
moot; COR-5's in-flight cache still applies to the HTTP probes.

## D3 — CLI-8 / DEV-5 / COR-8, socket exposure (client vs correctness)

**Correctness — REVISE:** "mesh-only readers already hold `WORKER_TOKEN` and richer
payloads... unauthenticated `/healthz` is P3, not P2; the `map.md:27` falsehood and
latent all-interface bind stand."

**Client — HOLD:** "P3 stands, narrowed: counts readable by any 10.20.0.0/24 host. Not
moot — `/healthz` stays." (Contradicts its D2 concession; resolved by dropping the
endpoint.)

**Resolution:** P3. Correct `map.md:27`: `listen(port)` binds `0.0.0.0`; UFW admits only
`10.20.0.0/24`. No new endpoint, so the disclosure is the existing worker socket only.

## Accepted without debate

C1, C2, C3, C4, S3, S4, S5, S6, S8, S9, S10. See `issue-table.md`. All 22 findings were
citation-verified by `check_citations.py` (`VERIFIED=22`, 0 blocking).

## Bias note

All three seats share the same base model. Two P1s were found independently by all three
(the db-mon join and statfs), which is signal, not proof: shared training can share the
same blind spot. No seat flipped a factual position without new evidence.
