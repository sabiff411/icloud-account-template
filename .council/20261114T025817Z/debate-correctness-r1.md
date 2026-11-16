ISSUE COR-1 / DA-3 | position: REVISE

EVIDENCE
DA-3 is right about the data I proposed reusing. `live` starts every area as an
empty set (python/worker/verify.py:90-99); the hidden/deleted loop swallows the
exception and leaves the key empty (:212-219); compare() then does
`live_set = set(live.get(area) or set())` (:269) and reports
`{"live": 0, "exported": N, "missing": 0}` (:272-276). OverviewTab renders
`missing > 0` as a red badge and everything else as "complete"
(src/admin/OverviewTab.jsx:34-44). So a 410 on Hidden renders "complete", and
the operator is told nothing is missing from an area nobody read.

It does not defeat COR-1: the reconciliation exists, the plan duplicates it, and
the plan's own matrix inherits the same conflation. It defeats "reuse as-is".

The fix has an in-repo precedent: counts_out already encodes the rule DA-3
wants - "A key is only written when its enumeration succeeded - a failed
service must not overwrite a good number with 0" (verify.py:83-85). compare()
is the one shape that forgot it.

MINIMUM CHANGE (three lines, no schema)
1. verify.py enumerate_live: add `read_ok: set[str]`; add "photos" at :209,
   "hidden"/"deleted" at :215, and the area name at the end of each of the
   notes (:222-229), drive, contacts/calendar/reminders try blocks.
2. verify.py compare(live, ids, exported, read_ok): `if area not in read_ok:`
   emit `areas[area] = {"unread": True}` and no missing count; never fall
   through to live 0 / missing 0.
3. src/admin/OverviewTab.jsx AreaRow: if `data.unread` render
   "not read (last good <timeAgo>)", never the "complete" badge.
Node needs no change: handleVerifyResult stores payload.areas verbatim
(server/socket/worker-pool.js:1255).

EFFECT ON THE FINDING
COR-1 HOLD on the premise and the fix target; the fix text is amended to
"render verify.areas with an unread state" instead of "render verify.areas".
COR-3 (counts is disk, not live) is unaffected: it fails before any area read.
COR-2 (104 vs 124) is unaffected: it is a manifest/disk mismatch, not a
failed read. If P0-2 ships a manifest-derived matrix, it must also distinguish
"attempted and failed" from "not downloaded", or DA-3 reproduces there.
