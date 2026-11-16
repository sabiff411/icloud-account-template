# Running the scanner on a VPS (not the desktop)

The VPS is only the **client/orchestrator**. The GPU work happens on the Runpod
pods. No CUDA, no model, no Docker on the VPS.

## What the VPS needs

| item | minimum | comfortable |
| --- | --- | --- |
| CPU | 4 vCPU | 8 vCPU (image decode/resize/encode is CPU-bound) |
| RAM | 8 GB | 16 GB |
| Disk | corpus + 20 GB | corpus + 100 GB |
| Network | 100 Mbit | 1 Gbit |
| OS | Ubuntu 22.04/24.04 | same |
| Python | 3.11 or 3.12 | 3.12 |
| GPU | none | none |

Bandwidth for 300k images at 1024 px: ~150 KB/request → **~45 GB outbound** total.
Inbound: none. Open ports: none (outbound HTTPS to `*.proxy.runpod.net` only).

## What must be on it

1. The repo (`python/worker/…`) and the image corpus (or a mount to it).
2. Python deps:

```bash
python3 -m venv .venv
.venv/bin/pip install requests pillow pillow-heif numpy rapidfuzz
# plus the project's own worker requirements
```

3. Environment (no secrets in code):

```bash
export SCAN_VLM_URLS="https://pod1-8000.proxy.runpod.net/v1,https://pod2-8000.proxy.runpod.net/v1"
export SCAN_VLM_MODEL=ocr
export SCAN_VLM_KEY=<the --api-key you started vLLM with>
export SCAN_VLM_MAX_SIDE=1024
export SCAN_VLM_CONCURRENCY_PER_POD=8
export SCAN_OCR_BACKEND=vlm
export RUNPOD_API_KEY=<only if the VPS creates/stops pods itself>
```

4. Writable output dirs: `Scan/ocr`, `Scan/vlm`, `Scan/findings.json`, `Scan/thumbs`.

## What it does NOT need

- No Runpod GPU on the VPS, no vLLM, no CUDA driver.
- No inbound firewall rules.
- No SSH into the pods (the HTTP endpoint is enough).
- No model download.

## systemd unit (survives disconnects)

```ini
[Unit]
Description=BIP39 scanner
After=network-online.target

[Service]
WorkingDirectory=/opt/scanner
EnvironmentFile=/opt/scanner/.env
ExecStart=/opt/scanner/.venv/bin/python python/scan_vlm.py --workers 8
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now scanner
journalctl -u scanner -f
```

## Corpus location — pick one

| where | trade-off |
| --- | --- |
| On the VPS disk | simplest; you upload 150–300 GB once |
| On the desktop, client runs there | zero upload, but the desktop must stay on |
| S3 / Runpod network volume | VPS streams images; no local copy |

If the corpus already lives on the desktop, running the client there is the least
work — the VPS buys uptime and bandwidth, not speed.

## Sizing check

- Encode cost: ~50 ms/image single-thread. 8 threads ≈ 60–100 img/s, enough to
  feed 10 pods at ~2 img/s each (20 img/s).
- A 4 vCPU VPS handles 4–6 pods comfortably; 10 pods want 8 vCPU.
- Output is tiny: OCR text + JSON ≈ 2–5 KB/image ≈ 1.5 GB for 300k.
