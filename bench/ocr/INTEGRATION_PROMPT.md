# Integration prompt — copy this into the other coding agent

## PROMPT (paste as-is)

```text
Integrate a Runpod vision-LLM OCR service into this project.

ENDPOINT (OpenAI-compatible, no SDK needed)
  base_url:  https://zo0dbb24aajxip-8000.proxy.runpod.net/v1
  path:      POST /chat/completions
  model:     Qwen/Qwen3-VL-8B-Instruct
  api_key:   none (if the server was started with --api-key, send
             Authorization: Bearer <key>)
  temperature: 0
  max_tokens:  400
  timeout_s:   120
  concurrency: 16

IMAGE PREP (client side)
  - honor EXIF orientation
  - convert to RGB, downscale longest side to 1600 px
  - encode JPEG quality 90, then base64
  - send as a data URL: "data:image/jpeg;base64,<b64>"

REQUEST BODY (exact shape)
{
  "model": "Qwen/Qwen3-VL-8B-Instruct",
  "temperature": 0,
  "max_tokens": 400,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "<PROMPT>"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<b64>"}}
    ]
  }]
}

PROMPT TEXT
Extract the seed words from this image.
- If the words are numbered: output one line per word as '<number> <word>'.
- If they are NOT numbered: output 'COLUMNS: <n>' on the first line (how many
  vertical word columns you see), then every word in row order
  (left-to-right, top-to-bottom).
Output only that — no commentary.

RESPONSE (what you get back)
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1794447066,
  "model": "Qwen/Qwen3-VL-8B-Instruct",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "1 satoshi\n2 film\n3 law\n4 salute\n5 lizard\n6 actual\n7 eight\n8 trust\n9 gas\n10 raw\n11 eyebrow\n12 dance"
    },
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 807, "completion_tokens": 40, "total_tokens": 847}
}

The payload you care about is choices[0].message.content: plain text,
one line per word, never JSON.

PARSING RULES (mandatory — do not use the model's line order blindly)
1. If lines look like "<number> <word>": sort by the number, require
   contiguous 1..N, drop duplicates. The printed number IS the phrase order.
2. Else read "COLUMNS: n" (default 1). The words are in row-major order;
   for n > 1 convert row-major -> column-major using an uneven-grid split
   (first n-(N mod n) columns get ceil(N/n), the rest floor(N/n)).
3. Normalise each token to lowercase a-z, then match to the BIP39 list:
   exact = 1.0, known OCR confusions (0->o, 1->l, 5->s, 8->b) = 0.92,
   Levenshtein 1 for words >= 5 chars, Levenshtein 2 for >= 8 chars.
   Never fuzzy-match words shorter than 5 characters.
4. Validate the BIP39 checksum for 12/15/18/21/24 words. If it fails, try
   the other column counts (2..6) and accept the first that validates.
5. Emit: {phrase, words, count, checksum, confidence, order, reason}.
   If nothing validates, return the full-length candidate with
   checksum=false and reason="checksum fail" — never drop it silently.

ERRORS / RETRY
- HTTP 5xx or timeout: retry twice with 1 s / 4 s backoff.
- Empty content or fewer words than the smallest valid count: retry once at
  max_side=2400 with the same prompt.
- Queueing: this endpoint batches. Keep 16 requests in flight; do not open a
  new connection per image.
- Do not retry receipts/menus/prose unless the first pass found >= 6 BIP39
  words in a row.

ACCEPTANCE TESTS (run these before calling it done)
  numbered 2-column grid -> "1 satoshi ... 12 dance" -> phrase exact,
    checksum valid
  unnumbered 1-column list -> "again empty warm hip fat allow broccoli turn
    finger insane hunt service" -> exact, checksum valid
  photo of a phone screen -> "1 diesel ... 12 evolve" -> exact, checksum valid
  handwriting -> "1 horror ... 12 tackle" -> exact words, checksum false
    (that demo seed is invalid)
  shuffled grid (numbers in random cells) -> sorting by number must recover
    the phrase; file order must NOT.
```

## Captured request/response (real, from this endpoint)

**Request** (image omitted):

```json
{
  "model": "Qwen/Qwen3-VL-8B-Instruct",
  "temperature": 0,
  "max_tokens": 400,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "Extract the seed words..."},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
    ]
  }]
}
```

**Response**:

```json
{
  "id": "chatcmpl-a0834ee19371051c",
  "object": "chat.completion",
  "created": 1794447066,
  "model": "Qwen/Qwen3-VL-8B-Instruct",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant",
      "content": "1 satoshi\n2 film\n3 law\n4 salute\n5 lizard\n6 actual\n7 eight\n8 trust\n9 gas\n10 raw\n11 eyebrow\n12 dance"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 807, "completion_tokens": 40, "total_tokens": 847}
}
```

## Image → text, observed

| input | `choices[0].message.content` |
| --- | --- |
| Nicegram 2-col | `1 satoshi` … `12 dance` |
| white 1-col list | `COLUMNS: 1` + one word per line |
| photo of phone screen | `1 diesel` … `12 evolve` |
| handwritten page | `1. horror` … `12. tackle` |
| shuffled grid | numbers out of visual order; sorted → correct phrase |
| terminal with 24 words inline | words in reading order, stray `1` from a wrapped `l` |

## Minimal client (any project)

```python
import base64, io, requests
from PIL import Image, ImageOps

def transcribe(image: Image.Image) -> str:
    im = ImageOps.exif_transpose(image) or image
    im = im.convert("RGB"); im.thumbnail((1600, 1600))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=90)
    r = requests.post(
        "https://zo0dbb24aajxip-8000.proxy.runpod.net/v1/chat/completions",
        headers={"Authorization": "Bearer <key>"} if KEY else {},
        json={"model": "Qwen/Qwen3-VL-8B-Instruct", "temperature": 0, "max_tokens": 400,
              "messages": [{"role": "user", "content": [
                  {"type": "text", "text": PROMPT},
                  {"type": "image_url", "image_url": {
                      "url": "data:image/jpeg;base64," +
                             base64.b64encode(buf.getvalue()).decode()}}]}]},
        timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]
```

## Security

- Client → Runpod proxy is HTTPS (TLS terminated at the Runpod proxy). Pod → model
  is plaintext inside Runpod. This is transport encryption, **not** end-to-end:
  Runpod can see the image.
- The proxy URL alone is enough to call the endpoint. Start vLLM with
  `--api-key <key>` and send `Authorization: Bearer <key>`.
- Add `--disable-log-requests` to vLLM so prompts/images are not written to logs.
- Images are processed in RAM; the pod has no volume mounted, so nothing is kept
  on disk by the service.
- For true provider-blind E2E the model must run on hardware you control (the local
  5090) or inside a confidential-computing GPU.
