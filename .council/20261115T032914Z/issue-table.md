# Issue table — Services health plan v1

## Consensus (independent, ≥2 seats)

| ID | Issue | Seats | Sev | Status |
|---|---|---|---|---|
| C1 | Prometheus node join by private IP cannot match db-mon-1 (`host.docker.internal:9100`), so a healthy fleet shows a red data node | client CLI-1, devil DEV-1, correctness COR-1 | P1 | accepted |
| C2 | `fs.promises.statfs` is not bounded by a race; a hard NFS mount (`hard,timeo=600`) can pin all 4 libuv threads and stall the web tier | client CLI-3, devil DEV-2, correctness COR-2 | P1 | accepted |
| C3 | S4 "heartbeat < 10 min" has no producer; the card is yellow by construction | client CLI-6, correctness COR-4 | P2 | accepted |
| C4 | Redis/Postgres have no host/credential path in the web process; NOAUTH is mapped to yellow forever | devil DEV-4, correctness COR-3 | P2 | accepted |
| C5 | Socket listens on `0.0.0.0:4001` (map says loopback); a new unauthenticated `/healthz` would expose counts to the mesh | devil DEV-5, client CLI-8, correctness COR-8 | P2/P3 | disputed severity, accepted fact |

## Single-source

| ID | Issue | Seat | Sev | Status |
|---|---|---|---|---|
| S1 | Edge probes are loopback; the socket probe skips nginx and the `/socket.io` proxy | client CLI-2 | P1 | **disputed** (live `PANEL_URL` is public) |
| S2 | Restarting `icloud-socket` for `/healthz` requeues live jobs; counts already reach the SPA | client CLI-5 | P2 | **disputed** (design) |
| S3 | Gate acceptance asserts only red; a permanently-red probe passes | client CLI-4 | P2 | accepted |
| S4 | "Worker per expected role" is unimplementable; the pool has no role/node | devil DEV-3 | P2 | accepted |
| S5 | 5 s read-through cache does not dedupe concurrent misses | correctness COR-5 | P2 | accepted |
| S6 | The health route is not injectable; the API test performs real network probes and asserts only key presence | correctness COR-6 | P2 | accepted |
| S7 | `/healthz` body nests `workers.workers`; `scan` is not in `slotStats()` | correctness COR-7 | P3 | accepted (moot if dropped) |
| S8 | `FLEET_NODES_JSON` parsed at import can stop the whole web process on a typo | correctness COR-9 | P2 | accepted |
| S9 | `collectHealth()` is called with no args while the signature destructures | client CLI-7 | P3 | accepted |
| S10 | NFS ratio formula unspecified; `(blocks-bfree)/blocks` differs from `df`'s `used/(used+avail)` | correctness open question | P2 | accepted |

## Live evidence added after the blind round

- `PANEL_URL=http://82.221.139.233` in `/opt/icloud3/.env`, so the planned
  web probe crosses nginx; the socket probe still bypasses it.
- `/srv/icloud` is mounted `hard,timeo=600,nconnect=8` on session-1.
- `4001/tcp` is allowed only from `10.20.0.0/24`; public `:4001` is closed.
- Prometheus targets carry only `instance`; db-mon-1 is `host.docker.internal:9100`.
- `df -P` reports 5.5 %; `statvfs` `(blocks-bfree)/blocks` reports 5.2 %.

## Debate agenda

- **D1 (S1):** does the public `PANEL_URL` refute the "web probe is a tautology" half of CLI-2?
- **D2 (S2):** keep the socket `/healthz` endpoint, or take worker counts from the
  existing `admin:ready` and leave the socket process untouched?
- **D3 (C5):** if `/healthz` is dropped, does the P2/P3 exposure dispute still matter?
