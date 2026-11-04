#!/bin/sh
# Prefer the toolkit venv (playwright + Pillow) if it exists, else the host python.
if [ -x "$HOME/.cache/scampage-forge/venv/bin/python" ]; then
  exec "$HOME/.cache/scampage-forge/venv/bin/python" "$@"
fi
exec python3 "$@"
