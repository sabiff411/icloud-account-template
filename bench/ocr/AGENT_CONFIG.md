# Agent configuration — BIP39 seed OCR over Runpod

Copy this into the other agent. It is self-contained: endpoint, prompts, output
contract, and the deterministic post-processing rules that make the output safe.

## 1. Endpoint

```yaml
vision:
  provider: openai-compatible          # /v1/chat/completions
  base_url: https://<POD_ID>-8000.proxy.runpod.net/v1
  model: Qwen/Qwen3-VL-8B-Instruct
  api_key: none                        # vLLM open server; use the pod proxy
  temperature: 0
  max_tokens: 400
  timeout_s: 120
  concurrency: 16                      # 0.16 s/img measured at 16; 8 → 0.37 s/img
  image:
    max_side: 1600                     # do NOT send 4000 px originals; 1600 is enough
    format: jpeg
    quality: 90
```

## 2. System prompt

```text
You are an OCR engine for cryptocurrency wallet seed phrases (BIP39).
You read an image and return the seed words exactly as printed, one word per line.
You never translate, correct, complete, or guess words. If a word is unclear you
still output your best literal reading of the glyphs, not a similar dictionary word.
```

## 3. User prompt (send with every image)

```text
Extract the seed words from this image.
- If the words are numbered: output one line per word as '<number> <word>'.
- If they are NOT numbered: output 'COLUMNS: <n>' on the first line (how many
  vertical word columns you see), then every word in row order
  (left-to-right, top-to-bottom).
Output only that — no commentary.
```

## 3b. Ordering (the important part)

The numbers printed by the wallet ARE the phrase order. Never trust the model's
visual reading order when numbers exist:

1. parse `N word` lines, sort by N, require contiguous 1..N;
2. if the image is unnumbered, trust `COLUMNS: n` and convert row-major →
   column-major (`grid_variants`), then accept only if the checksum passes;
3. if numbers are garbled (handwriting), fall back to the line order and the
   column transform, and let the checksum decide between the candidates.

Verified on a deliberately shuffled 12-word grid (numbers in random cells):
line-order read got 0/12 correct; number-sorted read got 12/12, checksum valid.

## 4. Output contract

The model returns newline-separated words. The agent must then apply these rules
(implemented in `bench/ocr/postprocess.py`, dependency-light):

1. **Normalise** each token: NFKC, lowercase, strip everything but `a-z`.
2. **Match to the 2048-word BIP39 list**:
   - exact → score 1.0;
   - OCR confusions (`0→o`, `1→l`, `5→s`, `8→b`, `|→l`) → 0.92;
   - Levenshtein 1 for words ≥5 chars → 0.88; Levenshtein 2 for words ≥8 chars → 0.78;
   - words <5 chars are never fuzzy-matched (`your` must not become `hour`).
3. **Build runs**: bridge at most one unmatched token, two if it is a number/bullet/junk.
4. **Candidates**: if the run length is exactly 12/15/18/21/24, that is the phrase.
   Otherwise trim up to 8 words from the head or tail only (UI chrome), never the middle.
5. **Checksum** (SHA-256 of entropy, n/3 bits) for 12/15/18/21/24.
6. **Grid re-order**: if the checksum fails, retry the same words as a 2/3/4/6-column
   grid (row-major input → column-major order); accept if one passes.
7. **Rank**: checksum true first, then longer phrase, then confidence, then start offset.
8. **Reject** with a reason: `low confidence` (<0.75), `checksum fail`, `no match`.
   Never silently drop a candidate: a full-length phrase that fails the checksum is
   returned with `checksum=false` and the reason `checksum fail`.

Tier mapping (keep the existing scanner semantics):
`3–4 low, 5–7 minimum, 8–11 medium, 12+ high`.

## 5. Optional structured output

If the agent needs JSON instead of lines, ask for:

```text
Return JSON only: {"words": ["..."], "count": 12, "layout": "grid|list|inline", "confidence": 0.0}
```

Then run the same normalise → match → checksum steps on `words`.

## 6. Retry policy (cost-aware)

- Retry only when the first pass is **seed-like** (`max_run >= 6` or ≥8 matched words at
  ≥50% density) and no checksum-valid phrase was found.
- Retry order: rotate 90/180/270 (auto-orient once with Tesseract OSD if available) →
  grayscale + autocontrast + 1.6× upscale → adaptive threshold.
- Optional stricter re-ask for near misses: same image at `max_side=2400`, prompt with
  "do not substitute words". Recovers ~30% of the remaining single-word misses.
- Do not retry receipts/menus/prose: they cost 5× latency for no gain.

## 7. Measured on your 7 images (A100 80GB, live)

| image | type | latency | model output | checksum |
| --- | --- | ---: | --- | --- |
| sample_01 | Nicegram 2-col | 2.8 s | satoshi film law salute lizard actual eight trust gas raw eyebrow dance | ✅ |
| sample_02 | white 1-col list | 1.9 s | again empty warm hip fat allow broccoli turn finger insane hunt service | ✅ |
| sample_03 | photo of phone screen | 2.2 s | diesel vote valley phrase solve table bunker all august fish void evolve | ✅ |
| sample_04 | terminal, 24-word inline | 2.7 s | able journey celery blast defense stamp clever ethics grocery front arrest wheel power elite sample melody garment quarter | ⚠️ only 19 words visible in the crop |
| sample_05 | LND wallet, 2-col grid | 2.6 s | about estate there brief mention relax vessel enact scale edit mistake bus choice universe surround soldier liberty crunch oxygen fluid romance elite scrub jelly | ⚠️ reads exactly, seed itself is checksum-invalid |
| sample_06 | photo of phone, 1-col | 2.6 s | gas smile oil wide unaware fish average vacuum gesture foot primary amused | ✅ |
| sample_07 | handwritten list | 3.1 s | horror slight song drift together reward garbage fragile need final junior tackle | ⚠️ reads exactly, seed itself is checksum-invalid |

6/7 transcribed exactly, including handwriting and a photographed screen. sample_04 is
truncated in the source image (19 of 24 words); samples 05 and 07 are demo seeds whose
checksum does not validate — the words are still returned and flagged.

## 8. Concurrency and cost

vLLM batches requests continuously, so one GPU serves many sessions at once.
Measured on A100 80GB, same 120-image set:

| concurrent requests | s/image | images/hour |
| ---: | ---: | ---: |
| 8 | 0.301 | 11,960 |
| 16 | 0.164 | 21,950 |
| 32 | 0.102 | 35,290 |
| 48 | 0.082 | 43,900 |
| 64 | 0.069 | 52,170 |
| 96 | 0.061 | 59,000 |

Single-request latency stays ~2.5 s; that is queueing + decode, not throughput.
300,000 images at 0.061 s/img = **5.1 GPU-h ≈ $9** on the A100 ($1.79/hr).
Cheaper cards: RTX 6000 Ada $0.99/hr, 5090 $1.19/hr (~1.3–1.6× slower).

## 9. Known limits

- A 12-word all-BIP39 line in an unrelated screenshot can pass the 1/16 checksum:
  3 such false phrases across 140 real-screenshot negatives (21/1000). A 24-word
  phrase is 1/256 and effectively immune.
- Handwriting: one word can be misread (`drift` → `drip`); a zoomed crop retry is
  the fix, not a different engine.
