import { useEffect, useState } from "react";
import { accountUrl, fileUrl, getJson, thumbUrl } from "./api.js";
import Lightbox from "./Lightbox.jsx";

/* Images (and other files) inside a note.
 *
 * The exporter writes Notes/html/<title>.html plus Notes/html/assets/…; the
 * note index records which files belong to which note.  A note with a
 * screenshot, a receipt or a photo now shows it here, and clicking one opens
 * the full picture. */

const IMAGE = /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/i;

export default function NoteImages({ accountId, txtPath, compact = false }) {
  const [entry, setEntry] = useState(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    if (!accountId || !txtPath) return undefined;
    const id = txtPath.split("/").pop().split("_")[0];
    let alive = true;
    setEntry(null);
    setMissing(false);
    getJson(fileUrl(accountId, "Notes/index.json"))
      .then((data) => {
        if (!alive) return;
        const found = data && data[id];
        if (found) setEntry(found);
        else setMissing(true);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [accountId, txtPath]);

  if (missing || !entry) return null;
  const images = (entry.images || []).filter((rel) => IMAGE.test(rel));
  const others = (entry.images || []).filter((rel) => !IMAGE.test(rel));
  if (!images.length && !others.length && !entry.html) return null;

  const items = images.map((rel) => ({ name: rel.split("/").pop(), path: rel, accountId }));

  return (
    <div className={compact ? "mt-2" : "mt-3 border-t border-[#f0f0f2] pt-3"}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[#6e6e73]">
          {images.length ? `${images.length} image${images.length > 1 ? "s" : ""} in this note` : "Attachments"}
        </span>
        {entry.html ? (
          <a
            href={accountUrl(accountId, "raw", {}) + `/Notes/html/${encodeURIComponent(entry.html.split("/").pop())}`}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-[#0066cc] hover:underline"
          >
            Open note (HTML) ↗
          </a>
        ) : null}
      </div>
      {images.length ? (
        <div className="flex flex-wrap gap-2">
          {images.map((rel, index) => (
            <button
              key={rel}
              type="button"
              onClick={() => setOpen(index)}
              className="group relative h-24 w-24 overflow-hidden rounded-[8px] border border-[#e5e5ea] bg-[#f5f5f7]"
              title={rel.split("/").pop()}
            >
              <img
                src={thumbUrl(accountId, rel)}
                alt={rel.split("/").pop()}
                loading="lazy"
                className="h-full w-full object-cover transition group-hover:scale-[1.03]"
              />
            </button>
          ))}
        </div>
      ) : null}
      {others.length ? (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {others.map((rel) => (
            <a
              key={rel}
              href={fileUrl(accountId, rel, true)}
              className="rounded-full border border-[#d2d2d7] px-2 py-0.5 text-[11px] text-[#424245] hover:bg-[#fafafa]"
            >
              {rel.split("/").pop()} ↓
            </a>
          ))}
        </div>
      ) : null}
      {open !== null ? (
        <Lightbox
          accountId={accountId}
          items={items}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
