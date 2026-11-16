import { useEffect, useState } from "react";

/* One seed per line: phrase, checksum, height, source.  Shared by the
 * per-account Seeds tab and the cross-account All/Seeds view. */
export default function CopyModal({ title = "Copy all seeds", text, count, onClose }) {
  const [copied, setCopied] = useState("");

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-[760px] flex-col rounded-[14px] bg-white p-4 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold">{title}</h3>
            <p className="text-[11px] text-[#6e6e73]">
              One seed per line, no duplicates · phrase, checksum, height, source
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                navigator.clipboard?.writeText(text).then(
                  () => setCopied(`Copied ${count} seeds`),
                  () => setCopied("Copy failed — select the text")
                )
              }
              className="h-8 rounded-full bg-[#0071e3] px-4 text-[12px] font-medium text-white"
            >
              Copy {count}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-full border border-[#d2d2d7] px-3 text-[12px]"
            >
              Close
            </button>
          </div>
        </div>
        {copied ? <p className="mt-2 text-[11px] text-[#1d7a3a]">{copied}</p> : null}
        <textarea
          readOnly
          value={text}
          autoFocus
          onFocus={(event) => event.target.select()}
          className="mt-3 min-h-[320px] flex-1 resize-none rounded-[9px] border border-[#d2d2d7] bg-[#fafafa] p-3 font-mono text-[11px] leading-5 text-[#1d1d1f]"
        />
      </div>
    </div>
  );
}
