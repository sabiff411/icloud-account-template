import { useEffect, useRef } from "react";

/* Right-click menu for a photo tile: checked / not checked / good, favourite,
 * and the wallet balance bucket.  One small fixed-position panel; it closes on
 * Escape, on a click outside, or after picking an option. */

const MARK_ITEMS = [
  ["checked", "✓", "Checked"],
  ["unchecked", "○", "Not checked"],
  ["good", "★", "Good"],
];
const BALANCE_ITEMS = [
  ["0", "$0", "wallet is empty"],
  ["1k", "$1k", "about one thousand"],
  ["10k", "$10k", "about ten thousand"],
  ["100k", "$100k", "a hundred thousand or more"],
];

export default function ImageMenu({ x, y, entry, onPick, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const click = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    const key = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", click);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", click);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Keep the panel inside the viewport.
  const width = 214;
  const height = 330;
  const left = Math.min(Math.max(8, x), window.innerWidth - width - 8);
  const top = Math.min(Math.max(8, y), window.innerHeight - height - 8);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width }}
      className="fixed z-[70] overflow-hidden rounded-[10px] border border-[#d2d2d7] bg-white py-1 text-[12px] shadow-[0_10px_40px_rgba(0,0,0,0.18)]"
    >
      {MARK_ITEMS.map(([value, glyph, label]) => (
        <button
          key={value}
          type="button"
          role="menuitem"
          onClick={() => onPick({ mark: entry?.mark === value ? "" : value })}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f5f5f7] ${
            entry?.mark === value ? "font-semibold text-[#0071e3]" : "text-[#1d1d1f]"
          }`}
        >
          <span className="w-4 text-center">{glyph}</span>
          {label}
        </button>
      ))}
      <div className="my-1 border-t border-[#f0f0f2]" />
      <button
        type="button"
        role="menuitem"
        onClick={() => onPick({ favorite: !entry?.favorite })}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f5f5f7] ${
          entry?.favorite ? "font-semibold text-[#f0b429]" : "text-[#1d1d1f]"
        }`}
      >
        <span className="w-4 text-center">{entry?.favorite ? "★" : "☆"}</span>
        {entry?.favorite ? "Remove favourite" : "Favourite"}
      </button>
      <div className="my-1 border-t border-[#f0f0f2]" />
      <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[#9a9aa0]">
        Balance
      </div>
      {BALANCE_ITEMS.map(([value, label, hint]) => (
        <button
          key={value}
          type="button"
          role="menuitem"
          title={hint}
          onClick={() => onPick({ balance: entry?.balance === value ? "" : value })}
          className={`flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[#f5f5f7] ${
            entry?.balance === value ? "font-semibold text-[#30a14e]" : "text-[#1d1d1f]"
          }`}
        >
          <span>{label}</span>
          {entry?.balance === value ? <span className="text-[10px]">current</span> : null}
        </button>
      ))}
      {entry ? (
        <>
          <div className="my-1 border-t border-[#f0f0f2]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => onPick({ clear: true })}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[#c4000a] hover:bg-[#fff2f2]"
          >
            <span className="w-4 text-center">×</span>Clear all tags
          </button>
        </>
      ) : null}
    </div>
  );
}
