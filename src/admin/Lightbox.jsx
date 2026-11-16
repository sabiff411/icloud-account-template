import { useEffect, useState } from "react";
import RetryImage from "./RetryImage.jsx";
import { fileUrl, bytes, thumbUrl, previewUrl } from "./api.js";
import { displayName } from "./ui.jsx";

/* Full-size viewer. Arrows at the edges are deliberately large; arrows keys
 * are delegated to the parent, which can cross into the next gallery page. */
export default function Lightbox({
  accountId,
  items,
  index,
  setIndex,
  onPrev,
  onNext,
  onClose,
  pageLabel = "",
}) {
  const item = items[index];
  const [videoFallback, setVideoFallback] = useState(false);
  useEffect(() => setVideoFallback(false), [item?.path]);
  const count = items.length;
  const prev =
    onPrev ?? (() => setIndex?.((index - 1 + count) % count));
  const next =
    onNext ?? (() => setIndex?.((index + 1) % count));
  // Library pages mix accounts; the item carries its own owner.  Computed
  // before the effects so the neighbour prefetch can depend on it.
  const owner = item?.accountId ?? accountId;

  /* Warm the neighbours.  A Drive photo can be 20 MB and its signed S4 URL
   * changes after a few minutes; loading it once here means ← / → and coming
   * back to a photo is instant instead of "from scratch". */
  useEffect(() => {
    if (!item) return;
    for (const offset of [1, -1, 2, -2]) {
      const other = items[index + offset];
      if (!other) continue;
      const raw = /\.(heic|heif|tiff?|bmp|dng|nef|cr2|cr3|arw|orf|rw2|raf|srw|psd)$/i.test(
        other.name || ""
      );
      const full = raw
        ? previewUrl(owner, other.path, other.mtime)
        : fileUrl(owner, other.path, false, other.mtime);
      // Skip multi-megabyte originals beyond the immediate neighbours.
      if (raw || Math.abs(offset) === 1 || Number(other.size) < 25_000_000) {
        const image = new Image();
        image.src = full;
      }
      const thumb = new Image();
      thumb.src = thumbUrl(owner, other.path, other.mtime);
    }
  }, [owner, item?.path, index, items]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        prev();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose]);

  if (!item) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[rgba(20,20,22,0.94)] text-white backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-label={displayName(item.name)}
      onClick={onClose}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
        <div className="min-w-0">
          <div className="truncate font-medium">{displayName(item.name)}</div>
          <div className="text-[11px] text-white/60">
            {index + 1} / {count}
            {pageLabel ? ` · ${pageLabel}` : ""} · {bytes(item.size)}
            {item.area ? ` · ${item.area}` : ""}
            {/\.(mov|mp4|m4v|3gp)$/i.test(item.name) ? " · VIDEO" : ""}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {(() => {
            const direct = item.video
              ? item.playSrc || item.src
              : /\.(heic|heif)$/i.test(item.name)
                ? item.previewSrc || item.src
                : item.src;
            return direct && direct.startsWith("http") ? (
              <a
                href={direct}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="rounded-full bg-white/20 px-3 py-1.5 hover:bg-white/25"
                title="Open the signed S4 object"
              >
                S3
              </a>
            ) : null;
          })()}
          <a
            href={fileUrl(owner, item.path, true)}
            onClick={(event) => event.stopPropagation()}
            className="rounded-full bg-white/20 px-3 py-1.5 hover:bg-white/25"
          >
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/20 px-3 py-1.5 hover:bg-white/25"
          >
            Close
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 sm:px-24">
        <button
          type="button"
          aria-label="Previous photo"
          onClick={(event) => {
            event.stopPropagation();
            prev();
          }}
          className="absolute left-3 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-[30px] leading-none text-white hover:bg-white/30 active:scale-95 sm:left-6 sm:h-14 sm:w-14"
        >
          ‹
        </button>
        {item.video ? (
          <video
            key={item.path}
            src={
              videoFallback
                ? fileUrl(owner, item.play || item.path, false, item.mtime)
                : item.playSrc || fileUrl(owner, item.play || item.path, false, item.mtime)
            }
            onError={() => setVideoFallback(true)}
            poster={item.thumbSrc || thumbUrl(owner, item.path)}
            controls
            autoPlay
            muted
            playsInline
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-[10px] shadow-2xl"
          />
        ) : (
          (() => {
            // Formats the browser cannot draw: HEIC and the print/scan
            // formats (TIFF, BMP, camera raw) all go through the JPEG
            // preview route instead of the original bytes.
            const heic = /\.(heic|heif|tiff?|bmp|dng|nef|cr2|cr3|arw|orf|rw2|raf|srw|psd)$/i.test(
              item.name
            );
            // HEIC/HEIF cannot be decoded by Chrome/Safari-on-macOS-image-tags,
            // so ask the server for (or generate once) a large JPEG.  The
            // 512 px grid thumbnail was the only fallback before, which made
            // phone photos unreadable in this viewer.
            // Prefer the direct S4 object.  The URL is stable for five
            // minutes (s4.js rounds the signing time), so the browser can
            // cache the object; the local route is the fallback after a
            // prune or an expired signature.
            const localSrc = heic
              ? previewUrl(owner, item.path, item.mtime)
              : fileUrl(owner, item.path, false, item.mtime);
            // Always the stable panel route: /preview for raw formats and
            // /file?…&v=mtime for the rest.  The signed S4 URL changes every
            // few minutes, which is why going back to a photo re-downloaded it.
            const src = localSrc;
            // The 640 px grid thumb is already on disk or in the bucket, so it
            // paints instantly.  Show it blurred behind the full preview: a
            // HEIC that has to be built from S4 then never looks like a blank
            // frame, even on the first click.
            const poster = item.thumbSrc || thumbUrl(owner, item.path);
            const backdrop = poster ? (
              <img
                key={`poster-${item.path}`}
                src={poster}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 m-auto max-h-[92%] max-w-[92%] rounded-[10px] object-contain opacity-60 blur-2xl"
              />
            ) : null;
            if (!src) {
              return (
                <>
                  {backdrop}
                  <div className="relative rounded-[10px] bg-white/10 px-6 py-10 text-center text-[13px] text-white/70">
                    Loading the HEIC preview…
                  </div>
                </>
              );
            }
            const url =
              src.startsWith("http") || src.startsWith("/api/")
                ? src
                : fileUrl(owner, src);
            return (
              <>
                {backdrop}
                <RetryImage
                  key={item.path}
                  src={url}
                  fallbackSrc={localSrc}
                  alt={displayName(item.name)}
                  decoding="async"
                  onClick={(event) => event.stopPropagation()}
                  className="relative max-h-full max-w-full rounded-[10px] object-contain shadow-2xl"
                />
              </>
            );
          })()
        )}
        <button
          type="button"
          aria-label="Next photo"
          onClick={(event) => {
            event.stopPropagation();
            next();
          }}
          className="absolute right-3 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-[30px] leading-none text-white hover:bg-white/30 active:scale-95 sm:right-6 sm:h-14 sm:w-14"
        >
          ›
        </button>
      </div>
      <div className="px-5 py-2 text-center text-[11px] text-white/50">
        ← → previous / next{item.email ? ` · ${item.email}` : ""}
        {pageLabel ? " (crosses pages at the end)" : ""} · Esc to close
      </div>
    </div>
  );
}
