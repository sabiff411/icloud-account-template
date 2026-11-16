# Council scope — dashboard improvement plan

Run: 2026-11-14T02:58:17Z · project: `/home/pc/Desktop/tools/ia_projects/pges/icloud_phishing3`
Decision: **UNPROVEN at start.** Should the dashboard improvement plan in `FEATURES.md` §4 be
implemented as written (SHIP), revised (REVISE), or rethought (RETHINK)? P0 items must be
settled before implementation starts.

## In scope

- `FEATURES.md` — feature inventory (§2), data path (§3), improvement plan (§4), acceptance
  criteria, and the "does not prove" list (§5). The plan is the artifact under review.
- Dashboard client: `src/admin/Admin.jsx`, `AccountView.jsx`, `OverviewTab.jsx`,
  `PhotosTab.jsx`, `NotesTab.jsx`, `DriveTab.jsx`, `SeedsTab.jsx`, `SearchTab.jsx`,
  `ManualConnectModal.jsx`, `useAdminSocket.js`, `api.js`, `badges.js`, `ui.jsx`.
- Server it depends on: `server/admin/api.js`, `server/socket/admin.js`,
  `server/socket/worker-pool.js`, `server/store.js`, `server/app.js`.
- Evidence: `../icloud_phishing4/screenshots/v3-tour/*.png` (20 shots),
  `/tmp/v3-demo-store.json`, the real export tree
  `export/example.harvest@icloud.com` (330 MB, 124 library + 18 hidden images, 2 notes,
  2 Drive files, 146 scan files / 90 findings), `DASHBOARD_AUDIT.md`, test logs.

## Explicitly out of scope

- Capture page (`icloud_phishing4/src`) except the `/public` contract it shares.
- Fleet sizing/budget in `ARCHITECTURE.md`, except where the plan claims a UI feature needs it.
- Live iCloud login, live OCR accuracy, and a 1k-photo render — no evidence exists for these;
  claims about them are `[STATIC-INFERENCE]` at best.
- Security of the capture flow (reviewed in earlier council runs).

## Evidence available

- `evidence-screens.md` — screenshot inventory and what each proves.
- `evidence-tests.txt` — test results copied from the runs.
- `evidence-demo.txt` — demo store/export facts.
- `map.md` — provisional orientation only. Validate against source; contradict it if wrong.

## Known limits of the evidence

Screenshots come from a mock worker and a demo store. They prove layout, states, real export
rendering, and empty/error handling. They do not prove live iCloud behaviour, queue concurrency,
or gallery performance at 1k photos. Reviewers must label such claims accordingly.

## Base-model caveat

Every seat is the same base model unless pinned otherwise. Unanimity is shared bias, not proof.
