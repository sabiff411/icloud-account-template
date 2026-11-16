#!/bin/sh
# Continuous VLM labelling loop (runs on the VPS as the icloud3 user).
#
# `--phase all` matters: `--phase local` only sees files still on disk.
# The prune moves an original to S4 as soon as the download finishes, so a
# photo that the loop missed once would never be labelled again.  `all` also
# walks the S4 manifests and labels the pruned photos from their 640 px
# thumb (or the object itself when the thumb is missing).
#
# VISION_API_KEY is supplied by the launcher's environment; it is never
# written into this file.
export HOME=/home/icloud3
PY=/opt/icloud3-venv/bin/python
while true; do
  $PY -u /opt/icloud3/python/classify_all.py --phase all \
      --concurrency 96 --decode-workers 4 >> /opt/icloud3/classify/live.log 2>&1
  $PY /opt/icloud3/python/vlm_index.py >> /opt/icloud3/classify/index.log 2>&1
  $PY -u /opt/icloud3/python/audit_coverage.py >> /opt/icloud3/classify/coverage.log 2>&1
  sleep 600
done
