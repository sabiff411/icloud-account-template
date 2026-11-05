import { useEffect } from "react";
import { fileUrl, bytes } from "./api.js";
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
  const count = items.length;
  const prev =
    onPrev ?? (() => setIndex?.((index - 1 + count) % count));
  const next =
    onNext ?? (() => setIndex?.((index + 1) % count));

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
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href={fileUrl(accountId, item.path, true)}
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
            src={fileUrl(accountId, item.path)}
            controls
            autoPlay
            muted
            playsInline
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-[10px] shadow-2xl"
          />
        ) : (
          <img
            key={item.path}
            src={fileUrl(accountId, item.path)}
            alt={displayName(item.name)}
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-[10px] object-contain shadow-2xl"
          />
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
        ← → previous / next{pageLabel ? " (crosses pages at the end)" : ""} · Esc to close
      </div>
    </div>
  );
}
