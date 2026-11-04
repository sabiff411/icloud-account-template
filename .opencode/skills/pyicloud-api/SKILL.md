---
name: pyicloud-api
description: "Use when working with the pyicloud library (timlaing/Pyicloud, 2026.10.x or main): logging in to an Apple ID, persisting a trusted session without repeated 2FA, or reading and mutating iCloud Photos (incl. Hidden and Recently Deleted), iCloud Drive, Notes, Calendar, Contacts, Reminders, Invites, Mail, Find My devices, Account or Hide My Email. Covers the public service surface with parameters and defaults, when to use which parameter, session/cookie/trust lifetime, exception handling, the icloud CLI, and the two local downloader scripts."
---

# pyicloud — complete API and session reference

## Core principle

**The library owns the protocol; your code owns the policy.** Do not patch
site-packages. Pin the version, know which release you are on, and treat Apple's
`webservices` map — not a hard-coded endpoint list — as the permission gate.

Two releases matter:

| You are on | Identify it | Contains |
|---|---|---|
| PyPI **2026.10.1** (2026-10-15) | `pip show pyicloud` | everything except the "main-only" rows below |
| **main** `2026.10.2.dev*` | git install | + Mail, Invites create/publish/invite-link, shared Reminders routing, atomic session saves, URL redaction |

Main-only at the time of writing: `api.mail`, `InvitesService.create_event()`
`publish()` `invite_via_link()`, Reminders shared-list routing, atomic
`.session`/`.cookiejar` replacement, redacted debug URLs. Everything else below
exists in 2026.10.1.

## Route by task (load one reference, not all)

| You need | Property | Read |
|---|---|---|
| one 2FA, reuse for weeks; cookie/trust lifetime | — | `references/auth-and-session.md` |
| Account, Find My, Calendar, Contacts, Drive, Hide My Email | `api.account` `api.devices` `api.calendar` `api.contacts` `api.drive` `api.hidemyemail` | `references/services-core.md` |
| Photos (hidden, deleted, live, shared), Notes | `api.photos` `api.notes` | `references/services-media.md` |
| Reminders, Invites, Mail | `api.reminders` `api.invites` `api.mail` | `references/services-collab.md` |
| the two local downloader scripts, resume/manifest | — | `references/downloaders.md` |
| exact model fields, dates, exception tree | — | `references/data-models.md` |
| a feature the package lacks, or adding/editing code | — | `references/unsupported-and-extending.md` |
| "is this a known bug / what changed?" | — | `references/upstream-issues.md` |
| terminal commands, doctor, logout | `icloud ...` | `references/cli.md` |

**Not exposed by pyicloud** (plan custom work, not a service property): Voice
Memos, iCloud Keychain/Passwords decryption, Photos shared-album creation/
upload, Notes creation/editing, Mail Drop upload, and document semantics for
Pages/Numbers (opaque Drive files). "Memos" in this project means `api.notes` —
Notes read/render/export is fully supported; only writes are missing. Code
recipes for all of the above are in
`references/unsupported-and-extending.md`.

## The session recipe (memorise this)

```python
from pathlib import Path
from pyicloud import PyiCloudService

ROOT = Path.home() / ".local/share/myapp/icloud"
SESSION = ROOT / "account-1"          # one directory per Apple ID
SESSION.mkdir(parents=True, exist_ok=True)
password = None                        # None = OS keyring; otherwise getpass()

# 1. Cheap, password-free preflight against the stored session.
api = PyiCloudService(email, cookie_directory=str(SESSION), authenticate=False)
status = api.get_auth_status()        # POST /validate, no SRP, no device alert
if not (status["authenticated"] and status["trusted_session"]):
    # 2. Only now ask for credentials; constructor authenticates immediately.
    api = PyiCloudService(email, password, cookie_directory=str(SESSION))
    if api.requires_2fa:
        # 2.5+: a code is auto-requested during sign-in. If nothing arrived:
        # api.request_2fa_code()
        code = input(f"Code ({api.two_factor_delivery_method}): ").strip()
        if not api.validate_2fa_code(code):
            raise SystemExit("2FA rejected")
        if not api.is_trusted_session and not api.trust_session():
            raise SystemExit("session not trusted — next run will ask again")
    elif api.requires_2sa:            # legacy accounts only
        ...                           # see references/auth-and-session.md
```

Four rules make it last:

1. **Pass `cookie_directory`** on durable storage. The default is
   `/tmp/pyicloud/<user>` and is lost on reboot/tmp cleanup.
2. **Keep both files**: `<apple_id>.session` (session/trust tokens) and
   `<apple_id>.cookiejar` (`X-APPLE-WEBAUTH-TOKEN`). One without the other
   fails reuse and drops into a full SRP login.
3. **Call `trust_session()`** after the code; `validate_2fa_code()` alone does
   not mark the browser trusted.
4. **Keep one exit IP.** Trust tokens are bound to the IP that earned them.
   A rotating proxy guarantees repeated 2FA; use a sticky session per account.

Realistic lifetime: Apple documents **~30 days** for a trusted browser; the trust
token is observed to expire at ~30 days and is rejected from another network.
"Two months unattended" therefore needs **two** trust events — plan a re-auth
around day 25–30, or treat 60 days as best-effort, never a guarantee.

## Top footguns

1. Default session dir is `/tmp` — the single most common cause of "2FA again".
2. `PyiCloudService(...)` logs in **in its constructor** unless
   `authenticate=False`; a stale session therefore triggers a real password
   login and a device notification on every probe.
3. `is_trusted_session` is the `hsaTrustedBrowser` **flag**, not "the session
   works". `requires_2fa` stays sticky until the challenge is completed.
4. `api.photos.all` is the `"Library"` smart album. `albums["All Photos"]`
   raises `KeyError`; use `api.photos.all`. `albums["Hidden"]` and
   `albums["Recently Deleted"]` are real and excluded from All Photos.
5. `PhotoAsset.download()` returns **bytes** (whole file in RAM). For videos
   stream `asset.versions["original"]["url"]` with `session.get(stream=True)`.
6. `DriveNode.open()` on a 0-byte file returns a synthetic `Response` with
   `status_code=None` and an empty body — guard `raise_for_status()`.
7. `api.files` (Ubiquity) often answers `Account migrated`; use `api.drive`.
8. CloudKit services (Photos/Notes/Reminders/Invites) use `(10, 60)` timeouts,
   but most REST services pass **no timeout**. Set your own read/connect bounds.
9. One `api.session` is not thread-safe (cookies, token persistence). Use one
   service per thread, or a lock around all session use.
10. On Advanced Data Protection accounts, first access to photos/notes/reminders
    can send a PCS consent notification to the owner's devices and block until
    consent — catch `PyiCloudPCSTimeoutException`.
11. Photos upload uses `photosupload`; the old `uploadimagews` returns **410**.
    `upload()` returning `None` means "stored, not yet indexed", not failure.
12. In 2026.10.1 session saves are not atomic (#476); a kill can truncate them.
    Back up both files before experiments, or run main.

## Exception contract

Catch `PyiCloudException`; every service error derives from it (since
2026.10.0). Map before retrying:

| Error | Meaning | Action |
|---|---|---|
| `PyiCloudFailedLoginException` | bad password/session token | re-auth interactively |
| `PyiCloud2FARequiredException` | challenge pending | `request_2fa_code()` / `validate_2fa_code()` |
| `PyiCloudAuthRequiredException` (450) | service-level reauth (Find My) | reconstruct/re-auth |
| `PyiCloudAPIResponseException` 421 | session token expired | full login |
| `PyiCloudAccountLockedException` (-20209) | locked | stop, do not retry |
| `PyiCloudServiceNotActivatedException` | webservice key missing/empty | feature unavailable |
| `PyiCloudEndpointGoneException` (410) | endpoint withdrawn | use replacement (photosupload) |
| `PyiCloudPCSTimeoutException` | ADP consent not granted | retry later / skip |
| `NotesRateLimited` (429) | rate limit | honour `retry_after` |
| `CloudKitApiError` (`ZONE_NOT_FOUND`) | service not enabled on account | treat as empty |
| `PhotosRateLimited` / `CloudKitZoneNotFoundError` / `MailWriteUncertain` | **main-only** errors | upgrade or map from the 2026.10.1 equivalents |

## Version upgrades

Apple changes hosts without notice. Run `icloud doctor` (read-only) and
`icloud doctor --probe` (one request per service) before blaming your code.
Check the CHANGELOG because CalVer is **not** SemVer: a date bump can break an
interface.
