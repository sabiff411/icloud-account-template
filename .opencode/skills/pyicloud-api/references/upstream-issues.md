# Upstream history, known issues and version deltas

Repo: `timlaing/pyicloud` (maintained fork of `picklepete/pyicloud`).
At 2026-11-04: latest PyPI **2026.10.1** (2026-10-15); `main` =
**2026.10.2.dev118**; 1 open issue (#495, MCP roadmap) and 85 closed issues.
Releases use CalVer after 2.7.0 — a version bump is **not** a SemVer promise.

Sources consulted: repo source + `docs/` + `CHANGELOG.md` at commit `3c899e5c`
(2026-11-03); all 85 closed issues and the open roadmap issue; release notes
2026.10.0–2026.10.1; Apple's authentication note (trusted browser = 30 days);
the reverse-engineered iCloud protocol at icps.steiler.dev (trust tokens ~30
days, IP-bound); Home Assistant core PR #188330 (Apple rejecting cached
sessions with 409 every few hours); and the upstream Fastlane/iCloudPD field
reports on token expiry.

Check before blaming your code:

```bash
pip show pyicloud
icloud doctor            # local install + stored session + webservice map
icloud doctor --probe    # one read-only request per service
gh issue list -R timlaing/pyicloud --state all --limit 30
gh release list -R timlaing/pyicloud
```

## What 2026.10.1 already fixed

| Area | Issue / PR | Fix in 2026.10.1 |
|---|---|---|
| Authentication | #229, #243–#245, #322–#323 | HSA2/SMS, trusted-device bridge, 409/412 repair handling |
| Authentication | #285, #248–#254 | China mainland endpoints |
| Authentication | #332 | refresh webservices after token exchange |
| Authentication | #356, #401 | reject non-HTTPS advertised URLs |
| Authentication | #365 | app-specific passwords still fail — use the real Apple ID password |
| Session | #199, #265–#269, #397 | persistence, pre-existing state, invalid credentials, Find My cookies |
| Session | #476/#487, #475/#488 | atomic saves / malformed-state recovery — **main only** |
| Logging | #88, #477 | token/signed-URL exposure; main redacts request URLs |
| Core | #334–#337, #347 | withdrawn-endpoint detection, webservice inventory, `doctor`, `--probe` |
| Photos | #98, #119, #208, #277, #395 | duplicate/infinite iteration, live-photo video, album handling, master dedupe |
| Photos | #316, #331 | `uploadimagews` 410 → `photosupload` flow |
| Photos | #472 | `services/photos` package replaces `photos_cloudkit`/`photos_legacy` on main |
| Drive | #74, #121, #139, #207, #220, #396, #474 | `/ws/` URL, account migration, shared folders, upload, owner downloads, upload-token isolation |
| Notes | #60, #318, #398, #400 | service, PCS for encrypted fields, nested folders, undecodable text guard |
| Reminders | #61, #218, #317, #319, #391 | v2 service, PCS, deleted flag, date alarms |
| Reminders | #419, #421, #422, #463 | zero-based recurrence, early/urgent alarms, CRDT text edits, due-date timezone, duplicate edits |
| Calendar | #205, #228, #236, #320, #399 | service, all-day events, timezone, date arrays, end-minute bug |
| Contacts / Account | #53 | family photo download |
| Find My | #201, #221, #325, #326, #347, #358, #360, #390 | service, auth refresh, paused 2FA, polling knobs, `locate`, CLI one-factor, stale-location monitor |
| Invites | #338–#354, #415 | shared-scope reads, zone changes, error hierarchy, modify errors |
| Notes/Reminders/Invites | #415 | all derive from `PyiCloudException` |
| CLI | #346, #358 | `icloud invites`, devices `--one-factor` |
| Packaging | #361, #369 | CLI optional; core imports without `rich` |

## Unreleased on main (2026.10.2.dev)

* **Mail** — full experimental read surface, folder/draft/flag/move writes,
  send, permanent delete, JSON/EML export, Mail Drop download, metadata sync.
* **Invites** — `create_event()`, `publish()`, `invite_via_link()`.
* **Reminders** — shared lists with zone routing; `list_context=`; safer CRDT.
* **Photos** — own error hierarchy (`PhotosAuthError`, `PhotosRateLimited`,
  `PhotosApiError`, `PhotosZoneNotFoundError`), shared-library reads even when
  the private library is unindexed, safer shared-stream pagination.
* **CloudKit** — `CloudKitZoneNotFoundError`; per-record modify errors surfaced.
* **Session** — atomic file replacement, malformed JSON recovery, symlink-safe
  staging, URL redaction in debug logs.
* **Packaging/CI** — Python 3.15 validation, installed-wheel checks,
  minimum-pin restore, per-file coverage gate.

If you need Mail or Invites creation today, install from git:

```bash
pip install "git+https://github.com/timlaing/pyicloud.git"
```

Pin a commit for reproducibility; `main` is unreleased and moving.

## Bugs / limits still true in 2026.10.1

1. **App-specific passwords do not authenticate the web/CloudKit surface**
   (#365, #26). Use the account's main password. 2FA still applies.
2. **Advanced Data Protection** (#84) needs PCS consent; first Photos/Notes/
   Reminders access can notify the owner's devices and block until consent.
3. **Session files are not atomic** in 2026.10.1 (#476). A killed process can
   truncate `.session`/`.cookiejar`.
4. **Debug logs can leak signed URLs** (#477) in 2026.10.1.
5. **No default timeout** on most REST calls; connection failures can hang.
6. **No automatic mutation retry / exactly-once guarantee** anywhere.
7. **Not thread-safe**: one session per process/directory.
8. **Photos shared libraries** support only `Library`/`Favorites` album
   filters; mixed "Both Libraries" semantics remain narrow.
9. **Legacy Shared Albums** (`shared`) are REST-only, not a CloudKit browse/
   sync target.
10. **Photos upload** is narrow (JPEG), asynchronous, and may return `None`
    while indexing; `uploadimagews` is gone.
11. **Ubiquity** (`api.files`) often reports `Account migrated`; Drive is the
    supported store.
12. **Reminders inline formatting/hashtags** in edited text are not preserved;
    Urgent checksum is a best-effort SHA-512, not Apple's unknown algorithm.
13. **Invites** creation/publish/invite-link are new and entitlement-gated;
    email/phone delivery and guest-account acceptance were unverified upstream.
14. **Mail** is experimental: one account verified; Mail Drop uploads and
    content sync are unsupported; writes can be `MailWriteUncertain`.
15. **`api.photos.albums["All Photos"]` raises KeyError** (the key is
    `"Library"`). Documented behaviour, not a bug to "fix" by guessing.
16. **`Delete` on a Photos asset** marks `isDeleted`; Recently Deleted is the
    only place to read it back until Apple expires it.

## Classic failure signatures

| Signature | Likely cause | Fix |
|---|---|---|
| `Missing X-APPLE-WEBAUTH-TOKEN cookie` | cookiejar missing/not loaded | keep both session files; durable dir |
| `Authentication required for Account. (450)` | Find My service reauth | reconstruct service; re-auth |
| `Authentication required ... (409)` | Apple dropped cached session | recreate `PyiCloudService`, reuse dir, retry once |
| 421 from `/validate` | session token expired | full login |
| `-20209` | account locked | stop |
| `Service Temporarily Unavailable (503)` at SRP | Apple transient | backoff, retry |
| `Account migrated` | Ubiquity legacy | use `api.drive` |
| `ZONE_NOT_FOUND` | service disabled for account | treat as empty |
| 429 `CloudKitRateLimited` | bulk reads | honour `retry_after`, backoff |
| `CloudKitApiError` / `PhotosApiError` 415 | unsupported upload type | JPEG only |
| `NoteLockedError` | passphrase-locked note | metadata only |
| `MailWriteUncertain` | write outcome unknown | inspect before retry |
| Repeated 2FA every run | `/tmp` session, missing file, rotating proxy, trust not requested | see `auth-and-session.md` |

## Contributing a fix

Public compatibility is frozen for root/service imports, positional parameter
order/defaults, exception catch relationships and CLI JSON fields. Private
modules, protobuf/wire internals and incidental imports are not contracts.
Add an `[Unreleased]` changelog entry; run `python scripts/check/tests.py`;
include checks for both the normal and installed-distribution paths. Do not
hand-edit generated protobuf, and do not add coverage exclusions to hide gaps.
