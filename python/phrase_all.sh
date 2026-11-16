#!/bin/sh
# Transcribe seed phrases for every account once the classifier has finished.
#
# The label only says "worth reading"; this asks the vision model for the words
# and keeps a phrase only when the BIP39 checksum passes.  Resumable: photos
# already read are skipped, so a kill or a rerun costs nothing.
export HOME=/home/icloud3
PY=/opt/icloud3-venv/bin/python

echo "$(date '+%F %T') waiting for the classifier to finish"
while pgrep -f "classify_all.py --phase all" >/dev/null 2>&1; do sleep 60; done
echo "$(date '+%F %T') classifier done, starting phrase pass"

ACCOUNTS=$(/opt/icloud3-venv/bin/python - <<'PY'
import json
from pathlib import Path
seen = set()
for line in Path('/opt/icloud3/classify/results.jsonl').open(errors='ignore'):
    try:
        row = json.loads(line)
    except Exception:
        continue
    rel = row.get('rel_path') or ''
    if '/' in rel:
        seen.add(rel.split('/', 1)[0])
print('\n'.join(sorted(seen)))
PY
)

for EMAIL in $ACCOUNTS; do
    echo "$(date '+%F %T') $EMAIL"
    $PY -u /opt/icloud3/python/read_phrase.py \
        --account "$EMAIL" --workers 16 --side 1024
    # merge whatever passed the checksum into the panel's Seeds data
    $PY - <<PY
import json, sys
from pathlib import Path
sys.path.insert(0, '/opt/icloud3/python')
import classify_all as ca
from scan_vlm import merge_findings
from worker import scan

email = "$EMAIL"
root = ca.account_roots().get(email)
if root:
    path = ca.OUT_DIR / f"phrase-{email.split('@')[0]}.jsonl"
    items = []
    if path.is_file():
        for line in path.read_text(errors='ignore').splitlines():
            try:
                row = json.loads(line)
            except Exception:
                continue
            if not row.get('checksum'):
                continue
            items.append({
                "file": row['rel'], "area": scan.area_for(row['rel']),
                "name": Path(row['rel']).name, "phrase": row['phrase'],
                "words": row['words'], "tier": scan.tier_for(row['words']),
                "checksum": True, "spam": scan.is_spam_phrase(row['phrase']),
                "source": "vlm-phrase", "offset": 0,
            })
    if items:
        merge_findings(root / 'Scan', items)
PY
done
echo "$(date '+%F %T') phrase pass finished"
