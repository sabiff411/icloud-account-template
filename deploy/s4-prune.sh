#!/bin/sh
# Free local space for accounts that are provably complete on S4.
#
# Two rules keep the panel honest:
#   * never prune an account that is still being downloaded (its new files
#     would vanish before the upload pass sees them);
#   * after a successful move, rebuild the listing from the bucket, so the
#     panel shows exactly the objects that exist (no NoSuchKey tiles).
PATH=/usr/local/bin:/home/pc/.local/bin:/home/pc/.opencode/bin:/home/pc/.nvm/versions/node/v24.21.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PY=/opt/icloud3-venv/bin/python
account=$1
src=$(readlink -f "/opt/icloud3/export/$account")
[ -d "$src" ] || exit 0

# Still downloading? An open temp batch, or an exporter whose command line
# names this account, means yes.
if ls "$src"/zips/tmp-* >/dev/null 2>&1; then
  echo "$(date '+%F %T') $account SKIP (batch running)" >> /root/s4-prune.log
  exit 0
fi
if pgrep -af "bulk_images\.py" 2>/dev/null | grep -qF -- "$account"; then
  echo "$(date '+%F %T') $account SKIP (export running)" >> /root/s4-prune.log
  exit 0
fi

before=$(du -sm "$src" | awk '{print $1}')

check=$(rclone check "$src" "s4:icld/$account" --filter-from /root/prune.filter --size-only --one-way --checkers 8 2>&1 | tail -3)
case "$check" in
  *"0 differences"*) ;;
  *) echo "$(date '+%F %T') $account SKIP (not complete)" >> /root/s4-prune.log; exit 0 ;;
esac

# Build the missing thumbnails first: they live in Scan/thumbs, which is not
# pruned, so every tile stays a static JPEG after the originals move to S4.
nice -n 10 $PY /opt/icloud3/python/warm_thumbs.py --emails "$account" --workers 6 >/dev/null 2>&1

attempt=1
while [ $attempt -le 2 ]; do
  rclone move "$src" "s4:icld/$account" --filter-from /root/prune.filter --delete-empty-src-dirs --transfers 16 --checkers 8 --s3-upload-concurrency 1 --s3-upload-cutoff 64M --retries 5 --low-level-retries 20 --retries-sleep 10s --stats 0 --log-file "/root/prune-$account.log" --log-level ERROR
  rc=$?
  [ $rc = 0 ] && break
  attempt=$((attempt + 1))
  sleep 15
done

after=$(du -sm "$src" | awk '{print $1}')

# The listing must describe the bucket, not the disk we just emptied.
if [ "$before" != "$after" ]; then
  rm -f "$src/Scan/s4-manifest.json"
  $PY /opt/icloud3/python/s4_manifest_from_bucket.py "$account" >/dev/null 2>&1
fi

echo "$(date '+%F %T') $account rc=$rc ${before}MB -> ${after}MB" >> /root/s4-prune.log
if [ "$rc" = 0 ]; then
  echo "{\"at\":\"$(date -u +%FT%TZ)\"}" > "$src/Scan/s4-complete.json"
else
  echo "  last errors: $(tail -2 /root/prune-$account.log 2>/dev/null | tr '\n' ' ' | cut -c1-160)" >> /root/s4-prune.log
fi
