# Fleet prompt — many identical pods, one client

Copy the block below into the other coding agent. It makes the client
pod-count agnostic: add a URL, add a pod, nothing else changes.

## PROMPT (paste as-is)

```text
Integrate a FLEET of identical Runpod vision-LLM pods as one OCR service.

Every pod is the same installation and returns the same shape:
  image:  vllm/vllm-openai:latest
  model:  Qwen/Qwen3-VL-8B-Instruct
  flags:  --host 0.0.0.0 --port 8000 --max-model-len 8192
  route:  POST {base_url}/chat/completions

CONFIGURATION (pod-count agnostic — 1 pod or 50, same code)
  SCAN_VLM_URLS = comma-separated base URLs, e.g.
    https://pod1-8000.proxy.runpod.net/v1,https://pod2-8000.proxy.runpod.net/v1,...
  SCAN_VLM_MODEL = Qwen/Qwen3-VL-8B-Instruct
  SCAN_VLM_KEY = <shared --api-key, if set on the pods>
  SCAN_VLM_MAX_SIDE = 1024
  SCAN_VLM_CONCURRENCY_PER_POD = 8     # 8 is the measured sweet spot; 16 max; never 32

STARTUP
  1. GET {base_url}/models for every URL in parallel.
  2. Keep only pods that answer 200 with the expected model id.
  3. If a pod is down, log it and continue with the rest. Never abort the run
     because one pod is missing.
  4. Shard the input list evenly across the healthy pods (ceil split), or use a
     shared work queue that a worker claims from — both are fine. One process
     per pod, 8 threads inside it.

PER REQUEST
  - EXIF-rotate, RGB, longest side 1024, JPEG q90, base64, data URL
  - temperature 0, max_tokens 700
  - identical prompt on every pod (below); never vary it per pod

  Classify + extract in ONE call:

  "Look at this image. Return JSON only:
   {\"category\":\"screenshot_phone|screenshot_desktop|photo_screen|photo_document|handwritten|receipt|menu|chat|dashboard|selfie|portrait|nsfw|other\",
    \"contains_text\":true|false,\"nsfw\":true|false,\"confidence\":0.0,
    \"layout\":\"numbered|columns\",\"columns\":1,
    \"words\":[\"word1\",\"word2\",...]}
   Rules: "words" must contain ONLY the words — no numbers, no punctuation.
   If the printed words are numbered, put them in ascending NUMBER order and set
   layout=numbered. If not numbered, set layout=columns and columns to the
   number of vertical word columns, and list the words in row order
   (left-to-right, top-to-bottom). If there is no seed list, words=[].
   No commentary."

PARSING (identical on every pod; this is what makes returns comparable)
  1. If layout=numbered: ensure ascending order; if a string still starts with
     digits ("1 satoshi"), strip the digits and sort by that number. Require
     contiguous 1..N.
  2. Else if columns>1: convert row-major -> column-major with the uneven split
     (first N-(N mod C) columns get ceil(N/C), the rest floor(N/C)).
  3. Lowercase a-z, match BIP39 (exact 1.0; 0->o 1->l 5->s 8->b 0.92;
     Levenshtein 1 for >=5 chars, 2 for >=8; never fuzzy-match <5 chars).
  4. Checksum 12/15/18/21/24. On failure try other column counts 2..6 and take
     the first that validates.
  5. Return {phrase, words, count, checksum, confidence, layout, nsfw, reason}.
     A full-length phrase that fails the checksum is returned with checksum=false
     and reason="checksum fail" — never dropped.

FAILOVER
  - HTTP 5xx / timeout / non-JSON: retry the SAME pod twice (1 s, 4 s).
  - Still failing: re-queue that image to a DIFFERENT healthy pod, once.
  - Pod marked unhealthy after 3 consecutive failures; re-check /models every 60 s.
  - A 429 or queue delay is not an error: back off and keep 8 in flight per pod.

RESUME
  - Write one JSON line per image as soon as it returns (file per shard).
  - On restart skip ids already present. Two runs must never redo an image.
  - Merge shards at the end; sort by id for a deterministic output file.

ROUTING (what the probe means)
  contains_text=true         -> extraction result is meaningful
  contains_text=false        -> skip OCR; keep category/nsfw only
  nsfw=true                  -> tag it; still OCR if contains_text=true
  NEVER gate on category or on a bare "is this NSFW yes/no" answer.

ACCEPTANCE (run on every pod before the fleet run)
  numbered 2-col  -> satoshi ... dance   exact + checksum valid
  1-col list      -> again ... service   exact + checksum valid
  photo of screen -> diesel ... evolve   exact + checksum valid
  handwriting     -> horror ... tackle   exact words, checksum false
  nude            -> nsfw true, contains_text false, words []
  shuffled grid   -> number sort recovers the phrase

CAPACITY MATH
  Measured per pod at 1024 px: ~2 images/s (8 concurrent).
  Wall hours = images / (2 * pods). 300,000 images:
    6 pods = 7 h, 10 pods = 4.2 h, 20 pods = 2.1 h.
  Cost is pod-hours, not pod count: ~42 pod-hours total.
```

## Launch identical pods

```bash
for i in $(seq 1 10); do
  runpodctl pod create --name ocr-$i --image vllm/vllm-openai:latest \
    --gpu-id "NVIDIA A100 80GB PCIe" --cloud-type SECURE \
    --container-disk-in-gb 100 --ports "8000/http" \
    --docker-args "Qwen/Qwen3-VL-8B-Instruct --host 0.0.0.0 --port 8000 \
      --max-model-len 8192 --served-model-name ocr" &
done
```

`--served-model-name ocr` makes every pod answer to the same model name, so the
client uses `"model": "ocr"` regardless of which pod it hits.

Collect the URLs and set them once:

```bash
SCAN_VLM_URLS="https://<id1>-8000.proxy.runpod.net/v1,https://<id2>-8000.proxy.runpod.net/v1,..."
```

## Client shape (pod-count agnostic)

```python
urls = [u.strip() for u in os.environ["SCAN_VLM_URLS"].split(",") if u.strip()]
healthy = [u for u in urls if probe(u)]          # GET /v1/models
shards = [list(range(i, len(files), len(healthy))) for i in range(len(healthy))]
# one process per shard; 8 threads; same prompt, same parser, same output
```

Adding pod #11 = append a URL and shard again. No other change.
