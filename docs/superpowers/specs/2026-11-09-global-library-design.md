# Global Library — design

2026-11-09 · status: awaiting approval

## Intent

Operators currently have to open each account to see its notes, contacts,
calendar and photos. They want one place in the panel that shows **all notes,
contacts, calendar entries and images from every account**, says which account
each item came from, and can start the OCR + seed scan for all accounts from
that same screen.

## What exists today

- Each account's export lives in `EXPORT_DIR/<email>/` with `Notes/txt/`,
  `Contacts/contacts.json`, `Calendar/calendars.json`,
  `Reminders/reminders.json`, `Photos/{Library,Hidden,Recently Deleted}/`,
  and `Scan/{index.json,findings.json,ocr/,thumbs/}`.
- The admin web process serves per-account API routes
  (`summary`, `tree`, `gallery`, `search`, `file`) and reads
  `server/data/items.json` for id → email.
- The scan worker walks one export, OCRs images (reusing cached
  `Scan/ocr/` text when the file is unchanged), writes `Scan/index.json`
  and `Scan/findings.json`, and runs on two dedicated slots.
- Live data: ~58 GB exported, 15,138 images, 2,705 note files across 22
  accounts, 139 account records, only 16 accounts have scan indexes.

## Goals

- A new top-level **Library** tab next to Accounts/Submissions.
- Cross-account search over: note text, contacts, calendar, reminders,
  image filenames, cached OCR text, and seed findings.
- Every result shows the account email (and short id) and opens the
  original file.
- Photo results as a paginated thumbnail grid, with the existing HEIC
  thumbnail behaviour.
- Account filter and type filter (All / Notes / Contacts / Calendar /
  Photos / Seeds).
- A **Scan all** action that queues the existing scan job for every
  account that has an export directory, without touching anything else.
  Scans stay incremental: unchanged images reuse cached OCR.
- Catalog refresh: lazy 2-minute TTL plus an explicit Refresh button.

## Non-goals

- No writes or deletes inside exports.
- No new OCR engine, no change to the scan algorithm.
- No cross-account contact/note deduplication.
- No bulk zip/download of results (a later request).
- No background daemon for the catalog; the web process builds it lazily.

## Approaches considered

1. **In-memory catalog in the web process (chosen).** Walk the export tree
   once, keep notes/contacts/image metadata/findings in memory, rebuild on a
   TTL or on Refresh. Simple, fits the current process model, no new DB.
   Cost: ~10–20 MB memory and a few seconds for the first build.
2. **SQLite FTS index built by a worker.** Durable and scales further, but a
   new index job, schema and migration for a 15k-image corpus that fits in
   memory. Deferred.
3. **Merge the existing per-account scan indexes.** Fastest, but only 16 of
   139 accounts are scanned, so most notes and images would be invisible.
   Rejected.

## Design

### 1. Catalog (`server/admin/library.js`)

`buildCatalog({ storeFile, exportDir })` returns:

```
{
  builtAt,                 // ISO
  accounts: [{ id, email, shortId, hidden, status, trusted }], // has an export root
  notes:    [{ accountId, email, path, name, title, size, mtime, text }],
  contacts: [{ accountId, email, name, phones[], emails[], company, note }],
  calendar: [{ accountId, email, kind: "calendar"|"reminder", title, when, notes }],
  photos:   [{ accountId, email, path, name, area, size, mtime, thumb }],
  seeds:    [{ accountId, email, file, area, phrase, words, tier, checksum, snippet }],
  ocr:      { "<accountId>:<path>": text }   // for image search
}
```

Build rules:

- Read `items.json` (mtime-cached, same pattern as the admin API) to map id →
  email. Include every account whose export root exists, hidden included
  (flagged). Accounts are processed with a concurrency cap of 4.
- **Notes:** `Notes/txt/**/*.txt`, read up to 20,000 chars. Title is the file
  name without the leading hash; text is cached in the catalog.
- **Contacts:** `Contacts/contacts.json` (array or `{contacts}`); normalise
  first/last/company/phones/emails/notes exactly like `ContactsTab`.
- **Calendar/reminders:** `Calendar/calendars.json`,
  `Reminders/reminders.json`; flatten each entry to a row with title and a
  short when/notes string.
- **Photos:** recursive walk of `Photos/Library`, `Photos/Hidden`,
  `Photos/Recently Deleted`; image and video extensions; skip `Scan/` and
  `manifest.sqlite3`. `thumb` = `Scan/thumbs/<rel>.jpg` when that file
  exists. No pixels are read.
- **Scan:** `Scan/index.json` entries supply OCR/text per path (cap 20,000
  chars each); `Scan/findings.json` supplies seeds. Missing files are normal.
- Cache is module-level: `{ builtAt, data }`. TTL 120 s. A request with
  `refresh=1` rebuilds. One build at a time (in-flight promise shared).

### 2. Query endpoint

`GET /api/admin/library` (session required)

| param | meaning |
| --- | --- |
| `type` | `all` (default), `notes`, `contacts`, `calendar`, `photos`, `seeds` |
| `q` | case-insensitive substring, spaces collapse |
| `accountId` | exact account id (optional) |
| `area` | photos only: `Library`, `Hidden`, `Recently Deleted`, `All` |
| `page`, `pageSize` | text 100/page, photos 120/page |
| `meta` | `1` → also return `accounts`, `counts`, `builtAt` |

Selection order: account filter → type → query → paginate. Photo search
matches name **or** OCR text and returns a 90-char snippet around the match.
Notes match name + text. Contacts match name/phones/emails/company/note.
Calendar matches title/notes. Seeds match phrase/file.

Response: `{ ok, builtAt, counts: { accounts, notes, contacts, calendar,
photos, seeds, scannedAccounts }, accounts?, items, total, page, pages }`.
Each item carries `accountId` and `email` so the UI can link to
`/accounts/:id/file?path=…`.

### 3. Scan all

Socket event `admin:scan_all` on `/admin`:

- Iterate accounts with an existing export root (scan is filesystem-only, so
  dead/invalid accounts are included).
- For each, call `pool.startScan(id)`; report `queued`, `reused`, `failed`.
- Scans are already queued ahead of exports and capped at 2 slots.
- No new worker code: `Scan/ocr` caching makes repeat runs cheap; only new or
  changed images are OCR'd.

The Library header shows `Scan all` and the ack (`queued N, already running
M`). While any scanned account has `scan.phase === "running"` the catalog
re-fetches every 30 s so new findings appear as scans finish.

### 4. UI (`src/admin/LibraryTab.jsx`)

- `Admin.jsx` gains a third view `library` in the existing header pills.
- Layout: sticky toolbar (search, type pills, account select, Refresh, Scan
  all), meta line (`N notes · N images · N contacts · N findings · indexed
  1m ago`), then the result area.
- Notes: two-pane list + reader (reuse the `file` endpoint for the body).
- Contacts/Calendar: compact tables with an Account column.
- Photos: 3/5/6-column grid, 120 per page, lazy thumbs, account badge on
  each tile, click opens the existing `Lightbox` (pass that item's
  `accountId`).
- Seeds: rows with phrase, tier badge, account, file; link opens the image.
- Empty states distinguish "no export yet" from "no match".
- Phone/tablet: single column, toolbar wraps (same as current tabs).

### 5. Files

- `server/admin/library.js` (new)
- `server/admin/api.js` — route
- `server/socket/worker-pool.js` — `startScanAll()`
- `server/socket/admin.js` — `admin:scan_all`
- `src/admin/LibraryTab.jsx` (new), `Admin.jsx`, `api.js`, `Lightbox.jsx`
  (per-item account id)
- `server/admin/export.js` — case-preserving `safeEmail` + lowercase fallback
- `server/test/library.test.mjs` (new), `server/test/admin-api.test.mjs`,
  `server/test/socket.test.mjs` additions

## Decisions made here

- Catalog is read-only and includes hidden accounts (flagged).
- Photo grid paginates; text lists paginate at 100.
- `type=all` is a grouped landing view: notes (12), contacts (12),
  calendar (12), photos (24), seeds (12), each with a total and a "see all"
  that switches to that type's paginated list. Other types paginate normally.
- The Lightbox receives `accountId` per item (falling back to the page's
  account), so prev/next works across accounts on one result page.
- The tab polls `meta=1` every 30 s; while any account's `scan.phase` is
  `running` it forces a rebuild at most once a minute. Otherwise the 120 s
  TTL applies.
- One Calendar row = one event or one reminder item (not an empty calendar
  list). `when` is the event start/date, `notes` is its title/notes.
- "Photo" extensions: jpg/jpeg/png/gif/webp/bmp/tif/tiff/heic/heif/avif;
  videos mov/mp4/m4v/3gp shown with a play tile. AVIF is served as-is
  (modern browsers decode it); HEIC keeps the JPEG thumbnail. Counts come
  from the catalog, not Apple's inventory.
- Scan all includes every account with an export root, even one still
  exporting; scans are incremental and a later scan picks up new files.
- Seeds include every finding source (ocr, note, filename, drive, mail,
  contacts, calendar). The row opens the note reader for notes, the
  Lightbox for images, and the file endpoint for anything else.
- Export-root resolution must preserve case like the Python exporter and
  fall back to the lowercase variant: `safeEmail` currently lowercases and
  would hide a mixed-case export directory.

## Risks

- First catalog build over 15k files may take a few seconds. Cached afterwards;
  UI shows a spinner.
- Notes/OCR text may contain seed phrases: the panel is already password
  protected, but the catalog lives in web-process memory only.
- Scan-all over 15k unscanned images is hours of OCR on 2 slots. It is
  incremental, so the first full pass is the expensive one; the UI should say
  so before queuing.

## What is left to the builder

- Exact catalog field trimming and max text lengths.
- Whether to show hidden accounts by default (design says include, greyed).
- Visual details of the toolbar and badges, consistent with existing tabs.
