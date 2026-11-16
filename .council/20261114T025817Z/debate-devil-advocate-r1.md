ISSUE DA-3 | position: REVISE

EVIDENCE: python/worker/verify.py:209 `if photo_ok:` shows a success signal exists only for photos; :212-219 swallows hidden/deleted exceptions and leaves the default empty set; :269 `live_set = set(live.get(area) or set())` cannot distinguish genuine empty from failed. So the unavailable marker must originate in enumerate_live (a success flag or None), not be invented inside compare. "last verified" already renders at src/admin/OverviewTab.jsx:234. No independent manifest read is required for this scenario: verify.areas already carries live/exported/missing, and bytes/last-export can come from the same result. The remaining requirement is that P0-2's acceptance inject one failed album read and assert "unavailable", not "complete".

NEW ISSUE? none
