"""Generate one cached JPEG thumbnail with Pillow.

Called by server/admin/thumbs.js as a short-lived process; the result is
written under Scan/thumbs/<relative path>.jpg and reused afterwards.
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True

try:  # iPhone photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:
    pass


VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp"}

REMOTE_PREFIXES = ("http://", "https://")


def suffix_of(text: str) -> str:
    clean = text.split("?", 1)[0].split("#", 1)[0]
    return Path(clean).suffix.lower()


def open_image(source: str):
    """Open a local path or a signed URL (pruned accounts live on S4)."""
    if source.startswith(REMOTE_PREFIXES):
        with urllib.request.urlopen(source, timeout=45) as response:
            return Image.open(io.BytesIO(response.read()))
    return Image.open(source)


def video_frame(source: Path, target: Path, size: int) -> int:
    """One JPEG frame for a video, so the grid shows what the clip is."""
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as error:  # noqa: BLE001
        print(type(error).__name__, file=sys.stderr)
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part.jpg")
    for seek in ("1", "0"):
        command = [
            ffmpeg, "-y", "-loglevel", "error", "-ss", seek, "-i", str(source),
            "-frames:v", "1", "-vf", f"scale={size}:-2", "-q:v", "4", str(temporary),
        ]
        try:
            subprocess.run(command, check=True, timeout=25)
        except Exception:
            continue
        if temporary.exists() and temporary.stat().st_size > 0:
            os.replace(temporary, target)
            return 0
    return 1


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    source = sys.argv[1]
    target = Path(sys.argv[2])
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 512
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 82
    if suffix_of(source) in VIDEO_EXT:
        return video_frame(source, target, size)
    try:
        with open_image(source) as image:
            upright = ImageOps.exif_transpose(image)
            if upright is not None:
                image = upright
            image = image.convert("RGB")
            # thumbnail() only ever shrinks: a 2 MP photo stays at full
            # resolution, a 48 MP one is capped at `size` on its long edge.
            image.thumbnail((size, size))
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".part")
            image.save(temporary, "JPEG", quality=quality, optimize=True)
            os.replace(temporary, target)
        return 0
    except Exception as error:  # noqa: BLE001 - one bad photo must not fail a page
        print(type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
