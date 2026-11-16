# OCR + BIP39 pipeline benchmark — implementation plan

> **For agentic workers:** use superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Pick and integrate the OCR/seed-extraction pipeline with the best phrase recall per unit latency, proven on a labelled 500+ image set, with a reproducible harness and a patch to `python/worker/scan.py`.

**Architecture:** A shared `bench/ocr` package: synthetic+real eval generator with ground truth, engine adapters returning `(text, boxes, confidence)`, a phrase-aware post-processor (reading order → BIP39 fuzzy match → checksum → near-miss retry), a scoring harness, and a thin integration layer in the worker.

**Tech stack:** Python 3.12, Pillow(+heif/avif), OpenCV, RapidOCR/ONNX, PaddleOCR, Tesseract 5, EasyOCR, docTR, Surya, optional Runpod public vision endpoint.

**Spec:** this task brief (user message, 2026-11-12).

## Global constraints

- Baseline must be measured on the same set: RapidOCR 1.4.4, PP-OCR default, max 2200 px, 1 ONNX thread, 8 processes.
- Acceptance: printed/screenshot recall ≥ 95%, photographed paper ≥ 85%, ≤ 2 FP/1000 negatives, CPU p95 ≤ 1.5 s/img @ 8 procs or GPU ≤ 0.2 s/img.
- Existing artefacts preserved: `Scan/ocr`, `Scan/index.json`, `Scan/findings.json`, `Scan/summary.json`, tiers + checksum semantics.
- No corpus writes; eval images live under `bench/ocr/eval`.

## File structure

- `bench/ocr/gen_eval.py` — build synthetic + real eval images and `gt.json`.
- `bench/ocr/engines.py` — adapters: `recognize(path) -> Result(text, lines[Box])`.
- `bench/ocr/postprocess.py` — reading order, normalise, fuzzy BIP39, checksum, near-miss.
- `bench/ocr/run_bench.py` — run engines over the set, write `results/<engine>.jsonl`.
- `bench/ocr/score.py` — compute recall/CER/FP/latency tables.
- `bench/ocr/regress.py` — one-command regression gate.
- `python/worker/ocr_pipeline.py` — new worker module (integration target).
- `python/worker/scan.py` — wire `_ocr_engine`/`_image_task`/phrase extraction to the module.

## Tasks

### Task 1: Eval generator
**Files:** create `bench/ocr/gen_eval.py`, output `bench/ocr/eval/{images,gt.json}`.
- [ ] Generate 5 word counts (12/15/18/21/24) × 1–4 columns, 3–4 words/line; valid BIP39 checksums from OS entropy.
- [ ] Render variants: clean print, paper photo (perspective, shadow, low light, blur), screenshot chrome, ±90/180 rotation, skew 1–4°, JPEG 30–60, downscale, HEIC/AVIF.
- [ ] Copy real positives (wallet screenshots) + real negatives from `export/`; mark class.
- [ ] Emit `gt.json`: `{id, file, class, word_count, columns, transcript, phrase, checksum_valid}`.
- [ ] Verify: 500+ images, every class ≥ 40, phrases checksum-valid unless labelled `near_miss`.

### Task 2: Engine environment
- [ ] Create `bench/ocr/.venv` with torch cu128, paddlepaddle, rapidocr, easyocr, doctr, surya, pytesseract, pillow_heif.
- [ ] Install Tesseract 5 without root (dpkg-deb extract) or record as unavailable.
- [ ] Verify each adapter returns boxes on one image.

### Task 3: Engine adapters
- [ ] `RapidOCR(default)`, `RapidOCR(en rec + tuned det)`, `PaddleOCR(en)`, `Tesseract(psm 6/11)`, `EasyOCR`, `docTR`, `Surya`.
- [ ] Each returns lines with quad boxes + confidence; image decode honours EXIF, max side param.
- [ ] Unit test: adapter on a clean render contains ≥ 90% of words.

### Task 4: Post-processor
- [ ] Reading order: y-sort, line grouping tolerance, column detection (x-gap clustering), column-major emit.
- [ ] Normalise (case, common OCR confusions, `0/o`, `1/l/I`, punctuation) and fuzzy-match tokens to the 2048 words (Levenshtein ≤1, ≤2 for len ≥7) with per-token confidence.
- [ ] Run detection + checksum for 12/15/18/21/24; near-miss (11–12 words, checksum fail) triggers crop retry hook.
- [ ] Tests: synthetic 3-column text reconstructs exact phrase; one-character corruption repairs; invalid checksum rejected.

### Task 5: Harness + metrics
- [ ] `run_bench.py`: per image wall time, lines, text; `--procs`, `--max-side`, `--gpu`.
- [ ] `score.py`: exact phrase recall by class/bucket, CER/WER, FP/1000 negatives, median/p95, checksum-valid rate, rejection reasons.
- [ ] Verify baseline reproduces on the set.

### Task 6: Benchmark run
- [ ] Run all engines CPU (8 procs); GPU subset for torch engines and ORT.
- [ ] Add cloud/VLM fallback only for near-misses; measure extra calls and gain.
- [ ] Produce `bench/ocr/results/REPORT.md` with the table + winner justification.

### Task 7: Integration patch
- [ ] Copy tree to scratch, add `ocr_pipeline.py`, edit `scan.py` (engine config, post-process, near-miss, dedupe).
- [ ] Keep artefact shapes; env-compatible defaults; fallback to current behaviour when disabled.
- [ ] Port/extend `python/tests/test_scan.py`; run the suite.
- [ ] `diff -u` → `bench/ocr/scan.patch`; `regress.py` one-command gate.

## Review focus
- Multi-column reading order (2–4 cols) — the failure that silently reorders a phrase.
- EXIF rotation on phone JPEG/HEIC — must not depend on the OCR engine.
- Near-miss retry must not double-count or invent phrases.
- Deterministic output ordering (engine order vs box order) so tiers/findings stay stable.
- CPU-only path must not require torch/paddle to be installed.
