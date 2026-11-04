# Core services — Account, Find My, Calendar, Contacts, Drive, Hide My Email, Ubiquity

All services are created lazily by `PyiCloudService`; a missing webservice key
raises `PyiCloudServiceNotActivatedException` or `PyiCloudServiceUnavailable`
at property access, not at construction. Signatures are 2026.10.1; main-only
additions are marked.

## The service object itself

| Member | Returns | Use |
|---|---|---|
| `account_name` | Apple ID string | logging, keying |
| `is_china_mainland` | bool | endpoint check |
| `session` | `PyiCloudSession` (`requests.Session`) | raw requests, signed URLs |
| `webservices` | dict or None | Apple's advertised map (permission gate) |
| `get_webservice_url(key)` | HTTPS base URL | validate a key before using it |
| `params` | dict | `clientId`, `dsid`, locale; copy before mutating |
| `data` | dict | last login/validate payload (`dsInfo`, `webservices`) |
| `get_auth_status()` | dict | cheap auth/trust probe (see auth ref) |
| `logout(...)` | dict | remote + local sign-out |

Never hard-code a host: use `get_webservice_url` or the service property.

## Account — `api.account`

| Member | Returns | Notes |
|---|---|---|
| `devices` | `list[AccountDevice]` | paired devices Apple lists, not Find My devices |
| `family` | `list[FamilyMember]` | `first_name`, `last_name`, `full_name`, `apple_id`, `dsid`, `family_id`, `apple_id_for_purchases`, `dsid_for_purchases`, `original_invitation_email`, `age_classification`, `has_parental_privileges`, `has_screen_time_enabled`, `has_ask_to_buy_enabled`, `has_share_purchases_enabled`, `has_share_my_location_enabled`, `share_my_location_enabled_family_members`, `get_photo()` |
| `storage` | `AccountStorage` | `used_storage_in_bytes`, `total_storage_in_bytes`, `available_storage_in_bytes`, `used_storage_in_percent`, `quota_almost_full`, `quota_over`, `quota_paid`, `quota_tier_max`, `commerce_storage_in_bytes`, `comp_storage_in_bytes`, `usages_by_media` |
| `summary_plan` | dict | `featureKey`, `summary.limit`, `limitUnits`, Apple One/shared/comped variants |

`usages_by_media` values expose `key`, `label`, `usage_in_bytes`, `color` —
the documented pie-chart source.

Use `api.account` for quota/plan and family metadata. Avoid calling it in a
hot loop: each property is a fresh REST request.

## Find My — `api.devices` / `api.iphone`

```python
api.devices                     # manager; len(), [index], [device_id]
api.iphone                      # devices[0] — may not be an iPhone
api.devices.refresh(locate=True)  # re-fetch; locate sends shouldLocate
api.devices.is_alive            # monitor thread state
api.devices.user_info            # account/user metadata returned by Find My
```

`FindMyiPhoneServiceManager(refresh_interval=300.0, locate=False,
with_family=False, family_poll_delay=0.5, family_poll_max_retries=5)` starts a
background monitor only when `refresh_interval` is a positive number.

| `AppleDevice` member | Params | Use when / avoid |
|---|---|---|
| `location` | — | property; last fix (None if unavailable). Does not request a new fix |
| `status(additional=None)` | list of extra keys | compact status; pass `additional` for raw fields |
| `play_sound(subject="Find My iPhone Alert")` | subject | audible ping |
| `display_message(subject=..., message=..., sounds=False, vibrate=False, strobe=False)` | flags | screen message; flags are device-capability dependent |
| `lost_device(number, text=..., newpasscode="")` | phone/message/passcode | **locks** device; owner-visible |
| `erase_device(text=..., newpasscode="")` | message/passcode | irreversible wipe on next network; owner-visible |
| `name`, `model`, `model_name`, `device_type`, `data` | — | identity |
| `lost_mode_available`, `erase_available`, `sound_available`, `messaging_available`, `location_available` | — | gate UI |

`locate=True` at construction and `refresh(locate=True)` cost device battery and
can be visible to the owner. `pause_2fa=True` is enough for Find My only.

## Calendar — `api.calendar`

```python
get_calendars(as_objs=False)                     # list[dict] or list[CalendarObject]
add_calendar(calendar: CalendarObject)           # dict response
remove_calendar(cal_guid: str)                   # dict response
get_ctag(guid: str)                              # str
get_events(from_dt=None, to_dt=None, period="month", as_objs=False)
get_event_detail(pguid, guid, as_obj=False)
add_event(event: EventObject)                    # dict response
remove_event(event: EventObject)                 # dict response
refresh_client(from_dt=None, to_dt=None)         # raw payload
```

`period` is only `"day"`, `"week"`, `"month"`. For `day`/`week` the library
**overrides `to_dt`** (`from_dt + 1d` / `+ 6d`); do not pass a custom range
with those periods. If exactly one bound is supplied to `refresh_client`, the
other is expanded to the full month. Date strings use the account's local zone
(`usertz`), not UTC.

`EventObject(pguid, title="New Event", start_date=<now>, end_date=<now+1h>,
local_start_date=None, local_end_date=None, icon=0, change_recurring=None,
tz="", guid="", location="", extended_details_are_included=True,
recurrence_exception=False, recurrence_master=False, has_attachments=False,
all_day=False, is_junk=False, etag=None)`

* `pguid` is the only required field; it is the calendar GUID.
* `add_invitees(["a@x", "b@y"])` — guests get email on `add_event`.
* `add_alarm_at_time()`, `add_alarm_before(minutes=0, hours=0, days=0,
  weeks=0)` — return the alarm GUID.
* `to_apple_event()` / `request_data` are conversion internals; use them only
  for debugging. `dt_to_list(dt, start=True)` converts one datetime to Apple's
  list wire format.
* `CalendarService.default_params` is the merged query dict; `obj_from_dict`
  validates a raw event/call into a typed object (advanced).
* `as_objs=True` requires every event to carry `pGuid`; otherwise `ValueError`.
* Recurring events: `recurrence_master` / `recurrence_exception` are flags;
  this service does not create recurrence rules.

`CalendarObject(title="Untitled", guid="", share_type=None,
symbolic_color="__custom__", supported_type="Event", object_type="personal",
color="", order=7, ...)`. Leave `guid` empty for a new calendar (uuid4 is
generated), set it to address an existing one. `color` is `#RRGGBB`;
`gen_random_color()` exists.

## Contacts — `api.contacts`

| Member | Returns | Notes |
|---|---|---|
| `all` | `list[dict]` (or None) | full address book; fields include `firstName`, `lastName`, `phones` (`[{"field","label"}]`), emails, `photo` |
| `me` | `MeCard` | `first_name`, `last_name`, `photo`, `raw_data`; `str(me)` = full name |
| `refresh_client()` | None | force a re-read (each `.all` already refreshes) |

Only iCloud-stored contacts are returned — no federated Facebook/LinkedIn
records. `includePhotos=True` and `includePhoneNumbers=True` are baked into the
request.

## iCloud Drive — `api.drive`

`DriveNode` (also returned for `app_library`) wraps `data`:

| Member | Params | Notes |
|---|---|---|
| `name`, `type`, `size`, `date_modified`, `date_changed`, `date_last_open`, `owner_record_name` | — | dates are UTC datetimes; `type` is `file`, `folder`, `app_library` |
| `get_children(force=False)` | force bypass cache | list[DriveNode]; one REST call |
| `get(name)` / `node["name"]` | case-sensitive name | KeyError if absent |
| `dir()` | — | child names only |
| `open(**kwargs)` | forwarded to `requests` | returns a streaming `Response`; pass `stream=True, timeout=(20,120)` for big files |
| `upload(file_object, **kwargs)` | binary file object | positions preserved; both drivews+docws used |
| `mkdir(folder)` | name | returns API payload |
| `rename(new_name)` | name | returns API payload |
| `move_to_trash()` / `delete()` | — | same effect: move to Recently Deleted |
| `recover()` | — | restore from trash |
| `delete_forever()` | — | permanent; only valid in trash |
| `remove(child)` | DriveNode | remove from this node's cache, not server |

Service-level: `root`, `trash`, `refresh_root()`, `refresh_trash()`,
`get_node_data(drivewsid, share_id=None)`, `get_file(file_id, zone=
"com.apple.CloudDocs", *, owner_record_name=None, **kwargs)`,
`get_app_data()`, `create_folders(parent, name)`, `delete_items`,
`rename_items`, `move_items_to_trash`, `recover_items_from_trash`,
`delete_forever_from_trash`, `move_nodes_to_node`, `send_file`.

Rules:

* **Always stream**: `with node.open(stream=True) as r: copyfileobj(r.raw, f)`.
* **0-byte files** return a synthetic `Response` (`status_code=None`,
  `raw=BytesIO()`); guard `raise_for_status()`.
* Shared items need `owner_record_name` (populated on the node from
  `ownerRecordName`); without it, the owner's zone returns 404 (#396).
* Traverse iteratively (`pending = [(root, Path(...))]`), not recursively —
  deep trees exceed Python's recursion limit.
* `api.drive.trash` is a node named "Recently Deleted"; refresh after
  mutations (`api.drive.refresh_trash()`).
* `api.files` (Ubiquity) is the legacy surface. `Account migrated` means
  Apple moved the account to Drive: use `api.drive` and stop retrying.

## Hide My Email — `api.hidemyemail`

| Member | Params | Notes |
|---|---|---|
| iteration | — | yields alias dicts (`hme`, `label`, `anonymousId`, `isActive`, ...) |
| `[anonymous_id]` | id | one alias dict |
| `generate()` | — | returns an email string or `None` (quota/exhausted) |
| `reserve(email, label, note="Generated")` | — | must reserve a generated address to activate it |
| `update_metadata(anonymous_id, label, note=None)` | — | label/note only |
| `deactivate(id)` / `reactivate(id)` | — | stops/resumes forwarding, keeps alias |
| `delete(id)` | — | removes alias |

`generate()` alone creates an unassigned address; call `reserve()` and keep the
returned `anonymousId`. An alias's `hme` is the public address.

## Ubiquity — `api.files` (legacy)

`api.files.dir()`, `api.files["name"]`, nested indexing, `.open()` returning a
`requests.Response`, `.name/.size/.modified/.type`. Same shape as Drive but
backed by the old `ubiquity` service. Lower-level: `get_node_url(node_id)`,
`get_node(node_id)`, `get_children(node_id)`, `get_file(node_id, **kwargs)`.
Many accounts answer `Account migrated`; treat that as "use `api.drive`", not
as a bug.

## Construction and webservice keys

`get_webservice_url(key)` validates HTTPS and a non-empty URL. Inventory
(`pyicloud/endpoints.py`):

`account`, `calendar`, `ckdatabasews` (photos/reminders/notes/invites),
`contacts`, `docws`+`drivews` (drive), `findme` (devices),
`photosupload` (photos), `premiummailsettings` (hidemyemail),
`sharedstreams` (shared albums), `ubiquity` (files), `uploadimagews`
(dead, 410), `mcc`+`mccgateway` (mail, optional).

`icloud doctor` prints this map with status and host; `--probe` performs one
read-only request per service.
