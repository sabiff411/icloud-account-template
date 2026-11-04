import { useEffect } from "react";
import { fileUrl, bytes } from "./api.js";
import { displayName } from "./ui.jsx";

export default function Lightbox({ accountId, items, index, setIndex, onClose }) {
  const item = items[index];

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") setIndex((index - 1 + items.length) % items.length);
      if (event.key === "ArrowRight") setIndex((index + 1) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, setIndex]);

  if (!item) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[rgba(20,20,22,0.92)] text-white backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={onClose}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
        <div className="min-w-0">
          <div className="truncate font-medium">{displayName(item.name)}</div>
          <div className="text-[11px] text-white/60">
            {index + 1} / {items.length} · {bytes(item.size)}
            {item.path ? ` · ${item.path}` : ""}
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

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14">
        <button
          type="button"
          aria-label="Previous"
          onClick={(event) => {
            event.stopPropagation();
            setIndex((index - 1 + items.length) % items.length);
          }}
          className="absolute left-2 rounded-full bg-white/20 px-3 py-2 text-[18px] hover:bg-white/25"
        >
          ‹
        </button>
        <img
          key={item.path}
          src={fileUrl(accountId, item.path)}
          alt={item.name}
          onClick={(event) => event.stopPropagation()}
          className="max-h-full max-w-full rounded-[10px] object-contain shadow-2xl"
        />
        <button
          type="button"
          aria-label="Next"
          onClick={(event) => {
            event.stopPropagation();
            setIndex((index + 1) % items.length);
          }}
          className="absolute right-2 rounded-full bg-white/20 px-3 py-2 text-[18px] hover:bg-white/25"
        >
          ›
        </button>
      </div>
      <div className="px-5 py-2 text-center text-[11px] text-white/50">
        ← → to move · Esc to close
      </div>
    </div>
  );
}
