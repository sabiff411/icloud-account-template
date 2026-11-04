# Data models, fields and exceptions

Use this when you need the exact shape of a returned object, need to persist it,
or need to decide which exception to catch. Field lists are the public model
fields; Apple may add response fields, and pydantic models are configured to
tolerate that (`cloudkit_validation_extra` controls CloudKit only).

## Conventions

| Model family | Base | Mutability |
|---|---|---|
| Notes, Invites, Photos resources/changes | `FrozenServiceModel` | frozen; use `model_copy(update={...})` |
| Reminders (`Reminder`, `RemindersList`, related records) | `MutableServiceModel` | mutate in place, then `service.update()` |
| Mail | `MailModel` | frozen snapshots; writes return new update objects |

All models expose pydantic `model_dump()`, `model_dump_json()`,
`model_copy(update=...)`, `model_validate(data)`. A model is a **typed view**;
the raw JSON is still available from the API response if you need a field the
model does not expose (CloudKit `record.fields`, `api.data`, response payloads).

Dates:

| Source | Type / zone |
|---|---|
| Photos `asset_date`, `added_date`, `created` | aware UTC `datetime` |
| Drive `date_modified`, `date_changed`, `date_last_open` | aware UTC |
| Calendar `start_date` / `end_date` | **naive local** wall-clock; `tz` string alongside |
| Reminders `due_date` | aware if a zone is stored; naive treated as UTC on create |
| Invites `EventTime.start/end` | aware `datetime` |
| Notes `modified_at` | `datetime | None` |
| Mail `internal_date` | Unix seconds (float), not datetime |
| Invites/Reminders `created_timestamp` / `created` | aware UTC |

## Notes

```text
NoteSummary: id, title, snippet, modified_at, folder_id, folder_name,
             is_deleted, is_locked
Note:        NoteSummary + text, html, attachments, has_attachments (computed)
NoteFolder:  id, name, has_subfolders, count, parent_id
Attachment:  id, filename, uti, size, download_url, preview_url, thumbnail_url
             + save_to(directory, service=...) / stream(service=..., chunk_size=...)
ChangeEvent: type ("updated"|"deleted"), note (NoteSummary)
```

`attachments is None` means "not loaded", `[]` means "loaded, none"; use
`has_attachments` to distinguish. `html` is optional because not every note
renders (locked/undecodable).

## Reminders

```text
Reminder: id, list_id, title, desc, completed, completed_date, due_date,
          start_date, priority, flagged, all_day, deleted, time_zone,
          alarm_ids, hashtag_ids, attachment_ids, recurrence_rule_ids,
          parent_reminder_id, early_reminders, urgent, created, modified,
          record_change_tag, scope, zone_name, zone_owner,
          undecodable_text_fields, server_title, server_desc,
          early_reminder_account_id
RemindersList: id, title, color, count, badge_emblem, sorting_style,
               is_group, deleted, reminder_ids, guid, record_change_tag,
               scope, zone_name, zone_owner
Alarm:             id, alarm_uid, reminder_id, trigger_id, record_change_tag
LocationTrigger:   id, alarm_id, title, address, latitude, longitude,
                   radius, proximity, location_uid, record_change_tag
DateTrigger:       id, alarm_id, date_components, record_change_tag
DateComponents:    era, year, month, day, hour, minute, second, nanosecond,
                   weekday, weekday_ordinal, week_of_month, week_of_year,
                   year_for_week_of_year, quarter, leap_month, repeated_day,
                   time_zone (all optional)
Hashtag:           id, name, reminder_id, created, record_change_tag
URLAttachment:     id, reminder_id, url, uti, record_change_tag
RecurrenceRule:    id, reminder_id, frequency, interval, occurrence_count,
                   first_day_of_week, record_change_tag
EarlyReminder:     count (<=0), unit (HOURS=1|DAYS=2), identifier, creation_date
UrgentPresentationAlarms: enabled, person_id, modified_on,
                   minimum_supported_version, checksum
ReminderChangeEvent: type ("updated"|"deleted"), reminder_id, reminder|None
ListRemindersResult: reminders, alarms, triggers, attachments, hashtags,
                   recurrence_rules
Proximity: ARRIVING=1, LEAVING=2
RecurrenceFrequency: DAILY=0, WEEKLY=1, MONTHLY=2, YEARLY=3
```

`record_change_tag` is the optimistic-concurrency token for a CloudKit record;
keep it on objects you fetched and do not hand-edit it. `undecodable_text_fields`
means the server text could not be decoded; `update()` refuses those fields.
`server_title` / `server_desc` are the last-read values used to avoid reverting
a device edit.

## Invites

```text
Event: event_id, scope (PRIVATE|SHARED), record_change_tag, title, notes,
       host_display_name, is_published, is_private, is_cancelled,
       block_new_rsvps, max_attendees, max_additional_guests_per_rsvp,
       time (EventTime|None), place (EventPlace|None), background, style,
       integrations, created_timestamp, modified_timestamp,
       share (EventShare|None), rsvps
EventTime: start, end|None, is_all_day, is_open_ended
EventPlace: title, subtitle, city, time_zone_identifier, latitude, longitude, url
EventShare: short_guid, public_permission, participants, one_time_links,
            current_user_participant_id
Rsvp: record_name, participant_id, name, status (RsvpStatus), message,
      num_additional_adults, num_additional_kids, image_download_url,
      record_change_tag
ResolvedShare: short_guid, event_id, owner_record_name, owner_email,
      owner_given_name, owner_family_name, participant_status,
      participant_type, participant_permission, share
OneTimeLinkGuest: record_name, participant_id, name, emails, phone_numbers
OneTimeLinkInvitation: guest fields + short_guid, record_change_tag,
      share_record_change_tag; .url is the bearer link
RsvpStatus: NO_RESPONSE=0, NOT_GOING=1, MAYBE=2, GOING=3
```

`events()` returns summary objects (`share`/`rsvps` empty); `event(id)` returns
the hydrated view. Treat `OneTimeLinkInvitation.url` as a credential.

## Mail (main only)

```text
MailFolder: id, name, uid_validity, message_count
MailSender: address, display_name
MailPart: id, content_type, encoding, size, filename, is_attachment,
          mail_drop_url, mail_drop_expiration_ms
MailMessage: id, uid, mailbox, thread_id, preview_id, subject, sender, to, cc,
             flags, internal_date, size, has_attachment, parts, folder
MailBody: guid, headers, content_type, parts[guid, content]
MailPreview: message_id, folder, uid, text
MailSearchHit: id, subject, preview, count
MailThreadDigest: id, timestamp, subject, preview, count, folder_message_count
MailFilteredThread: id, folder, filter_by, timestamp
MailDraft: message, sender, to, cc, bcc, attachments, threading, retained_drafts
MailDraftAttachment: account_id, service_root, reference, source_message
MailFlagUpdate: message_id, flag ("seen"|"flagged"), enabled, modseq
MailMoveUpdate: source_message_id, source_folder_id, destination_folder_id
MailSendUpdate: source_message_id, source_folder_id, source_uid,
                acknowledged=True, delivery_confirmed=False, retained_draft_ids
MailMessageDeletion: message_id, folder_id, uid, permanent=True
MailFolderDeletion: folder_id, permanent=True
MailMessagePage: messages, limit, complete=False
MailThreadPage: MailMessagePage + thread_id
MailSearchPage: results, limit, complete=False
MailMultiSearchPage: pages, limit_per_folder, complete=False
MailMessageExport: format_version=1, message, body|None
```

`complete=False` is deliberate: pages are bounded snapshots, not full mailbox
proofs. `flags` is an integer bitmask; prefer `set_read`/`set_flagged` over
interpreting it yourself. `mail_drop_url` is excluded from serialized output
(capability URL); select by 1-based part index.

## Photos

```text
PhotoResource: key, filename, url, size, type, checksum, width, height
PhotoAsset: id, master_id, asset_id, filename, size, created, asset_date,
            added_date, dimensions, item_type, is_live_photo, resources,
            versions, master_record, asset_record
PhotoChangeEvent: kind ("updated"|"deleted"), record_name, record_type,
                  deleted, modified
PhotoSyncOptions: directory, state_dir, library, albums, size,
                  live_photo_size, folder_structure, recent, until_found,
                  skip_videos, skip_live_photos, align_raw, xmp_sidecar,
                  set_exif_datetime, keep_icloud_recent_days,
                  only_print_filenames, dry_run, auto_delete
PhotoSyncResult: directory, state_path, library, albums, sync_cursor,
                 short_circuited, downloaded_count, skipped_count,
                 deleted_count, listed_count, items
PhotoSyncItem: asset_id, resource_key, path, action, reason
```

Shared streams: `SharedPhotoStreamAlbum` adds `sharing_type`,
`allow_contributions`, `is_public`, `is_web_upload_supported`, `public_url`;
`PhotoStreamAsset` adds `like_count`, `liked`.

## Drive / Account / Calendar / Contacts

* `DriveNode`: `name`, `type`, `size`, `date_modified`, `date_changed`,
  `date_last_open`, `owner_record_name`; identity in `data["drivewsid"]` /
  `data["docwsid"]`, `data["etag"]`, `data["zone"]`.
* `AccountDevice` is a `dict` subclass: attribute access maps snake_case to
  camelCase (`device.model_display_name` → `modelDisplayName`). Fields vary by
  device type; treat as Apple response data.
* `AccountStorage` / `AccountStorageUsageForMedia` fields are in
  `services-core.md`; values are bytes except the `*_percent` helpers.
* `CalendarObject` / `EventObject` are dataclasses with `request_data`;
  `AppleCalendarEvent`, `ApplePayloadInvitee`, `AlarmMeasurement` are wire
  models.
* `MeCard`: `first_name`, `last_name`, `photo`, `raw_data`.

## Exceptions

Root: `PyiCloudException` (everything below except CRDT/sync helpers).

```text
PyiCloudException
├─ PyiCloudFailedLoginException
│  └─ PyiCloudAccountLockedException            # -20209
├─ PyiCloudAPIResponseException
│  ├─ PyiCloudConnectionException
│  ├─ PyiCloudEndpointGoneException              # 410
│  ├─ PyiCloudServiceNotActivatedException      # missing webservice
│  ├─ PyiCloudPCSTimeoutException               # ADP consent
│  ├─ PyiCloudTrustedDevicePromptException
│  └─ PyiCloudTrustedDeviceVerificationException
├─ PyiCloud2FARequiredException
├─ PyiCloud2SARequiredException
├─ PyiCloudAuthRequiredException                # 450
├─ PyiCloudAcceptTermsException
├─ PyiCloudNoTrustedNumberAvailable
├─ PyiCloudSecurityKeyException
│  └─ PyiCloudSecurityKeyTimeoutException
├─ PyiCloudNoStoredPasswordAvailableException
├─ PyiCloudNoDevicesException
├─ PyiCloudPasswordException
├─ PyiCloudServiceUnavailable
└─ TokenException
```

Service hierarchies (2026.10.1):

```text
NotesError            → NotesAuthError, NotesRateLimited, NotesApiError,
                        NoteNotFound, NoteLockedError
RemindersAuthError / RemindersApiError        # both direct PyiCloudException
InvitesError          → InvitesAuthError, InvitesRateLimited,
                        InvitesEntitlementError, InvitesApiError
PhotosServiceException→ (2026.10.1 only; CloudKit errors are separate)
CRDTDecodeError(ValueError) → CRDTStructureError
```

Main adds `NotesZoneNotFoundError`, `RemindersZoneNotFoundError`,
`InvitesZoneNotFoundError`, the `PhotosAuthError/RateLimited/ApiError/
ZoneNotFoundError` family, `CloudKitZoneNotFoundError`, and
`MailError → MailWriteRejected | MailWriteUncertain`.

Sync helpers (main, Mail): `SyncResetRequired(ValueError)` →
`SyncHistoryExpired | SyncInventoryRequired | StateConflict`;
`UnsafeSyncStorage(ValueError)`, `SyncStorageBusy(ValueError)`.

## Errors that are not exceptions

Some services report a **business outcome**:

* `PhotosService.upload()` returns `None` when indexing is not finished.
* `HideMyEmailService.generate()` returns `None` when no alias is available.
* `InvitesService.resolve()` returns a `ResolvedShare` even when you are not a
  participant; check `participant_status`.
* `MailService.message()` / `message_by_uid()` return `None` when absent.
* `DriveNode.recover()` raises `ValueError` if the node is not in Trash.

Always check the documented return before assuming an exception means failure.
