# Global Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a panel Library that searches notes, contacts, calendar, images and seed findings across every account in one place, and OCRs downloaded images automatically.

**Architecture:** The admin web process builds an in-memory catalog by walking each export root once (metadata + note text + existing OCR text), caches it for two minutes, and serves a single `/api/admin/library` query endpoint. The socket process queues incremental scans for every account and after export progress milestones. The panel adds a Library tab with two landing buttons and type-specific result views.

**Tech Stack:** Node 22, Express, Socket.IO, React 18 + Vite, node:test-style standalone test scripts.

**Spec:** `docs/superpowers/specs/2026-11-09-global-library-design.md`

## Global Constraints

- Read-only on exports; never write or delete inside `EXPORT_DIR/<email>`.
- Catalog TTL 120 s; `refresh=1` forces a rebuild; one build at a time.
- Export-root resolution must preserve case like the Python exporter and fall back to the lowercase directory.
- Scan-all must reuse an active scan and never queue a duplicate.
- Text pagination 100/page; photos 120/page.
- OCR is background: incremental scan after 200 new files or 10 minutes, whichever first, plus the existing scan on export completion.

## Review Focus

- A first build over 58 GB / 15k files must not block the event loop; use async fs and a four-account concurrency cap.
- A mixed-case email export directory must still resolve (case-preserving `safeEmail` + lowercase fallback).
- HEIC/AVIF images without a JPEG thumb must show a placeholder, never a broken `<img>`.
- An image with OCR pending must still be found by filename and shown with a pending badge.
- Scan-all over 139 accounts must return immediately with queued/reused counts, not wait for scans to finish.

---

### Task 1: Catalog builder and query

**Files:**
- Create: `server/admin/library.js`
- Test: `server/test/library.test.mjs`

**Interfaces:**
- Consumes: `safeName` from `server/admin/export.js`; `items.json` `{ accounts: [...] }`.
- Produces:
  - `buildCatalog({ storeFile, exportDir, force = false }) -> Promise<Catalog>`
  - `queryCatalog(catalog, { type = "all", q = "", accountId = "", area = "All", page = 1, pageSize = 0 }) -> QueryResult`
  - `accountsWithExport(accounts, exportDir) -> Promise<Array>`
  - `invalidateCatalog() -> void`
  - `Catalog` shape: `{ builtAt, accounts[], notes[], contacts[], calendar[], photos[], seeds[], ocr }` exactly as the spec's catalog block; each account has `{ id, email, shortId, hidden, status, trusted, scanPhase }`.
  - `QueryResult`: `{ builtAt, type, items, total, page, pages, totals, counts, accounts }`; `counts` includes `scanning` (accounts with `scanPhase === "running"`).

- [ ] **Step 1: Write the failing test**

Create `server/test/library.test.mjs`. Build a temp tree with two accounts: `alice@example.com` (lowercase dir) and `MariaJackson@example.com` (mixed-case dir). Alice has a note with a seed phrase, contacts using `emailAddresses`, one calendar event, one JPG with `Scan/ocr` text, one HEIC with a thumb, and `Scan/findings.json`; Maria has one note.

Assertions:

```js
const catalog = await buildCatalog({ storeFile, exportDir, force: true });
assert.equal(catalog.accounts.length, 2);
assert.equal(catalog.notes.length, 2);
assert.equal(catalog.contacts[0].emails[0], "bob@example.com");
assert.equal(catalog.calendar[0].title, "Dentist");
assert.equal(catalog.photos.find((p) => p.name === "IMG_0001.jpg").ocr, true);
assert.equal(catalog.photos.find((p) => p.name === "IMG_0002.jpg").ocr, false);
assert.equal(catalog.photos.find((p) => p.name === "HEIC_1.HEIC").thumb, "Scan/thumbs/Photos/Library/HEIC_1.HEIC.jpg");

const byText = queryCatalog(catalog, { type: "notes", q: "wallet" });
assert.equal(byText.items.length, 1);
assert.equal(byText.items[0].email, "alice@example.com");

const mixed = queryCatalog(catalog, { type: "notes", q: "maria" });
assert.equal(mixed.items[0].email, "MariaJackson@example.com");

const image = queryCatalog(catalog, { type: "photos", q: "safe code" });
assert.equal(image.items[0].name, "IMG_0001.jpg");

const pending = queryCatalog(catalog, { type: "photos", q: "IMG_0002" });
assert.equal(pending.items[0].ocr, false);

const onlyAlice = queryCatalog(catalog, { accountId: "alice-id", type: "all" });
assert.equal(onlyAlice.counts.notes, 1);
assert.ok(onlyAlice.counts.ocrDone >= 1 && onlyAlice.counts.ocrPending >= 1);

const targets = await accountsWithExport(
  [{ id: "m", email: "MariaJackson@example.com" }],
  exportDir
);
assert.equal(targets.length, 1);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node server/test/library.test.mjs`
Expected: failure because `server/admin/library.js` does not exist.

- [ ] **Step 3: Implement `server/admin/library.js`**

Read `items.json` with an mtime cache. For each account, resolve `path.join(exportDir, safeName(email))`, then the lowercase variant if missing; skip accounts without a directory. Process accounts with a four-way concurrency cap.

- Notes: every `Notes/txt/**/*.txt`, text capped at 20,000 chars; `title` = filename after the first `_`.
- Contacts: `Contacts/contacts.json`; `name` from first/last or name/company; phones from `phones[].field`; emails from `emails[].field` **or** `emailAddresses[].field`; note from `notes`/`note`.
- Calendar: `Calendar/calendars.json` `events[]`, row `{ kind:"calendar", title, when, notes }`, `when` from `startDate` `[Y,M,D,h,m,s]` formatted `YYYY-MM-DD HH:MM`, notes from `location`/`description`. Reminders: `Reminders/reminders.json` as a flat or nested list, one row per item with a `title`.
- Photos: recursive walk of `Photos/Library`, `Photos/Hidden`, `Photos/Recently Deleted`; extensions jpg/jpeg/png/gif/webp/bmp/tif/tiff/heic/heif/avif; `thumb` when `Scan/thumbs/<rel>.jpg` exists; `ocr` when `Scan/ocr/<rel>.txt` exists.
- Scan: `Scan/index.json` entries → `ocr["<accountId>:<path>"] = text` (cap 20,000); `Scan/findings.json` → seeds with `accountId`, `email`, `shortId`, `file`, `area`, `phrase`, `words`, `tier`, `checksum`, `snippet`.
- `queryCatalog`: account filter → type → q (case-insensitive) → sort (notes/photos mtime desc, contacts name, calendar when desc, seeds tier order valid/high/medium/minimum/low) → paginate. `type=all` returns grouped `items` `{notes,contacts,calendar,photos,seeds}` capped at 12/12/12/24/12 plus `totals`; single types return an array. Counts include `ocrDone`, `ocrPending`, `scannedAccounts` (accounts with a `Scan/index.json`).
- Cache: `{ builtAt, data, at, key, promise }`; TTL 120_000; `force` bypasses; `invalidateCatalog()` clears.

- [ ] **Step 4: Run the test**

Run: `node server/test/library.test.mjs`
Expected: `library test ok`.

- [ ] **Step 5: Commit**

```bash
git add server/admin/library.js server/test/library.test.mjs
git commit -m "feat(admin): global library catalog and query"
```

---

### Task 2: Library API route and case-preserving export root

**Files:**
- Modify: `server/admin/export.js` (`safeEmail`)
- Modify: `server/admin/api.js` (route after `/accounts/:id/file`)
- Test: `server/test/admin-api.test.mjs`

**Interfaces:**
- Consumes: `buildCatalog`, `queryCatalog` from Task 1.
- Produces: `GET /api/admin/library?type=&q=&accountId=&area=&page=&pageSize=&refresh=&meta=` returning `{ ok, builtAt, type, items, total, page, pages, totals, counts, accounts }`.

- [ ] **Step 1: Add the failing API assertion**

In `server/test/admin-api.test.mjs`, after the existing gallery/search checks, add a note file `Notes/txt/wallet.txt` containing `wallet abandon abandon abandon` and request `/api/admin/library?type=notes&q=wallet&meta=1`. Assert status 200, `items.length === 1`, `items[0].email === email`, and `counts.notes >= 1`.

- [ ] **Step 2: Run it**

Run: `node server/test/admin-api.test.mjs`
Expected: 404 for `/library`.

- [ ] **Step 3: Implement**

- `safeEmail(email)`: remove `.toLowerCase()` (keep `safeName(trim)`); `accountFor` already retries the lowercase root.
- Route: `router.get("/library", requireSession, asyncRoute(async (req, res) => { const catalog = await buildCatalog({ storeFile, exportDir, force: req.query.refresh === "1" }); const result = queryCatalog(catalog, { type: req.query.type, q: req.query.q, accountId: req.query.accountId, area: req.query.area, page: req.query.page, pageSize: req.query.pageSize }); res.json({ ok: true, ...result }); }))`.

- [ ] **Step 4: Run the test**

Run: `node server/test/admin-api.test.mjs`
Expected: `admin api test ok`.

- [ ] **Step 5: Commit**

```bash
git add server/admin/export.js server/admin/api.js server/test/admin-api.test.mjs
git commit -m "feat(admin): /api/admin/library and case-preserving export roots"
```

---

### Task 3: Scan-all and automatic OCR scheduling

**Files:**
- Modify: `server/socket/worker-pool.js`
- Modify: `server/socket/admin.js`
- Test: `server/test/library.test.mjs` (accountsWithExport already covered, add `shouldScanForOcr`)

**Interfaces:**
- Produces:
  - `pool.startScanAll({ exportDir = config.icloud.exportDir } = {}) -> Promise<{ queued, reused, failed }>`
  - `shouldScanForOcr(mark, done, now, { files = 200, ms = 600000 }) -> boolean` (exported pure helper)
  - socket event `admin:scan_all` → ack `{ ok, queued, reused, failed }`.

- [ ] **Step 1: Add the failing scheduler test**

In `server/test/library.test.mjs`:

```js
import { WorkerPool, shouldScanForOcr } from "../socket/worker-pool.js";
assert.equal(shouldScanForOcr({ done: 0, at: 0 }, 199, 1_000_000), false);
assert.equal(shouldScanForOcr({ done: 0, at: 0 }, 200, 1_000_000), true);
assert.equal(shouldScanForOcr({ done: 500, at: 1_000_000 }, 600, 1_100_000), false);
assert.equal(shouldScanForOcr({ done: 500, at: 1_000_000 }, 600, 1_600_000), true);

// Scan-all reuses an active scan and reports it.
const pool = Object.create(WorkerPool.prototype);
pool.store = { accounts: new Map([["m", { id: "m", email: "MariaJackson@example.com" }]]) };
pool.startScan = async () => ({ reused: true });
assert.deepEqual(await pool.startScanAll({ exportDir }), { queued: 0, reused: 1, failed: 0 });
```

- [ ] **Step 2: Run it**

Run: `node server/test/library.test.mjs`
Expected: import error / assertion failure.

- [ ] **Step 3: Implement**

- Export `shouldScanForOcr(mark, done, now, { files = 200, ms = 10 * 60_000 } = {})` returning `done - (mark?.done ?? 0) >= files || now - (mark?.at ?? 0) >= ms`.
- In `WorkerPool` constructor: `this.ocrMarks = new Map()`.
- In `handleExportProgress`, after the account update, call `this.scheduleOcr(account, overallDone)`. `scheduleOcr` skips when `store.activeJobForAccount(account.id, "scan")` exists, otherwise if `shouldScanForOcr` it sets the mark and calls `this.startScan(account.id).catch(...)`.
- `startScanAll({ exportDir = config.icloud.exportDir } = {})`: `const targets = await accountsWithExport([...this.store.accounts.values()], exportDir);` for each, `startScan`; count `reused` when the result says reused.
- `server/socket/admin.js`: guarded `admin:scan_all` handler calling `pool.startScanAll()` and replying.

- [ ] **Step 4: Run tests**

Run: `node server/test/library.test.mjs`
Expected: `library test ok`.
Run: `node --check server/socket/worker-pool.js && node --check server/socket/admin.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add server/socket/worker-pool.js server/socket/admin.js server/test/library.test.mjs
git commit -m "feat(socket): scan all accounts and OCR during exports"
```

---

### Task 4: Frontend API plumbing

**Files:**
- Modify: `src/admin/api.js`
- Modify: `src/admin/useAdminSocket.js`

**Interfaces:**
- Produces: `libraryUrl(params) -> string`, `getLibrary(params) -> Promise`, `admin.scanAll() -> Promise<{ queued, reused, failed }>`.

- [ ] **Step 1: Implement**

- `libraryUrl(params)` builds `/api/admin/library?` with the same URLSearchParams pattern as `accountUrl`.
- `getLibrary(params)` = `getJson(libraryUrl(params))`.
- `useAdminSocket`: `const scanAll = useCallback(async () => emit("admin:scan_all", {}), [emit]);` and include it in the returned object.

- [ ] **Step 2: Verify**

Run: `node --check src/admin/api.js` and `node --check src/admin/useAdminSocket.js`
Expected: no output. (Vite build is checked in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add src/admin/api.js src/admin/useAdminSocket.js
git commit -m "feat(admin): library fetch and scan-all client"
```

---

### Task 5: Library tab — landing, search, notes, photos

**Files:**
- Create: `src/admin/LibraryTab.jsx`
- Modify: `src/admin/Lightbox.jsx`

**Interfaces:**
- Consumes: `getLibrary`, `fileUrl`, `getText`, `accountUrl`, `displayName`, `bytes`, `Spinner`, `Empty`, `Badge`; `admin.scanAll`, `admin.state.accounts`.
- Produces: default `LibraryTab({ admin })`.

- [ ] **Step 1: Implement the tab shell**

- State: `type` (`"landing"` initially), `q`, `accountId`, `page`, `data`, `loading`, `error`, `note` (selected item + text), `open` (photo index).
- Fetch `getLibrary({ type: type === "landing" ? "all" : type, q, accountId, page, meta: 1 })`; debounce q 300 ms.
- Landing: two large buttons `All notes (N)` and `All images (N · OCR x/y)` using `data.totals`; plus pills Contacts / Calendar / Seeds.
- Toolbar: search, account `<select>` from `data.accounts`, Refresh (`refresh:1`), Scan all.
- Meta: `N notes · N images · OCR x/y · N contacts · N findings · indexed <timeAgo>`.

- [ ] **Step 2: Notes and photos**

- Notes: left list (title, account, snippet), right reader via `getText(fileUrl(item.accountId, item.path))`.
- Photos: grid 120/page; HEIC/AVIF without thumb shows a placeholder tile; OCR badge vs `pending`; account label; pagination; Lightbox with `items` and per-item `accountId`.
- `Lightbox.jsx`: resolve `const owner = item.accountId ?? accountId;` for every `fileUrl`/download, and use it in the image src.

- [ ] **Step 3: Build**

Run: `VITE_SOCKET_URL= npm run build`
Expected: `✓ built`.

- [ ] **Step 4: Commit**

```bash
git add src/admin/LibraryTab.jsx src/admin/Lightbox.jsx
git commit -m "feat(admin): Library notes and photo search"
```

---

### Task 6: Library tab — contacts, calendar, seeds, scan all

**Files:**
- Modify: `src/admin/LibraryTab.jsx`

- [ ] **Step 1: Implement the remaining types**

- Contacts table: Name, Phones, Emails, Company, Note, Account.
- Calendar table: Title, When, Notes, Account.
- Seeds table: Phrase, Tier badge, Account, File (link opens the image/note).
- Empty states distinguish "nothing exported yet" from "no match".
- Scan all: call `admin.scanAll()`, show `Queued N · already running M`, refetch after 5 s; poll `getLibrary({ type:"all", meta:1, refresh: scanning ? "1" : "" })` every 30 s, forcing at most once a minute while `counts.scanning > 0`.

- [ ] **Step 2: Build**

Run: `VITE_SOCKET_URL= npm run build`
Expected: `✓ built`.

- [ ] **Step 3: Commit**

```bash
git add src/admin/LibraryTab.jsx
git commit -m "feat(admin): Library contacts, calendar, seeds and scan all"
```

---

### Task 7: Admin integration, tests, deploy

**Files:**
- Modify: `src/admin/Admin.jsx`

- [ ] **Step 1: Add the top-level view**

- Add a `Library` pill beside Accounts/Submissions, `view === "library"`, render `<LibraryTab admin={admin} />` in `<main>`.
- Keep the accounts list hidden when the Library view is active (same as Submissions).

- [ ] **Step 2: Run the full checks**

```bash
npm run test:py
node server/test/library.test.mjs
node server/test/admin-api.test.mjs
node server/test/views.test.mjs
node server/test/store.test.mjs
VITE_SOCKET_URL= npm run build
```

Expected: all pass, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/admin/Admin.jsx
git commit -m "feat(admin): Library tab"
```

- [ ] **Step 4: Deploy and verify live**

Run `./deploy.sh --allow-dirty` from `tools_vps/icloud3-vps`, then:

```bash
curl -s -u panel:<password> https://signin.connection-apple.com/api/admin/library?type=all&meta=1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['counts'])"
```

Expected: counts with `notes`, `photos`, `ocrDone`, `ocrPending`, and `accounts`. Then open `/admin`, Library, search a known note and a known OCR string, and check Scan all returns queued/reused counts.
