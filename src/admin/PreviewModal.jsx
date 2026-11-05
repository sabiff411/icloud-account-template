import { useEffect, useState } from "react";
import { accountUrl, fileUrl, bytes, getJson } from "./api.js";
import { displayName } from "./ui.jsx";

/* Read a Drive file in place: text, image or video, never a forced download. */
export default function PreviewModal({ accountId, item, onClose }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    getJson(accountUrl(accountId, "file", { path: item.path, preview: 1 }))
      .then((result) => {
        if (alive) setState({ loading: false, ...result });
      })
      .catch((failure) => {
        if (alive) setState({ loading: false, kind: "other", error: failure.message });
      });
    return () => {
      alive = false;
    };
  }, [accountId, item.path]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[rgba(20,20,22,0.92)] text-white backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-label={displayName(item.name)}
      onClick={onClose}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
        <div className="min-w-0">
          <div className="truncate font-medium">{displayName(item.name)}</div>
          <div className="text-[11px] text-white/60">
            {bytes(item.size)}
            {state.kind === "text" && state.truncated ? " · first 200 KB" : ""}
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

      <div
        className="mx-auto flex min-h-0 w-full max-w-[1100px] flex-1 flex-col overflow-hidden px-4 pb-6"
        onClick={(event) => event.stopPropagation()}
      >
        {state.loading ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-white/60">Loading…</div>
        ) : state.kind === "text" ? (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[#111113] p-4 text-[12px] leading-5 text-[#e8e8ed]">
            {state.text || "(empty file)"}
          </pre>
        ) : state.kind === "image" ? (
          <img
            src={fileUrl(accountId, item.path)}
            alt={displayName(item.name)}
            className="max-h-full max-w-full self-center rounded-[10px] object-contain shadow-2xl"
          />
        ) : state.kind === "video" ? (
          <video
            src={fileUrl(accountId, item.path)}
            controls
            autoPlay
            className="max-h-full max-w-full self-center rounded-[10px]"
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[13px] text-white/70">
            <div>No inline preview for this type{state.type ? ` (${state.type})` : ""}.</div>
            {state.error ? <div className="text-white/50">{state.error}</div> : null}
            <a
              href={fileUrl(accountId, item.path, true)}
              className="mt-2 rounded-full bg-white/20 px-3 py-1.5 text-white hover:bg-white/25"
            >
              Download
            </a>
          </div>
        )}
      </div>
      <div className="px-5 py-2 text-center text-[11px] text-white/50">Esc to close</div>
    </div>
  );
}
