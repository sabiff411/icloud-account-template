# Authentication, session persistence and trust

Applies to 2026.10.1 and main unless marked. Source of truth:
`pyicloud/base.py`, `pyicloud/session.py`, `pyicloud/hsa2_bridge.py`,
`docs/guides/authentication.md`, `docs/guides/compatibility.md`.

## 1. Constructor parameters — when to use, when not

```python
PyiCloudService(
    apple_id, password=None, cookie_directory=None, verify=True,
    client_id=None, with_family=True, china_mainland=None, accept_terms=False,
    refresh_interval=300.0, family_poll_delay=0.5, family_poll_max_retries=5,
    locate=False, *, authenticate=True,
    cloudkit_validation_extra=None, pause_2fa=False,
    upload_hydration_timeout=60.0, upload_hydration_interval=2.0,
)
```

| Param | Use it when | Do **not** use it when |
|---|---|---|
| `password` | first login or keyring not configured | offline/status probe (omit it) |
| `cookie_directory` | **always**, for any run that should survive | throwaway probes |
| `verify=False` | a known TLS-intercepting proxy | production (hides MITM) |
| `client_id` | reproducing one browser identity | normally omit (uuid1 per process) |
| `with_family` | you want family devices in Find My | privacy/minimal calls |
| `china_mainland` | account region is China (or `ICLOUD_CHINA=1`) | otherwise |
| `accept_terms` | unattended runs after Apple updates terms | when a human can click |
| `refresh_interval` | long-running Find My monitor (seconds; `None` disables) | scripts that exit |
| `family_poll_delay` / `family_poll_max_retries` | slow family device loading | default is fine |
| `locate` | you need a fresh GPS fix at construction/monitor | battery-sensitive polling |
| `authenticate=False` | offline object, preflight, tests | you need services immediately |
| `cloudkit_validation_extra` | reverse-engineering CloudKit models (`allow` default, `ignore`, `forbid`) | normal use |
| `pause_2fa=True` | Find My-only, untrusted session is acceptable | anything needing full data |
| `upload_hydration_timeout` / `_interval` | slow Photos indexing | default (60 s / 2 s) |

`password=None` + `authenticate=True` reads the OS keyring
(`pyicloud.utils.get_password_from_keyring`). If absent, construction raises
`PyiCloudNoStoredPasswordAvailableException`.

## 2. What the constructor actually does

`authenticate()` runs this ladder, in order:

1. **Reuse cached session** — `POST {setup}/validate`.
   * Requires `session_token` in `.session` **and** an
     `X-APPLE-WEBAUTH-TOKEN` cookie. Missing either ⇒ skip.
   * 421 / API error ⇒ skip to fresh login.
   * Response has `hsaTrustedBrowser=false` and `pause_2fa=False` ⇒ skip.
2. **One-factor service login** (`service=` argument only) — for apps Apple
   flags `canLaunchWithOneFactor` (Find My). Sends credentials.
3. **Token exchange** — `POST {setup}/accountLogin` with
   `dsWebAuthToken` + `trustToken`. No password, no device alert.
4. **SRP sign-in** — only if the token exchange fails:
   `GET {idmsa}/appleauth/auth/authorize/signin` → `POST .../signin/init` →
   `POST .../signin/complete`. **This sends the password and produces the
   "Apple Account was used to sign in" alert.**
5. `signin/complete` answering 2FA-required ⇒ `_requires_mfa=True`,
   `_auth_data` loaded from the auth HTML/JSON, and `request_2fa_code()` is
   attempted automatically (2.5+). The constructor returns; it never prompts.

`_update_state()` copies `dsInfo.dsid` into `params` and stores the
`webservices` map. A later `accountLogin` refreshes both.

## 3. Session files (what "save the cookie" means)

With `cookie_directory=D`:

| File | Written by | Contains |
|---|---|---|
| `D/<apple_id>.session` | `PyiCloudSession._save_session_data` | JSON: `session_token`, `trust_token`, `client_id`, `account_country`, `dsid`-adjacent state; transient keys filtered out |
| `D/<apple_id>.cookiejar` | `PyiCloudCookieJar.save` | LWP cookie jar: `X-APPLE-WEBAUTH-TOKEN`, `-USER`, `-HSA-*`, PCS cookies for every `.icloud.com` host |

Facts that decide success:

* Both are required. Copying only `.session` or only `.cookiejar` breaks reuse.
* The directory is created `0700` under `umask(077)`; existing permissions are
  **not** corrected.
* Atomic replacement exists on **main** (#476/#487): per-file, owner-only, no
  `fsync`, not a transaction across the two files. 2026.10.1 writes directly —
  a crash can truncate the last good session. Back both files up.
* Use one owning **process** per directory. Concurrent writers, threads and
  shared directories are not supported.
* Default location with no `cookie_directory` is
  `<tempdir>/pyicloud/<getpass.getuser()>`, typically `/tmp/pyicloud/<user>`.
  Never rely on it for multi-day sessions.

Minimal, correct persistence code:

```python
import shutil
from pathlib import Path
from pyicloud import PyiCloudService

D = Path.home() / ".local/share/myapp/icloud/acct-1"
D.mkdir(parents=True, exist_ok=True)

def open_api(email, password=None):
    api = PyiCloudService(email, password, cookie_directory=str(D),
                          authenticate=False)
    state = api.get_auth_status()                  # no SRP, no alert
    if state["authenticated"] and state["trusted_session"]:
        return api
    api = PyiCloudService(email, password, cookie_directory=str(D))
    if api.requires_2fa:
        code = input("2FA code: ").strip()
        if not api.validate_2fa_code(code):
            raise RuntimeError("2FA rejected")
        if not api.is_trusted_session and not api.trust_session():
            raise RuntimeError("Apple did not trust this browser")
    elif api.requires_2sa:
        device = (api.trusted_devices or [])[0]
        api.send_verification_code(device)
        if not api.validate_verification_code(device, input("Code: ").strip()):
            raise RuntimeError("2SA rejected")
    return api

def backup(dst):
    for suffix in (".session", ".cookiejar"):
        for f in D.glob("*" + suffix):
            shutil.copy2(f, dst / f.name)
```

`get_auth_status()` is the cheapest check: it returns
`{"authenticated", "trusted_session", "requires_2fa", "requires_2sa"}` and does
not trigger SRP. It still performs one `/validate` request.

## 4. 2FA, 2SA, security keys

State flags:

| Property | Truth |
|---|---|
| `requires_2fa` | HSA2 challenge pending (hsaVersion 2, `_requires_mfa`, or auth data present) |
| `requires_2sa` | legacy two-step (hsaVersion >= 1) |
| `is_trusted_session` | `hsaTrustedBrowser` in the last validated payload |
| `two_factor_delivery_method` | `sms`, `trusted_device`, `security_key`, `unknown` |
| `two_factor_delivery_notice` | text Apple supplied for the active route |

HSA2 flow:

```python
api.request_2fa_code()                 # start/refresh delivery; may return False
api.two_factor_delivery_method         # tell the user where to look
code = input("code: ")
if not api.validate_2fa_code(code): ... # 412/409 "repair" accepted as valid
if not api.is_trusted_session:
    api.trust_session()                 # GET /2sv/trust, then accountLogin
```

* `request_2fa_code()` is already attempted automatically during SRP
  (2026.10.1). Call it again only when no code arrived, or to switch to SMS.
* `validate_2fa_code()` accepts a valid SMS code even when Apple answers 409
  (#389, in 2026.10.1). The 412 + repair-session variant is fixed only on main
  (#465); on 2026.10.1 a 412 can surface as a failure even for a correct code —
  retry once, then upgrade if it persists.
* `use_existing_trusted_device_code()` tells the library the next code is the
  one already displayed on a trusted device (no new push).
* Security key: `api.security_key_names`, `api.fido2_devices`,
  `api.confirm_security_key(device, event=threading.Event())`.
  `PyiCloudSecurityKeyTimeoutException` when cancelled.
* **2SA** (legacy): `trusted_devices`, `send_verification_code(device)`,
  `validate_verification_code(device, code)`. The validate call performs trust
  internally and returns `not requires_2sa`.
* After `trust_session()` returns `False`, expect another code next run.
  "Trust failed. You will likely be prompted again in the coming weeks."

`pause_2fa=True` (library) / `icloud devices --one-factor` (CLI):

* Skips the MFA challenge and uses an **untrusted** session; only Find My
  (`api.devices`, `api.iphone`) works.
* A paused session is reused only when the next call also passes
  `pause_2fa=True`; the default trusted flow deliberately rejects it.
* Apple issues no `X-APPLE-WEBAUTH-TOKEN`, so a CLI `--one-factor` session is
  discarded when the command exits and cannot be resumed.
* `icloud devices erase` deliberately refuses `--one-factor`.

## 5. How long does trust last?

Evidence, not folklore:

* Apple: a trusted browser is not asked for a code again for **30 days**
  (developer account docs); re-verify after browser reset/change.
* Reverse-engineered iCloud protocol (icps): trust tokens expire after
  **roughly 30 days**, are **bound to the IP they were acquired from**, and
  several can coexist; a new one does not invalidate older ones.
* Field reports: 30 days typical; some accounts/browsers last ~65 days; Apple
  may invalidate early after a password change, security event, device removal,
  terms update, or a network/IP change.
* Home Assistant observed Apple rejecting a cached session roughly every
  8 hours with 409/`Authentication required`; recreating the service and
  reusing the stored session recovered without a prompt.

Conclusion for "one OTP, then two months": **not guaranteed**. Budget one trust
per ~30 days. A 60-day run needs two codes unless Apple extends the token for
that account. Never build a flow that cannot ask for a code on day 31.

## 6. Why reuse fails early (in order of likelihood)

| Symptom | Cause | Fix |
|---|---|---|
| code asked every run | default `/tmp` session dir, or dir not writable | explicit durable `cookie_directory` |
| code asked every run | `.session` present, `.cookiejar` missing (or vice versa) | persist both |
| code asked after proxy change | trust token is IP-bound | sticky proxy session per account |
| `validate` 421 | session token expired | full login |
| `-20209` | account locked | stop, unlock in browser |
| 450 on Find My | service-level reauth | reconstruct service / re-auth |
| `PyiCloudAcceptTermsException` | new iCloud terms | `accept_terms=True` or web login |
| requestPCS 500 / `Missing X-APPLE-WEBAUTH-TOKEN` | `isRepairNeeded` / account action required | finish setup at icloud.com |
| works, then dies after 8 h | Apple dropped the cached session | recreate `PyiCloudService` reusing the directory, retry once |

A robust unattended loop:

1. `get_auth_status()`; if authenticated+trusted, proceed.
2. If not, reconstruct once with the same directory (Apple transiently rejects
   sessions), check again.
3. Only then declare "needs a human" and exit non-zero with a clear message.

## 7. Keeping it alive, and logging out

* There is **no** global keepalive. `refresh_interval` starts a Find My
  poller only, and only when > 0.
* A cheap periodic call (`get_auth_status()` or `api.account.storage`) may keep
  the session warm; it does **not** reliably extend trust past Apple's expiry.
* `logout(keep_trusted=False, all_sessions=False, clear_local_session=True)`
  returns `{payload, remote_logout_confirmed, local_session_cleared}`.
  `keep_trusted=True` asks Apple to preserve the browser trust.
* Deleting the directory without calling logout leaves a server-side session;
  harmless, but trust remains until expiry.

## 8. Proxies, IP and geolocation

* `requests` honours `HTTPS_PROXY` / `HTTP_PROXY` (and `NO_PROXY`). Set them
  **before** constructing the service; the constructor already makes requests.
* Trust tokens are IP-bound. A rotating proxy that changes exit IP between
  runs will look like a new browser: expect 2FA every time. Use a sticky
  session (same IP for the account's lifetime) or no proxy.
* Keep the proxy country consistent with the account's region. A sudden
  country change is a classic early-invalidation trigger.
* `verify=False` only for a TLS-intercepting proxy you control.

## 9. China mainland and terms

* `china_mainland=True` swaps in `.cn` hosts (`setup.icloud.com.cn`,
  `www.icloud.com.cn`); `ICLOUD_CHINA=1` does the same via env.
* Terms: on login Apple may return `termsUpdateNeeded`. Without
  `accept_terms=True`, `PyiCloudAcceptTermsException` is raised before
  services work. With it, the library calls `getTerms` + `repairDone`.

## 10. CloudKit PCS consent (ADP accounts)

`api.photos`, `api.notes`, `api.reminders`, `api.invites` call
`_request_pcs_for_service(name)`:

1. `POST /requestWebAccessState`.
2. Skip entirely unless `isICDRSDisabled` is true (i.e. Advanced Data
   Protection is on).
3. If the device is not consented, `POST /enableDeviceConsentForPCS` — this
   **notifies the account's devices**.
4. Poll `POST /requestPCS {appName, derivedFromUserAction}` until success or
   exhaustion ⇒ `PyiCloudPCSTimeoutException`.

Consequences: on an ADP account the first media read can be visible to the
owner and can block for the retry window. On non-ADP accounts this is a no-op.
For stealth, read raw CloudKit records instead of constructing the facade, or
accept the notification.
