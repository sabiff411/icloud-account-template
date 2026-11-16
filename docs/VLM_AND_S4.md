# VLM labelling and S4 — how it works

Operational notes for the photo pipeline. No secrets here: every key is read
from the environment (`VISION_API_KEY`, `S4_KEY`, `S4_SECRET`).

## 1. VLM (Qwen3.5-4B on vLLM, OpenAI-compatible)

```text
Base URL   https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1   (public proxy)
           http://127.0.0.1:8000/v1                            (inside the pod)
Model      Qwen/Qwen3.5-4B        max_model_len 2048, 128 concurrent sequences
Auth       Authorization: Bearer $VISION_API_KEY (falls back to VLLM_API_KEY
           when the base URL is localhost)
```

Three request shapes, one image per request, `temperature: 0`,
`chat_template_kwargs: {"enable_thinking": false}`.

| job | image sent | max_tokens | answer |
|---|---|---|---|
| label | EXIF-corrected, RGB, long edge 448 px, JPEG q88 | 16 | one label from the taxonomy |
| phrase | original at 1024 px, q90 | 96–160 | the seed words, then BIP39 checksum |
| video | first frame + 50 % frame side by side, 448 px | 16 | one label for the video |

Measured token cost per request: 448 px → ~305, 1024 px → 783,
1600 px → 1915, 2048 px → over the 2048 limit (400).

Response shape used by the client:

```json
{"choices":[{"message":{"content":"wallet"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":305,"completion_tokens":2}}
```

`content` is accepted only if it is in the label set; otherwise one retry,
then `status: "invalid_label"`.

Throughput measured through the public proxy: 52 labels/s at 64 concurrent,
66/s at 128 (p50 ~860 ms, p95 ~1160 ms). With cached 640 px thumbnails and
JPEG `draft()` decode the bulk pass sustains ~135/s.

## 2. Pipeline scripts

```text
classify.py            one folder, resumable, pilot at 64 vs 128, CSV + summary
classify_all.py        every account: local tree + S4 manifests, one results file
classify_missing.py    explicit list of bucket objects (newer than their manifest)
classify_video.py      frames -> thumbnail (Scan/thumbs) + label, kind="video"
read_phrase.py         transcribe a phrase, keep it only if the checksum passes
recheck_phrases.py     4 independent reads (896/1024/1152 px + numbered) + OCR
verify_seeds.py        OCR the flagged photos, report precision per label
audit_coverage.py      local vs bucket vs labelled; exits 1 when anything is missing
vlm_index.py           publish labels to <account>/Scan/vlm-index.json (panel filter)
warm_previews.py       pre-build the 2400 px JPEG for HEIC/TIFF/BMP
```

State lives in `/opt/icloud3/classify/`:

```text
results.jsonl     one row per photo: rel_path, label, status, error, ms, model
progress.json     live done/total/rate/ETA, polled by the panel every 10 s
index.json        per-account label counts + marker the server watches
coverage.json     per-source totals and the exact list of unlabelled keys
```

Everything is resumable: a rerun skips rows whose status is `ok`;
`--retry-failed` re-does the rest. Two runs cannot process the same photo twice
(flock on `run.lock`).

## 3. S4 (MEGA S4, S3-compatible) — configuration only

```text
Endpoint  https://s3.eu-amsterdam-1.megas4.com     Region  eu-amsterdam-1
Bucket    icld        ACL private, path-style      Signed URLs  TTL 43200 s
Env       S4_ENDPOINT S4_REGION S4_BUCKET S4_KEY S4_SECRET S4_TTL
Tools     rclone remote `s4:` (type = s3, provider = Other)
```

Object layout (one prefix per account):

```text
<email>/Photos/Library/<file>              originals
<email>/Photos/Hidden/<file>
<email>/Photos/Recently Deleted/<file>
<email>/Scan/thumbs/<rel>.jpg              640 px grid tile
<email>/Scan/previews/<rel>.jpg            2400 px JPEG for HEIC/TIFF/BMP
<email>/Notes/…  Drive/…  Account/…        rest of the export
```

The bucket is private: the panel signs links (`S4_KEY`/`S4_SECRET`, SigV4) and
the browser reads the object directly, so S4 needs a CORS rule allowing `GET`
and `HEAD` from the panel origin and exposing `content-length`,
`content-range`, `accept-ranges` for video seeking.

## 4. What the panel consumes

* `Scan/vlm-index.json` per account — `{rel: {kind, modelKind, checksum, …}}`.
  The "Image type" filter and the per-account counts read this file; the server
  rebuilds its catalog when `classify/index.json` changes.
* `Scan/findings.json` — checksum-valid phrases, shown in the Seeds tab.
* `Scan/thumbs/<rel>.jpg` — grid tiles for photos and video frames.
* `Scan/previews/<rel>.jpg` — lightbox JPEG for formats no browser can draw.

## 5. Operational gotchas (learned the hard way)

* A single process must not hold the whole corpus plan: one run was OOM-killed
  at 21.7 GB RSS. Chunk by 6 accounts per process.
* `requests` defaults to a 10-connection pool per session: one session per
  worker thread, otherwise 128 threads behave like 10.
* 12–48 MP HEIC decodes need ~150 MB each: bound decoding with a semaphore
  (`CLASSIFY_DECODE`, default 8) while HTTP keeps full concurrency.
* Pruned accounts keep `Scan/thumbs` on disk — label from those and skip the
  bucket entirely.
* `s4-manifest.json` lags the bucket because the prune uploads continuously;
  `classify_missing.py` + `audit_coverage.py` cover the difference.
* Browser formats: HEIC/HEIF/TIFF/BMP are served as JPEG by `/file`
  (`download=1` still returns the original bytes).
* The `seed` label is triage, not proof: measured precision ~2 % on one
  account. Only a checksum-valid transcription counts as a phrase.
