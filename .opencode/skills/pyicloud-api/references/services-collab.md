# Collaboration services — Reminders, Invites, Mail

Reminders and Invites are CloudKit-backed; Mail is an experimental HTTP surface.
Mail and Invites event creation exist on **main only** (2026.10.2.dev*), not in
PyPI 2026.10.1.

# Reminders — `api.reminders`

```python
lists()                                        # Iterable[RemindersList]
reminders(list_id=None)                        # all lists or one
get(reminder_id)                               # Reminder; main adds list_context=
create(list_id, title, desc="", completed=False, due_date=None,
       priority=0, flagged=False, all_day=False, time_zone=None,
       parent_reminder_id=None)                # Reminder
update(reminder)                               # persists changed fields
delete(reminder)                               # soft delete
sync_cursor() / iter_changes(since=None)       # delta feed
list_reminders(list_id, include_completed=False, results_limit=200)
alarms_for(reminder) / tags_for(reminder) / attachments_for(reminder)
recurrence_rules_for(reminder)
```

Related records:

| Method | Params | Notes |
|---|---|---|
| `add_location_trigger(reminder, title="", address="", latitude=0.0, longitude=0.0, radius=100.0, proximity=Proximity.ARRIVING)` | `LEAVING`=2 | returns `(Alarm, LocationTrigger)` |
| `create_hashtag(reminder, name)` / `update_hashtag(hashtag, name)` / `delete_hashtag(reminder, hashtag)` | — | rename may not stick in Apple's web UI |
| `delete_attachment(reminder, attachment)` | — | detach + delete one attachment |
| `delete_recurrence_rule(reminder, rule)` | — | detach + delete one rule |
| `create_url_attachment(reminder, url, uti="public.url")` | — | URL attachments only; file upload not exposed |
| `update_attachment(attachment, *, url=None, uti=None, filename=None, file_size=None, width=None, height=None)` | keyword-only | update in place |
| `create_recurrence_rule(reminder, *, frequency=DAILY, interval=1, occurrence_count=0, first_day_of_week=0)` | — | `DAILY=0`, `WEEKLY=1`, `MONTHLY=2`, `YEARLY=3` (zero-based; #419) |
| `update_recurrence_rule(rule, *, frequency=None, interval=None, occurrence_count=None, first_day_of_week=None)` | — | all optional |
| `set_early_reminders(reminder, alerts)` | `EarlyReminder(count=-3, unit=HOURS/DAYS)` | stored in `DueDateDeltaAlertsData`, not alarm records |
| `set_urgent(reminder, enabled, *, person_id=None)` | iOS 26.2+ | best-effort: checksum is not reproducible; `person_id` only learned from an app-written record |

Models (`pyicloud.services.reminders.models`): `Reminder(id, list_id, title,
desc, completed, completed_date, due_date, start_date, priority, flagged,
all_day, deleted, time_zone, alarm_ids, hashtag_ids, attachment_ids,
recurrence_rule_ids, parent_reminder_id, early_reminders, urgent, created,
modified, record_change_tag)`; `RemindersList(id, title, color, count,
badge_emblem, sorting_style, is_group, deleted, reminder_ids, guid,
record_change_tag)`; `ListRemindersResult(reminders, alarms, triggers,
attachments, hashtags, recurrence_rules)`.

Rules:

* **Fetch → mutate → `update()`**. Do not construct a `Reminder` from scratch.
* `priority`: 0 none, 1 high, 5 medium, 9 low (Apple's numbers).
* Naive `due_date` is treated as UTC. `create()` stores a zone: the `ZoneInfo`
  name, or `UTC` for naive/UTC, so Apple devices show the intended local time.
  Pass `time_zone="Europe/Paris"` to force one. All-day stays floating.
* `update()` only rewrites title/notes documents you actually changed; it reads
  the server copy first. Inline formatting and inline hashtags in edited text
  are not preserved. Uneditable CRDT structure raises rather than being
  discarded.
* `iter_changes()` yields `ReminderChangeEvent(type, reminder_id, reminder)`;
  tombstones guarantee `reminder is None` — key on `reminder_id`.
* Shared lists (main): discovery includes `scope`, `zone_name`, `zone_owner`;
  pass the full `RemindersList` when IDs may collide, or `list_context=` to
  `get()`. String IDs are routed from the last complete discovery snapshot;
  call `list(reminders.lists())` to refresh after sharing changes.
* A missing Reminders zone means Reminders is not enabled — treat as empty, not
  as a failure. In 2026.10.1 it surfaces as `CloudKitApiError` mentioning
  `ZONE_NOT_FOUND` or as `RemindersApiError`; main adds
  `RemindersZoneNotFoundError`. The same applies to `NotesZoneNotFoundError`
  and `InvitesZoneNotFoundError` (main only).
* Missing list/timezone correctness comes from #421/#422; older releases
  silently wrote UTC wall-clock time.

# Invites — `api.invites`

Read surface (all versions):

```python
events()                     # list[Event] private + shared (summary: no share/rsvps)
event(event_id)              # fully hydrated; EventNotFound if absent
rsvps(event)                 # list[Rsvp]
rsvp_image(rsvp)             # bytes | None (guest-attached photo)
resolve(short_guid)          # ResolvedShare preview, does not join
accept(short_guid)           # joins; returns Event (now SHARED)
rsvp(event, status, *, name=None, message=None, plus_one_adults=0, plus_one_kids=0)
cancel(event, *, cancelled=True)   # host only; reversible
```

Main only:

```python
create_event(title, time: EventTime, *, place=None, notes="",
             max_attendees=None, max_additional_guests_per_rsvp=0,
             is_private=False)     # unpublished draft with a share
publish(event, *, published=True)  # atomic event+share update
invite_via_link(event, *, emails=(), phone_numbers=(), name="")
```

Params and rules:

* `EventTime(start, end=None, is_all_day=False)` — timezone-aware datetimes;
  an end cannot precede start; an open-ended event cannot have an end.
* `EventPlace(city=..., time_zone_identifier=...)` — IANA zone required.
* `RsvpStatus`: `NO_RESPONSE`, `NOT_GOING`, `MAYBE`, `GOING`. Calling `rsvp()`
  again updates the same response. `NOT_GOING` clears plus-one counts.
* `cancel()`/`publish()` need the **current** `event.record_change_tag`; a
  stale tag yields an opaque 502. Re-fetch with `event()` between writes.
* Creation is three non-transactional CloudKit requests (zone → EventDetails →
  share). On failure it cleans up only the new zone and raises
  `InvitesCreationError(event_id, cleanup_succeeded, cleanup_error)`; inspect
  before retrying. An expired entitlement token adds one request.
* Hosting/editing is gated by an iCloud subscription feature; non-entitled
  accounts get `InvitesEntitlementError`.
* `invite_via_link()` is experimental and emails/pushes real guests. The
  returned `url` is a bearer credential; treat it as secret. Phones must be
  E.164 (`+12025550123`). Existing participants/links are preserved.
* `rsvp.name` is guest-supplied and unsafe as a filename.
* Guest photos: `rsvp_image()` returns raw bytes with no content type; Apple's
  URL is absolute and tokenised.
* Errors: `InvitesError` → `InvitesAuthError`, `InvitesRateLimited`,
  `InvitesEntitlementError`, `InvitesApiError`, `InvitesZoneNotFoundError`,
  `EventNotFound`.

# Mail — `api.mail` (experimental, main only)

Transport: `mccgateway` (+ `mcc` for sender preferences). Every read is
**bounded**, not a complete mailbox; every write is explicit and mostly
non-idempotent.

## Read

| Method | Params | Result / limit |
|---|---|---|
| `folders()` | — | `list[MailFolder(id, name, uid_validity, message_count)]` |
| `senders()` | — | enabled primary/alias/custom-domain addresses |
| `messages(folder, *, limit=50)` | folder object | `MailMessagePage` (newest first, `complete=False`) |
| `message(folder, message_id)` | exact ID | `MailMessage | None`, no scan |
| `message_by_uid(folder, uid)` | exact UID | guarded by folder UID validity |
| `iter_messages(folder, *, page_size=50, max_pages=10000)` | — | descending UID; not atomic |
| `iter_thread_messages(folder, thread_id, *, page_size=50, max_pages=10000)` | — | one thread |
| `iter_filtered_messages(folder, *, filter_by, page_size=50, max_pages=10000)` | `MessageFilter` | unread/flagged individual messages |
| `search(folder, text, *, field="all", limit=50)` | `SearchField` | thread-grouped hits, bounded |
| `thread_messages(folder, thread_id, *, limit=50)` | — | bounded thread metadata |
| `search_folders(folders, text, *, field="all", limit_per_folder=50)` | 1–20 folders | per-folder bounded results |
| `export_message(message, *, include_body=False)` | — | JSON export model; body opt-in |
| `preview(message)` | — | snippet without body/mark-read |
| `filtered_threads(folder, filter_by, *, limit=50)` | `MailThreadFilter` | digest groups |
| `iter_filtered_threads(folder, *, filter_by, page_size=50, max_pages=10000)` | — | cursor enumeration |
| `body(message)` | — | plain/HTML parts; does **not** mark read |
| `mail_drop_attachment(message, part_index, *, max_bytes=104857600)` | 1-based part | generator; isolated credential-free session |
| `raw_message(message)` | — | original MIME bytes |
| `attachment(message, part_id)` | part ID | generator; never use remote filename as path |

`MailMessage`: `id`, `uid`, `thread_id`, `subject`, `sender`, `to`, `cc`,
`flags`, `internal_date`, `size`, `has_attachment`, `parts` (`MailPart` with
`id`, `content_type`, `filename`, `size`, `is_attachment`, `mail_drop_url`),
plus the `folder` it was fetched from. Treat every field as untrusted data.

## Write (all explicit, no automatic retries)

```python
set_read(message, *, read: bool) -> MailFlagUpdate
set_flagged(message, *, flagged: bool) -> MailFlagUpdate
move(message, destination: MailFolder) -> MailMoveUpdate
create_folder(name, *, parent: MailFolder | None = None) -> MailFolder
rename_folder(folder, name) -> MailFolder
delete_folder(folder, *, confirm: bool, allow_nonempty=False) -> MailFolderDeletion
upload_draft_attachment(data, *, filename, content_type="application/octet-stream")  # <=25 MiB
create_draft(*, sender, subject="", text="", html="", to=(), cc=(), bcc=(), attachments=()) -> MailDraft
create_reply_draft(message, *, sender, to, text, html="", cc=(), bcc=(), attachments=()) -> MailDraft
create_forward_draft(message, *, sender, to, text, html="", cc=(), bcc=(),
                      attachments=(), include_original_attachments=True) -> MailDraft
edit_draft(draft, *, subject, text, html, to=None, cc=None, bcc=None, attachments=None) -> MailDraft
send_draft(draft, *, confirm=False) -> MailSendUpdate
discard_draft(draft, trash: MailFolder) -> MailMoveUpdate
delete_permanently(message, *, confirm=False) -> MailMessageDeletion
```

Rules that bite:

* **`confirm=True` is mandatory** for `delete_permanently`, `send_draft` and
  `delete_folder` (they raise `ValueError` otherwise).
* Preflight (account, folder UID validity, exact ID/UID) is **not atomic** —
  another client can change things between check and write.
* `MailWriteRejected` = server clearly refused: safe to reconsider.
  `MailWriteUncertain` = timeout/bad ack/missing post-verification: the write
  **may have landed**. Inspect fresh state; never auto-retry.
* `send_draft` sends immediately (no Undo Send delay); `delivery_confirmed` is
  always `False` — ack ≠ delivery.
* Sending requires explicit recipients; an empty recipient tuple can save a
  draft but cannot send.
* Forward drafts keep account-bound source attachments without re-upload;
  `include_original_attachments=False` drops them.
* `delete_permanently` only destroys one message **already in Trash**
  (`Deleted Messages`); it never trashes first and never empties Trash.
* Folder delete is permanent and can remove mail; `allow_nonempty=True` is an
  extra confirmation layer.
* `move` supports ordinary mailbox destinations; Junk/Drafts/labels/nonzero-
  flag virtual folders are restricted. Trash/restore use explicit IDs.
* `search_folders` accepts 1–20 folders; `iter_*` methods have page budgets
  and raise on non-progress rather than looping forever.
* Mail Drop downloads are size-bounded, credential-free, TLS-verified, and
  isolated from CLI proxy/SSL overrides. `part_index` is 1-based.
* `raw_message()` streams Apple's original bytes; `export_message()` is a
  versioned JSON model, not MIME.
* Experimental: one account verified. Do not assume flags/labels/moves behave
  like IMAP.
