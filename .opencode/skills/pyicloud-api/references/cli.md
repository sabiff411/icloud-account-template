# `icloud` CLI (pyicloud[cli])

Install `pip install "pyicloud[cli]"`. The CLI shares the same session
directory and services as the library; `--format json` is the automation
surface (never scrape tables).

## Global shape

```bash
icloud --version
icloud doctor [--probe] [--format json] [--session-dir DIR]
icloud auth status|login|logout [--username U] [--session-dir DIR]
```

Common options on service commands: `--username/-u`, `--session-dir`,
`--format text|json`, `--log-level`, `--http-proxy`, `--https-proxy`,
`--no-verify-ssl`, `--china-mainland`, `--interactive/--non-interactive`,
`--accept-terms`.

`--session-dir` matters: without it the CLI uses
`<tempdir>/pyicloud/<user>`, which is wiped on reboot. Point it at durable
storage for unattended use.

## auth

```bash
icloud auth status                 # authenticated? trusted? needs 2fa? (no password)
icloud auth login --username me@example.com [--accept-terms] [--session-dir DIR]
icloud auth logout                 # ends session, keeps keyring password
icloud auth logout --keep-trusted  # ask Apple to keep browser trust
icloud auth logout --all-sessions  # sign out other browsers too
icloud auth logout --remove-keyring
icloud auth keyring delete --username me@example.com
```

`login` stores the password in the system keyring only if you say yes; a stored
password lets `PyiCloudService("me@example.com")` work with no password
argument. Logout ≠ forgetting the keyring password.

## doctor

```bash
icloud doctor
icloud doctor --probe
icloud doctor --format json
```

Read-only. Shows install, session, and Apple's advertised `webservices` map;
`--probe` makes one read-only request per service (≈10 s). Exit `0` = every
service this version needs is advertised; `1` = missing/unusable or no session;
usage errors = `2`. `unavailable`/`auth` probe results do not fail the run.

## account

`summary`, `devices`, `family`, `storage` — maps to `api.account.*`.

## devices (Find My)

`list`, `show`, `sound`, `message`, `lost-mode`, `erase`, `export`.

Options: `--locate` (fresh fix), `--with-family`, `--refresh-interval N`
(turns `list` into a watch loop), `--iterations N`, `--one-factor` on
`list/show/sound/message/lost-mode/export` (Find My-only, untrusted, never
persisted; `erase` refuses it).

## calendar / contacts

```bash
icloud calendar calendars
icloud calendar events --period day|week|month [--from/--to]
icloud contacts list
icloud contacts me
```

## drive

```bash
icloud drive list /Documents
icloud drive download /Documents/file.pdf --output ./file.pdf
```

Paths are remote; use quotes for names with spaces.

## photos

Browse: `libraries`, `albums`, `shared-streams`, `list`, `get`, `changes`,
`sync-cursor`, `download`.
Sync: `sync`, `watch`.

Useful options:

* `--library root|shared:<zoneName>|shared`
* `--album NAME` (repeatable; `Library`/`Favorites` on shared libraries)
* `--limit`, `--recent N`, `--until-found N`
* `--directory`, `--folder-structure '{:%Y/%m}'`, `--size original|medium|thumb`
* `--live-photo-size original|medium|thumb`, `--skip-videos`,
  `--skip-live-photos`, `--align-raw as-is|original|alternative`,
  `--xmp-sidecar`, `--set-exif-datetime`, `--keep-icloud-recent-days N`
* `--dry-run`, `--only-print-filenames`, `--auto-delete`
* `watch --interval SECONDS [--iterations N]`

`sync`/`watch` keep SQLite state under `<directory>/.pyicloud-state`.

## hidemyemail

`list`, `generate`, `reserve`, `update`, `deactivate`, `reactivate`, `delete`.
`generate` returns an address; `reserve` activates it and returns
`anonymousId`.

## notes

`recent`, `folders`, `list`, `search --title`, `search --title-contains`,
`get`, `render`, `export`, `changes`, `sync-cursor`.

```bash
icloud notes export NOTE_ID --output-dir ./notes --export-mode archival \
  --assets-dir ./assets --full-page --preview-appearance light --pdf-height 600
```

## reminders

`lists`, `list`, `get`, `create`, `update`, `set-status`, `delete`, `snapshot`,
`changes`, `sync-cursor`, plus subgroups `alarm`, `hashtag`, `attachment`,
`recurrence`.

`list` shows open reminders; add `--include-completed`, scope with `--list-id`.
`update` supports `--early-reminder "3 hours"`, `--clear-early-reminders`,
`--urgent/--not-urgent`.

## invites

`list`, `show`, `rsvps`, `resolve`. Read-only; `show`/`rsvps` accept any
unambiguous ID prefix. RSVP and accept/join are library-only in 2026.10.1.

## mail (main only, experimental)

Read: `folders`, `senders`, `list`, `get` (`--uid` or exact ID), `body`,
`preview`, `thread`, `search`, `search-folders`, `filter`, `filter-threads`,
`export`, `export-eml`, `download`, `download-maildrop`, `sync`.
Write: `mark`, `move`, `create-folder`, `rename-folder`, `delete-folder`,
`create-draft`, `reply-draft`, `forward-draft`, `edit-draft`, `send-draft`,
`discard-draft`, `upload-draft-attachment`, `delete-forever`.

Every destructive/write command requires an explicit ID and usually
`--confirm`; none retries automatically. Treat `MailWriteUncertain`/nonzero
exit as "check before retry".

## Automation rules

1. Use `--format json`; tolerate additive fields.
2. Use `--session-dir` on a durable, private path.
3. `auth status` before a run; exit and re-auth when it says no.
4. `doctor` after an upgrade or an unexplained failure.
5. Do not loop a failing write. Destructive and uncertain outcomes are
   documented per command; inspect state first.
