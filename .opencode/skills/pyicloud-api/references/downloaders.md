# The two local downloaders — what they do, and how to extend them

Both scripts target the same goal: authenticate once, keep the session, then
pull Photos + Notes + Drive. They differ in robustness.

| | Script 1 (`icloud-download`) | Script 2 (manifest downloader) |
|---|---|---|
| Auth | `cookie_directory=OUTPUT/.session`, constructor login | `authenticate=False`, wraps timeouts, then `authenticate()` |
| Resume | none — existing files are kept, renamed on collision | SQLite manifest + SHA-256 + size verification |
| Retries | none | 3 attempts, exponential backoff (`2/4/8 s`) |
| Concurrency | serial | `ThreadPoolExecutor` (default 4, max 16) |
| Photos | Hidden + `api.photos.all` | Hidden + `api.photos.all` |
| Notes | text + HTML export + attachments | none |
| Drive | iterative walk, streaming download | iterative walk, streaming download |
| Extra | BIP39 seed harvest + OCR | JSONL log + `summary.json` |

Both are correct about the two non-obvious points: `api.photos.all` (not
`albums["All Photos"]`) and streaming `versions["original"]["url"]` instead of
`asset.download()`.

## Mapping: script call → API contract

| Script line | API | Contract |
|---|---|---|
| `PyiCloudService(email, password, cookie_directory=…)` | constructor | tries cached `/validate`, then token `accountLogin`, then SRP; may leave `requires_2fa` true |
| `api.validate_2fa_code(code)` | HSA2 | returns bool; **does not trust** |
| `api.trust_session()` | trust | required after 2FA to avoid the next prompt |
| `api.photos.albums.find("Hidden")` | `AlbumContainer.find` | returns `None` if unavailable |
| `api.photos.all` | `albums["Library"]` | excludes Hidden/Recently Deleted |
| `asset.versions["original"]["url"]` | `PhotoAsset.versions` | signed URL; may be absent for a broken asset |
| `api.session.get(url, stream=True)` | requests | no cookies needed for the signed URL, but reuses the session |
| `api.notes.iter_all()` | Notes change feed | includes deleted summaries |
| `summary.is_deleted` | `NoteSummary` | filter it out |
| `api.notes.get(id)` | Notes | `NoteLockedError` / `NoteNotFound` |
| `api.notes.export_note(id, dir)` | export | default `archival`: downloads assets |
| `folder.get_children()` | Drive | one REST call per folder |
| `child.open(stream=True)` | Drive | `Response`; synthetic empty response for 0-byte files |
| `api.drive.root` | Drive | never use `api.files`; it may say `Account migrated` |

## Gaps to close before using either as "all services"

1. **Recently Deleted is missing.** Add:

   ```python
   api.photos.albums["Recently Deleted"]
   ```

   It uses `CPLAssetAndMasterDeletedByExpungedDate`; assets expire after
   Apple's retention window.

2. **Hidden is fetched but no other smart albums.** Favorites, Videos, Live,
   Screenshots, Slo-mo, Time-lapse, Bursts, Panoramas are all available via
   `api.photos.albums[name]` with no extra parameters. User albums come from
   `api.photos.albums` iteration (smart albums are mixed in).

3. **One transient error loses an asset (script 1).** A 429/500/connection
   reset is recorded as a permanent failure. Wrap per-asset fetches in 3 tries
   with backoff; CloudKit rate limits are normal under bulk reads.

4. **No integrity check (script 1).** A short stream can be renamed as a final
   file. Compare downloaded bytes with `versions["original"]["size"]` when
   present, then hash if you keep a manifest.

5. **Notes: metadata is lost when `get()` raises.** Write the `.txt` header
   before calling `get()`; for `NoteLockedError`, keep the header and note
   "locked" rather than recording the whole note as failed.

6. **Session lifetime is not checked.** Both scripts assume the constructor
   succeeded. Add the two-stage preflight from `auth-and-session.md` and a
   one-time retry that recreates `PyiCloudService` with the same directory
   (Apple occasionally rejects a cached session with 409; the stored session is
   still valid).

7. **Rotating proxy = repeated 2FA.** Both accept a proxy; trust tokens are
   IP-bound. Use a sticky session per account, not a per-request rotating
   endpoint. Set `HTTPS_PROXY`/`HTTP_PROXY` before constructing the service.

8. **Threads share `api.session` (script 2).** `requests.Session` mutates the
   cookie jar and pyicloud rewrites `.session`/`.cookiejar` on requests; the
   script only locks request setup. Safer: enumerate single-threaded, get
   signed URLs, then download with a **plain** `requests.Session` per worker
   (no cookies). Or one service per worker with its own copied cookie dir.

9. **Calendar, Contacts, Reminders, Account, Find My are not downloaded.**
   Add them with the methods in `services-core.md` / `services-collab.md`;
   calendars and contacts are one request each, reminders is CRDT-heavy.

## Minimal "all services" addition

```python
# Calendar — whole current month, objects for structured fields
for cal in api.calendar.get_calendars(as_objs=True):
    events = api.calendar.get_events(period="month", as_objs=True)
    dump_json(cal.title, events)

# Contacts
json.dump(api.contacts.all or [], open("contacts.json", "w"), ensure_ascii=False)
me = api.contacts.me
json.dump(me.raw_data, open("mecard.json", "w"), ensure_ascii=False)

# Notes — one folder per note, text + archival HTML
for summary in api.notes.iter_all():
    if summary.is_deleted:
        continue
    note = api.notes.get(summary.id, with_attachments=True)
    api.notes.export_note(summary.id, "Notes/html", export_mode="archival")

# Reminders — snapshot per list (read-only)
for lst in api.reminders.lists():
    # 2026.10.1 takes the list id; main also accepts the model.
    result = api.reminders.list_reminders(lst.id, include_completed=True)
    dump_json(lst.title, result)

# Account / Find My metadata
storage = api.account.storage
family = [m.full_name for m in api.account.family]
devices = [d.status() for d in api.devices]
```

Use `export_mode="lightweight"` for Notes when you only need readable HTML and
do not want to pull every attachment.

## When to use the built-in Photos sync instead

`api.photos.sync(PhotoSyncOptions(...))` already provides: album filters,
`--recent`, `--until-found`, size selection, live-photo video, RAW alignment,
XMP sidecars, EXIF dates, folder templates, SQLite state, dry-run and
auto-delete (see `services-media.md`). Use it unless you need the stable
`<short-id>_<filename>` naming or the seed/OCR pipeline. Do **not** run both
against the same directory: they keep separate state and will re-download.

## Memory and disk

* `asset.download()` = whole file in RAM; stream for videos and RAW.
* Script 2 writes to `*.part` and `os.fsync`s before rename; keep that.
* Script 1's temporary name is `name.<uuid>.part`; it never overwrites an
  existing final file (renames to `stem_<uuid>.suffix`). Keep that property.
* Path safety: `save_download`/`contained` must keep remote names inside the
  account directory. Both use `safe_name`; also reject `..` and absolute
  names before joining.

## Recommended run order

1. Preflight session; if not trusted, authenticate (interactive once).
2. Photos: Hidden → Recently Deleted → Library/albums (dedupe by `asset.id`).
3. Notes: metadata + bodies + archival HTML.
4. Drive: iterative walk.
5. Calendar/Contacts/Reminders metadata.
6. Close `api.session` and write a summary with per-area counts and failures.
