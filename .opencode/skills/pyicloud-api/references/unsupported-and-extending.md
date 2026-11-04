# What pyicloud does not wrap, and how to add it in code

Use this when a capability is missing, when you need to edit/extend the library,
or when someone asks "can we also get X?". Everything here is **policy on top of
the same session**, not a fork of the protocol.

## 1. Capability matrix

| Capability | 2026.10.1 | main | If you need it |
|---|---|---|---|
| Photos read/download (private, Hidden, Recently Deleted, Shared Library) | yes | yes | `api.photos` |
| Photos upload (JPEG) | yes | yes | `api.photos.upload()` |
| Photos album create/rename/delete, add/remove photo, favorite, delete asset | yes | yes | `PhotoAlbum` / `PhotoAsset` |
| Legacy Shared Albums read (REST) | yes | yes | `api.photos.shared_streams` |
| Photos shared-album **create/upload** | no | no | raw `sharedstreams` REST (capture first) |
| Notes list/read/render/export/attachments | yes | yes | `api.notes` |
| Notes **create/edit/move/delete**, folder create | no | no | raw CloudKit + `NoteStoreProto` (below) |
| Calendar calendars/events read+create+delete, alarms, invitees | yes | yes | `api.calendar` |
| Calendar **recurrence rule creation** | no (flags only) | no | raw calendar payload |
| Contacts read + MeCard | yes | yes | `api.contacts` |
| Contacts **create/update/delete** | no | no | raw contacts `changeset`/`startup` |
| Reminders read + CRUD + alarms/hashtags/URL/recurrence/early/urgent | yes | yes | `api.reminders` |
| Reminders **file/image attachment upload** | no (URL only) | no | CloudKit asset upload + CRDT record |
| Invites read, RSVP, resolve/accept, cancel | yes | yes | `api.invites` |
| Invites create/publish/one-time-link invite | no | yes | `api.invites` on main |
| Invites **rename event** | no | no | raw CloudKit EventDetails modify |
| Mail read/folders/bodies/attachments/EML/JSON | no | yes (experimental) | `api.mail` on main |
| Mail write (flags/move/drafts/send/delete) | no | yes | `api.mail` on main |
| Mail Drop **upload**, content sync | no | no (metadata sync only) | raw Mail protocol |
| Find My list/locate/sound/message/lost/erase | yes | yes | `api.devices` |
| Account storage/family/devices/plan | yes | yes | `api.account` |
| Hide My Email list/generate/reserve/update/deactivate/delete | yes | yes | `api.hidemyemail` |
| **Voice Memos** | no | no | CloudKit probe or macOS DB (below) |
| **iCloud Keychain / Passwords decryption** | no | no | native GSA + Octagon; not a web-session feature |
| Pages/Numbers/Keynote **document semantics** | no | no | they are opaque files in Drive |
| Account device removal, family management writes | no | no | raw account endpoints |

## 2. Custom CloudKit access (the general tool)

`pyicloud.common.cloudkit.CloudKitContainerClient` is generic: give it a base
URL, the authenticated session and `api.params`.

```python
from pyicloud.common.cloudkit import (
    CKRecord, CKZoneChangesZoneReq, CKZoneIDReq,
)
from pyicloud.common.cloudkit.client import CloudKitContainerClient

def container(api, container_id, scope="private", env="production"):
    base = (api.get_webservice_url("ckdatabasews").rstrip("/")
            + f"/database/1/{container_id}/{env}/{scope}")
    return CloudKitContainerClient(base, api.session, api.params)

def dump_container(api, container_id):
    client = container(api, container_id)
    for zone in client.zones_list().zones:
        if zone.deleted:
            continue
        req = CKZoneChangesZoneReq(
            zoneID=CKZoneIDReq(**zone.zoneID.model_dump()),
            syncToken=None,          # None = all records in the zone
            reverse=False,
        )
        for change in client.iter_changes(zone_req=req):
            for rec in change.records:
                if isinstance(rec, CKRecord):
                    print(zone.zoneID.zoneName, rec.recordType,
                          rec.recordName, list(rec.fields))
```

Field access:

```python
from pyicloud.services.photos.mappers import record_field_value, record_name, record_record_type

value = record_field_value(rec, "SomeField")   # unwraps KnownCKField/value
```

* `query(...)` needs a `CKQueryObject(recordType=..., filterBy=[...])` and a
  `CKZoneIDReq` (or `zone_wide=True`).
* `lookup(record_names, zone_id=...)` for exact IDs.
* `modify(operations=[CKModifyOperation(...)], zone_id=..., atomic=True)` for
  writes; check every returned record/error, because CloudKit can answer 200
  with per-record failures.
* `download_asset_bytes(url)` / `download_asset_stream(url)` for `CKAsset`
  values (`{"downloadURL": ..., "size": ...}`).
* `upload_asset(...)` when a record needs a new asset.
* Rate limits: `CloudKitRateLimited` carries `retry_after`; back off.

Encrypted fields need PCS for that service (see `auth-and-session.md` §10).
Without the right `appName`, Apple returns the record with the field absent or
an error; `PYICLOUD_CK_EXTRA=allow|ignore|forbid` controls model strictness.

## 3. Custom REST access

```python
def call(api, ws_key, path, *, method="POST", body=None, params=None,
         headers=None, timeout=(10, 60)):
    root = api.get_webservice_url(ws_key).rstrip("/")
    query = dict(api.params)
    if params:
        query.update(params)
    return api.session.request(
        method, root + path, params=query, json=body,
        headers=headers, timeout=timeout,
    )
```

Rules:

* Copy `api.params`; never mutate the shared dict.
* Use `timeout=` — most pyicloud REST calls have none.
* CloudKit bodies use `Content-Type: text/plain;charset=UTF-8`; ordinary
  services use JSON.
* Parse Apple's error envelope before assuming success:
  `{"error": {"code": ..., "reason": ..., "description": ...}}` or
  `{success: false}`.
* 401/403 = auth/entitlement, 421 = session expired, 429 = back off, 450 =
  service reauth. Do not log full URLs (they carry `dsid`/tokens).

## 4. Voice Memos — the honest situation

Apple exposes **no Voice Memos web app on icloud.com**. The recordings live in
the private CloudKit container `com.apple.VoiceMemosContainer` (entitlements
name; the iCloud container identifier) and sync through `voicememod`. There is
no official API.

Remote route (experimental — may be refused by Apple's web session):

```python
dump_container(api, "com.apple.VoiceMemosContainer")
```

What to look for:

* zones beyond the default; record types such as the recording entity (names
  are not documented and can change);
* fields carrying title/date/duration and a `CKAsset` with `downloadURL`;
* assets: stream bytes and name them by `recordName` + extension; content is
  usually `.m4a`/`.qta`.

If `zones_list()` returns 401/`ZONE_NOT_FOUND`, the web session is not entitled
to that container: the only remaining routes are (a) a Mac signed into the
account reading
`~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/`
(`CloudRecordings.db` + `.m4a`/`.qta`, read-only) or (b) a manual export from
the device. Neither is an iCloud web API.

Write path: none verified. Treat Voice Memos as read-only.

## 5. Notes creation/editing (when you must write)

Read/export is supported; writing is not. The shape (capture the iCloud web
request to confirm before shipping):

1. Request PCS for `notes3` (the service uses that app name, not `notes`).
2. Build a `NoteStoreProto` from `pyicloud.services.notes.protobuf.notes_pb2`:

   ```python
   from pyicloud.services.notes.protobuf import notes_pb2 as pb
   store = pb.NoteStoreProto()
   store.document.version = 1
   store.document.note.note_text = "hello"
   # one AttributeRun per text run; length is in UTF-16 code units
   run = store.document.note.attribute_run.add()
   run.length = len("hello")
   payload = store.SerializeToString()
   ```

3. Create/modify a CloudKit `Note` record in the `Notes` zone with the fields
   Apple expects: encrypted title/snippet, folder reference, `NoteStoreData`
   asset (the protobuf), deletion flags, dates. Field names and encryption are
   the fragile part — diff against a live `lookup()` of an existing note.
4. Upload the protobuf as an asset (`upload_asset` token → PUT → status), then
   attach the asset token to the record.
5. Read back with `api.notes.get(id)`; if it renders, the write is sane.

Do not "replace" a note body with plain text via `records/modify` — Apple Notes
is CRDT/protobuf; devices may ignore or revert it.

## 6. Other custom paths

* **Photos shared album upload** — use the `sharedstreams` webservice
  (legacy REST), not `ckdatabasews`. Capture `POST /ws/.../createwebasset`
  (or the current web call) from icloud.com; pyicloud exposes read/rename/
  delete only.
* **Calendar recurrence** — raw `Event` payload fields (`recurrenceRule`,
  `recurrenceException`) are not modelled; build the payload from a captured
  request.
* **Contacts write** — `startup` → `changeset` protocol; keep `prefToken` and
  `syncToken`.
* **Mail Drop upload** — capability URL + resumable upload; unsupported even
  on main.
* **Keychain/Passwords** — requires a native GSA/Octagon device identity; a web
  session cannot join the keychain circle. Out of scope for pyicloud.
* **Pages/Numbers** — read the package bytes from Drive; editing requires the
  iWork format, not an iCloud API.

## 7. Extending without forking

**Wrap, don't patch.** Site-packages is erased by every reinstall.

```python
class MyPhotos:
    def __init__(self, api): self.api = api; self.photos = api.photos

    def download_all(self, album, dest):
        ...

# monkeypatch one method on an instance (restore afterwards)
original = api.session.request
def bounded(method, url, **kw):
    kw.setdefault("timeout", (10, 60))
    return original(method, url, **kw)
api.session.request = bounded
```

For a real fork: vendor the package (`vendor/pyicloud/`), prepend it to
`PYTHONPATH`, pin the commit, and keep upstream tests. A PR must preserve
public imports, positional defaults, exception catch relationships and CLI JSON;
add an `[Unreleased]` changelog entry and tests. `python scripts/check/tests.py`
is the maintained gate.

## 8. New-service checklist

1. Resolve the key with `api.get_webservice_url(key)`; handle missing keys as
   `PyiCloudServiceNotActivatedException`.
2. Construct lazily, cache on the service object, share `api.session` and
   `api.params`.
3. Use `timeout=(10, 60)`; wrap 401/403/429/450 into the service's errors.
4. Read with pagination/continuation; never assume one page is complete.
5. For writes: fresh read → identity check → write → verify; expose an
   "uncertain" outcome; never blind-retry.
6. Persist cursors (`sync_cursor`) instead of full scans when available.
7. Add an offline test with a fake session; do not require a live account.
8. Add the new surface to this skill and to `docs/`.
