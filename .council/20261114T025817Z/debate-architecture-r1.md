ISSUE ARCH-1 / DA-3 | position: REVISE

EVIDENCE: verify.py:90-99 seeds `live` empty; a failed area stays empty (:215-217); compare always emits live 0/missing 0 (:272-275); OverviewTab.jsx:43 prints `complete`. Matrix lies.

Minimum fix: per-area `ok` flag, on successful read only (Library fallback counts); compare emits ok, unknown missing when false; worker-pool keeps last good area; UI tri-state. Python-side; boundary finding holds.
