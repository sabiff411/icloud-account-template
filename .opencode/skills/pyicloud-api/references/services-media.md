# Media services — Photos and Notes

Both are CloudKit-backed and call `_request_pcs_for_service()` first; on an
Advanced Data Protection account that can notify the owner's devices (see
`auth-and-session.md` §10).

**Version note.** On PyPI **2026.10.1** Photos raises
`PhotosServiceException` plus the generic `CloudKitAuthError` /
`CloudKitRateLimited` / `CloudKitApiError`; the `PhotosAuthError` /
`PhotosRateLimited` / `PhotosApiError` / `PhotosZoneNotFoundError` hierarchy
and the `*ZoneNotFoundError` classes for Notes/Reminders/Invites are **main
only** (2026.10.2.dev). On 2026.10.1 a missing zone is a `CloudKitApiError`
whose message contains `ZONE_NOT_FOUND`, and Notes exposes `NotesError` →
`NotesAuthError` / `NotesRateLimited` / `NotesApiError`.

# Photos — `api.photos`

## Object model

```
api.photos
├─ libraries          {"root": PhotoLibrary, "shared:<zone>": PhotoLibrary, "shared": legacy}
├─ private_client     PhotosCloudKitClient (advanced)
├─ all                PhotoAlbum   == the "Library" smart album
├─ albums             AlbumContainer (smart albums + user albums)
├─ shared_streams     legacy Shared Albums adapter
├─ create_album(name, album_type=AlbumTypeEnum.ALBUM)
├─ upload(path, *, album=None)
├─ sync_cursor() / iter_changes(since=None)
└─ sync(PhotoSyncOptions) / watch(options, interval_seconds, iterations=None)
```

`AlbumContainer`: iterable, `len()`, `albums[name]`, `albums.find(name)`,
`albums.get(key, default)`, `albums.index(i)`. `find` matches `name` or
`fullname`, so both `"Hidden"` and the literal `"Library"` work.

Album names (`SmartAlbumEnum`): `Library`, `Favorites`, `Hidden`,
`Recently Deleted`, `Videos`, `Live`, `Screenshots`, `Slo-mo`, `Time-lapse`,
`Bursts`, `Panoramas`. **`api.photos.all` is `albums["Library"]`.**
`albums["All Photos"]` raises `KeyError`.

`PhotoAlbum`: `id`, `fullname`, `name`, iterable of `PhotoAsset`, `len()`,
`album[i]`, `rename(value)`, `delete()`, `add_photo(asset)`, `upload(path)`.
`fullname_guard(seen=set())` is the cycle guard used when albums nest; ignore
unless you build album paths yourself.

`PhotoLibrary`: `all`, `recently_added()` (virtual album over the added-date
index), `create_album(...)`, `upload_file(path)` (library-level upload),
`albums`, `sync_cursor()`, `iter_changes()`. `AlbumContainer.append(album)`
and `.remove(id)` are cache mutations for advanced callers.

`PhotoAsset`:

| Member | Meaning |
|---|---|
| `id` | asset record name (stable; use for dedupe) |
| `master_id`, `asset_id` | underlying CloudKit record names |
| `filename`, `size`, `dimensions`, `item_type` (`image`/`movie`), `is_live_photo` | metadata |
| `created`, `asset_date`, `added_date` | aware UTC datetimes |
| `resources` | `dict[str, PhotoResource]` |
| `versions` | same as plain dicts: `{"original": {"url", "filename", "size", ...}}` |
| `master_record`, `asset_record` | raw `CKRecord` objects (advanced/debug) |
| `download_url(version="original")` | signed URL or `None` |
| `download(version="original", **kwargs)` | **bytes** (whole file), `None` if missing |
| `favorite()` / `unfavorite()` / `set_favorite(bool)` / `delete()` | bool success |

Version keys:

* image: `original`, `alternative`, `medium`, `thumb`, `original_video`,
  `medium_video`, `thumb_video`, `sidecar`
* movie: `original`, `medium`, `thumb`, `thumb_image`, `medium_image`

Live photos are one `PhotoAsset` with both image and video resources; download
`original` for the still and `original_video` for the motion part (or let the
sync engine do it).

## Hidden, Recently Deleted, and what "all" excludes

`Library` uses the index `CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted`,
so it contains **neither** hidden nor deleted assets. They are separate smart
albums with their own indexes:

```python
hidden  = api.photos.albums["Hidden"]
deleted = api.photos.albums["Recently Deleted"]

for album in (hidden, deleted):
    for asset in album:
        url = asset.download_url("original")   # stream this
        # or: data = asset.download("original")
```

Dedupe by `asset.id`: a hidden asset can also belong to a user album, and
deleted assets can appear in both Recently Deleted and an album. Recently
Deleted is readable only while Apple retains the asset (typically 30 days).

## Download strategy

```python
import requests

def stream_asset(api, asset, dest):
    info = asset.versions.get("original")
    if not info or not info.get("url"):
        raise RuntimeError("no original")
    with api.session.get(info["url"], stream=True, timeout=(20, 120)) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".part")
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                if chunk:
                    f.write(chunk)
        tmp.replace(dest)
```

Use `asset.download()` only for thumbnails/small images; it materialises the
whole object in memory. Signed URLs need no cookies but expire — fetch, then
download promptly. `original` is the only version worth archival storage;
`alternative` is Apple's edited/alternate rendering, not a backup.

## Upload

```python
api.photos.upload(path)                    # root library
api.photos.upload(path, album="Screenshots")
api.photos.albums["Screenshots"].upload(path)
```

* Accepted media is narrow: `.jpg`/`.jpeg` (`image/jpeg`); other types get
  HTTP 415 → `PhotosApiError` on main, `CloudKitApiError` on 2026.10.1.
* Uses `photosupload` (`createUploadUrl` → `putAsset` → `uploadStatus`); the
  old `uploadimagews` is 410 Gone.
* Duplicate upload returns the **existing** asset.
* iCloud indexes asynchronously. `upload()` polls for 14–20 s and returns
  `None` if indexing exceeds `upload_hydration_timeout` (default 60 s,
  interval 2 s). `None` means **uploaded, not yet readable** — not failure.
* Uploading to a user album also adds it to Library automatically.

## Built-in sync engine (usually better than a hand-written downloader)

```python
from pathlib import Path
from pyicloud.services.photos import PhotoSyncOptions

opts = PhotoSyncOptions(
    directory=Path("./photos"),
    state_dir=None,                 # default <directory>/.pyicloud-state
    library="root",                 # or "shared:<zoneName>"
    albums=(),                      # e.g. ("Favorites", "Hidden")
    size="original",                # original|medium|thumb
    live_photo_size="original",     # original|medium|thumb
    folder_structure="{:%Y/%m}",    # "none" = flat
    recent=None,                    # only assets added in the last N days
    until_found=None,               # stop after N consecutive known files
    skip_videos=False,
    skip_live_photos=False,
    align_raw="as-is",              # as-is|original|alternative
    xmp_sidecar=False,
    set_exif_datetime=False,
    keep_icloud_recent_days=None,   # only with auto_delete: keep newer assets in iCloud
    only_print_filenames=False,
    dry_run=False,
    auto_delete=False,              # deletes server assets after saving
)
result = api.photos.sync(opts)      # PhotoSyncResult
for run in api.photos.watch(opts, interval_seconds=300, iterations=None):
    print(run)
```

It keeps a SQLite state file per target (`<state_dir>/<key>.sqlite3`), skips
known resources, and supports `--recent/--until-found/--album/--folder-
structure/--size/--live-photo-size/--skip-videos/--skip-live-photos/
--align-raw/--xmp-sidecar/--set-exif-datetime/--keep-icloud-recent-days/
--only-print-filenames/--dry-run/--auto-delete` in the CLI. Use it unless you
need a custom manifest (see `downloaders.md`).

## Shared libraries and shared albums

* Private: `root`.
* Shared Library (CloudKit): `shared:<zoneName>` from `api.photos.libraries`.
  Read + `sync`/`watch` supported; album filters limited to `Library` and
  `Favorites`.
* Legacy Shared Albums: `shared` / `api.photos.shared_streams` — REST adapter,
  not a CloudKit browse/sync target. Its pagination is separate.
  - `api.photos.shared_streams` is an `AlbumContainer` of
    `SharedPhotoStreamAlbum`; each exposes `sharing_type`,
    `allow_contributions`, `is_public`, `is_web_upload_supported`,
    `public_url`, plus iterable `PhotoStreamAsset`s, `rename()`, `delete()`.
  - `PhotoStreamAsset` extends `PhotoAsset` with `like_count` and `liked`;
    `download()` works the same. Shared-album writes are limited to
    rename/delete/like and the legacy REST semantics.
* Writes to shared libraries are limited; favorite/unfavorite is supported,
  album creation is not.

## Change feed

`api.photos.sync_cursor()` returns an opaque token; `iter_changes(since=token)`
yields `PhotoChangeEvent(kind="updated"|"deleted", record_name, record_type,
deleted, modified)`. Persist the cursor for incremental runs. The feed is not
a complete backup: it reports records, not file bytes.

# Notes — `api.notes`

## Read surface

| Method | Params | Use when / avoid |
|---|---|---|
| `recents(limit=50)` | newest first | dashboard/recent scan; not complete |
| `recents_in_folder(folder_id, limit=20)` | one folder | folder preview |
| `iter_all(since=None)` | full feed, or incremental | full export; pass a saved cursor for deltas |
| `folders()` | — | list `NoteFolder` including nested parents |
| `in_folder(folder_id, limit=None)` | non-deleted only | export one folder |
| `get(note_id, with_attachments=False)` | full note + text | `with_attachments=True` adds metadata, not bytes |
| `sync_cursor()` | — | capture before iterating |
| `iter_changes(since=None)` | `ChangeEvent(type, note)` | incremental index |
| `render_note(note_id, **ExportConfig)` | HTML fragment string | preview only; downloads nothing |
| `export_note(note_id, output_dir, **ExportConfig)` | path | archival HTML export |
| `download_attachment_to(att, directory)` | path | save one attachment |
| `stream_attachment(att, chunk_size=65536)` | iterator bytes | large attachments |
| `raw` | CloudKit client | advanced/debug only |

Models: `NoteSummary(id, title, snippet, modified_at, folder_id, folder_name,
is_deleted, is_locked)`; `Note` adds `text`, `html`, `attachments`,
`has_attachments`; `Attachment(id, filename, uti, size, download_url,
preview_url, thumbnail_url)` with `save_to(dir, service=api.notes)` and
`stream(service=api.notes, chunk_size=…)`; `NoteFolder(id, name,
has_subfolders, count, parent_id)`.

## ExportConfig — choose deliberately

| Field | Default | Use |
|---|---|---|
| `export_mode` | `"archival"` | downloads assets and rewrites HTML to local files; `"lightweight"` keeps remote/preview URLs |
| `assets_dir` | `None` | where archival assets land; otherwise next to output |
| `full_page` | `None` | `True` wraps in `<html>`; fragment otherwise |
| `preview_appearance` | `"light"` | `"dark"` when the note was authored dark |
| `pdf_object_height` | `600` | embedded PDF display height |
| `prefer_media_for_images` | `True` | best-quality image attachments; keep on |
| `image_uti_prefixes` / `image_uti_exacts` | `public.image` / common | extend for unusual UTIs |
| `link_target_blank`, `link_rel`, `referrer_policy` | on/noopener/no-referrer | link hardening |
| `debug` | `False` | pipeline tracing |

`export_note` writes `<safe-title>.html` plus an assets folder in archival
mode; `render_note` never writes files.

## Caveats

* `get()` / `render_note()` / `export_note()` raise `NoteNotFound` for a bad
  ID, and `NoteLockedError` for a passphrase-locked note. There is no way to
  read locked content without the passphrase — fall back to metadata only.
* `iter_all()` includes deleted summaries; filter `not summary.is_deleted`.
* `note.text` can be `None` (empty/locked/undecodable); `note.html` may also
  be `None`. Write the metadata header regardless.
* Notes bodies are protobuf/CRDT; do not parse `text` back into structure.
* Nested folders are discovered from the zone change feed; `parent_id` may be
  `None` for roots.
* Attachments may be sketches (`com.apple.paper`), scans, or arbitrary files;
  `Attachment.uti` is the only reliable type signal.
* The Notes service requests PCS with app name `notes3`; `notes` is rejected
  by Apple.

## CloudKit "no auth method found" workaround

Some accounts answer Notes `/records/*` with **401 no auth method found** until
the CloudKit database subscriptions exist. The downloader in this workspace
creates them defensively:

```python
def ck_subscribe(api, container="com.apple.notes"):
    host = api.get_webservice_url("ckdatabasews").rstrip("/")
    params = dict(api.params)
    params.update({"ckjsBuildVersion": "2310ProjectDev27",
                   "ckjsVersion": "2.6.4"})
    for scope in ("private", "shared"):
        body = {"operations": [{
            "operationType": "create",
            "subscription": {
                "subscriptionID": f"DatabaseSubscription-{scope.capitalize()}",
                "subscriptionType": "database",
                "notificationInfo": {
                    "additionalFields": [], "alertLocalizationArgs": [],
                    "shouldBadge": False, "shouldSendContentAvailable": True,
                },
            },
        }]}
        api.session.post(
            f"{host}/database/1/{container}/production/{scope}/subscriptions/modify",
            params=params, data=json.dumps(body).encode(),
            headers={"Content-Type": "text/plain;charset=UTF-8"},
            timeout=(20, 60),
        )
```

This mirrors icloud.com's own request (`ckjs` query params, text/plain body).
Keep it for accounts that fail; it is harmless otherwise.
