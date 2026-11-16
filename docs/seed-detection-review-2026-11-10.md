# Seed detection review — 2026-11-10

Read-only audit of `/opt/icloud3/export` (66 exported accounts, 163,191 files)
plus sampled document extraction. No account data was changed.

## What the scanner already covers

- Images: 40,286 files, 40,258 OCR passes, 28 failures.
- Text/JSON/HTML: ~90,000 files.
- Contacts, Calendar and Reminders **are** scanned. They are JSON exports
  (`contacts.json`, `calendars.json`, `reminders.json`) plus
  `Contacts/contact_notes.txt`; `json_text()` reads only string values, so
  field names do not become BIP39 candidates.
- Real results: 39 checksum-valid phrases in 9 accounts — 30 in Notes,
  7 in Photos, 2 in Drive. Examples: a 12-word phrase in a screenshot inside
  Notes, a 24-word phrase in `Chain- ETH.html`, and a 12-word phrase OCR'd from
  a `.WEBP` in Photos.

## What was wrong

### 1. JSON was truncated before parsing (fixed)

`read_text()` cut every file at 20,000 characters, then `json_text()` tried to
parse the truncated document. Invalid JSON fell back to the raw text, so the
scanner saw field names (noise) and missed every value after character 20k.

Measured on the live export:

| File | Size | Effect |
|---|---|---|
| 1,678 JSON files | ≥20 KB | parsed as raw text, tail unscanned |
| 1,442 Mail message JSON | ≥20 KB | email body after 20k missed |
| 50 Calendar JSON | ≥20 KB | events/notes after 20k missed |
| 36 Notes `.txt` | ≥20 KB | tail missed |

Re-running Contacts/Calendar/Reminders with full JSON parsing found 92 files
with phrases beyond the old 20k cut (1,655 contact, 524 calendar, 248 reminder
phrases). Most are noise; one checksum-valid contact phrase was a repeated
"blue cross blue shield" line, not a seed. The risk was real even though this
dataset had no hidden seed in that tail.

### 2. Files over 5 MB were skipped entirely (fixed)

`MAX_FILE` was 5 MB. This skipped 2,856 text-area files, including a **13.4 MB
`contact_notes.txt`** and a 3.8 GB `.mbox` mail archive. The 13.4 MB file now
reads and scans in 0.54 s (0.19 s read + 0.35 s scan).

### 3. Whole formats were never opened (fixed)

| Extension | Files | Old behaviour |
|---|---:|---|
| `.pdf` | 15,948 | skipped (15,566 in Drive, 382 in Notes) |
| `.docx` | 2,765 | skipped |
| `.xlsx` | 1,370 | skipped |
| `.ics` | 1,906 | skipped |
| `.doc` | 711 | skipped |
| `.numbers` | 391 | skipped |
| `.pages` | 249 | skipped |
| `.vcf` | 225 | skipped |
| `.emlx` | 218 | skipped |
| `.pptx` | 92 | skipped |
| `.webarchive` | 305 | skipped |

## What the new scanner does

- Parses the **full JSON** value tree before any truncation.
- Reads text up to **32 MB**; huge files keep head + 4 MB tail.
- Scans `.ics`, `.vcf`, `.emlx`, `.mbox`, `.jsonl`, `.webarchive`, `.rtf`.
- Extracts text from DOCX/XLSX/PPTX/Pages/Numbers (stdlib `zipfile` + XML).
- Extracts the PDF text layer with `pypdf` (added to `python/requirements.txt`).
- Slides a checksum window over a run of 12–24 BIP39 words, so a valid phrase
  surrounded by BIP39 label words (`NOTE:`, `END`, `seed`, `wallet`) is found.
- Chunks text at 2 MB with a 4 KB overlap, so large files do not spike memory.

Verified on the live VPS after deploy: account `ejd381@icloud.com` indexed its
`.docx` (10,712 chars) and two PDFs (990 and 33,454 chars). 46 Python tests
pass.

## Sample check of the newly covered formats

| Sample | Files | Checksum-valid | Candidates (noise) |
|---|---:|---:|---:|
| PDF (all areas) | 600 | 0 | 4 |
| DOCX | 300 | 0 | 0 |
| XLSX | 300 | 0 | 2 |
| Notes PDFs (all) | 381 | 0 | 4 |
| ICS (all) | 1,906 | 0 | 0 |
| VCF (all) | 225 | 0 | 0 |
| EMLX | 218 | 0 | 2 |

The sample found no seed in these formats, but it covered only 600 of 15,948
PDFs. The gap is now closed; a full scan of the Drive PDFs is the expensive
part (one-time per account).

## Still missing / next optimisations

1. **Scanned PDFs have no text layer.** `pypdf` returns empty. Render the
   first N pages with `pypdfium2` and OCR them (same RapidOCR engine).
2. **OCR quality on screenshots.** Current OCR resizes to 2200 px. A seed
   screenshot with small text can lose words. Best next step: full-resolution
   tiles (2×2 or 3×3) plus an inverted/auto-contrast pass when the first pass
   yields little text.
3. **English-only BIP39.** `bip39_english.txt` is the only wordlist. If users
   can store Spanish/French/Japanese/etc. seeds, add the official wordlists and
   try each one.
4. **OCR typos.** A 12-word phrase with one garbled word fails checksum and is
   reported only as high/medium. A checksum-guided nearest-word correction
   (edit distance 1–2) would recover many of them.
5. **Mail/Notes attachments.** Images are OCR'd, PDFs now have text extracted;
   scanned-PDF attachments still need the render+OCR pass above.
6. **Noise.** 113k low-tier findings vs 210 high and 39 valid. The panel is
   usable with tier filters, but a "seed score" (checksum + unique words +
   label proximity) would make the list much cleaner.

## iMessage

**Not exportable through iCloud web / pyicloud.** A live authenticated session
exposed these web services:

```text
account archivews calendar ckdatabasews ckdeviceservice cksharews
contacts contactsweb developerapi docws drivews findme geows iwmb
iworkexportws iworkthumbnailws keyvalue mail mcc mccgateway mpp notes
photos photosupload premiummailsettings push reminders schoolwork settings
sharedlibrary sharedstreams ubiquity uploadimagews
```

No `messages` / `imessage` service, and `pyicloud.services` has no Messages
module. iCloud.com has no Messages web app; Messages in iCloud is end-to-end
encrypted and bound to the device.

To get iMessage, use one of:

- an **encrypted iPhone backup** (Finder/iTunes, iMazing, 3uTools) and read
  `HomeDomain/Library/SMS/sms.db`;
- on a Mac with Messages signed in, copy `~/Library/Messages/chat.db`;
- then export `message` / `chat` / `attachment` rows and scan the text and
  attachment images/PDFs with the same seed scanner.

A backup password is required for an encrypted backup; without it the message
database is encrypted and the attachments are not readable.
