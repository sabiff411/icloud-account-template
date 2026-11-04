import { useState } from "react";
import { accountUrl, fileUrl, getJson } from "./api.js";
import { Badge, Empty, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif)$/i;

function Section({ title, count, children }) {
  if (!count) return null;
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
        {title} ({count})
      </h3>
      {children}
    </section>
  );
}

export default function SearchTab({ account }) {
  const [text, setText] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);

  async function run(event) {
    event?.preventDefault();
    const q = text.trim();
    if (!q) return;
    setLoading(true);
    setError("");
    try {
      const result = await getJson(accountUrl(account.id, "search", { q, pageSize: 60 }));
      setData(result);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }

  const images = data?.images ?? [];

  return (
    <div>
      <form onSubmit={run} className="flex flex-wrap items-center gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search notes and text inside images (OCR), filenames, seed phrases…"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-[#d2d2d7] bg-white px-3 text-[13px] outline-none focus:border-[#0071e3]"
        />
        <button
          type="submit"
          disabled={!text.trim() || loading}
          className="h-9 rounded-[9px] bg-[#0071e3] px-4 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      <p className="mt-2 text-[11px] text-[#6e6e73]">
        Image results are shown as pictures; OCR text is used only to match. Run Scan on the
        account if no image matches appear.
      </p>

      {error ? (
        <p className="mt-3 rounded-[9px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
      ) : null}
      {loading ? <Spinner label="Searching the export" /> : null}

      {!loading && data ? (
        <div>
          <Section title="Images" count={images.length}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
              {images.map((item, index) => (
                <button
                  key={`${item.path}-${index}`}
                  type="button"
                  onClick={() => setOpen(index)}
                  className="overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white text-left hover:border-[#0071e3]"
                >
                  <div className="aspect-square bg-[#f5f5f7]">
                    <img
                      loading="lazy"
                      src={fileUrl(account.id, item.thumb || item.path)}
                      alt={item.name}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="p-2">
                    <div className="truncate text-[11px] font-medium">{displayName(item.name)}</div>
                    {item.snippet ? (
                      <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-[#6e6e73]">
                        {item.snippet}
                      </div>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Notes" count={data.notes?.length || 0}>
            <div className="grid gap-2 lg:grid-cols-2">
              {(data.notes || []).map((note, index) => (
                <div key={`${note.path}-${index}`} className="rounded-[10px] border border-[#e5e5ea] bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium">{displayName(note.name)}</span>
                    <a
                      href={fileUrl(account.id, note.path, true)}
                      className="shrink-0 text-[11px] text-[#0066cc] hover:underline"
                    >
                      Download
                    </a>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-[#6e6e73]">{note.snippet}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Seed phrases" count={data.seeds?.length || 0}>
            <div className="grid gap-2 lg:grid-cols-2">
              {(data.seeds || []).map((seed, index) => (
                <div key={`${seed.phrase}-${index}`} className="rounded-[10px] border border-[#e5e5ea] bg-white p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={seed.tier === "high" ? "red" : seed.tier === "medium" ? "blue" : "yellow"}>
                      {seed.words} words
                    </Badge>
                    {seed.checksum ? <Badge tone="green">checksum valid</Badge> : null}
                    <span className="truncate text-[10px] text-[#6e6e73]">{seed.name}</span>
                  </div>
                  <p className="mt-1 break-words font-mono text-[11px] leading-4">{seed.phrase}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Files" count={data.files?.length || 0}>
            <div className="overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white">
              {(data.files || []).map((file, index) => (
                <div key={`${file.path}-${index}`} className="flex items-center gap-2 border-b border-[#f4f4f6] px-3 py-2 last:border-0">
                  <span className="text-[14px]">📄</span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{displayName(file.name)}</span>
                  <a
                    href={fileUrl(account.id, file.path, true)}
                    className="text-[11px] text-[#0066cc] hover:underline"
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          </Section>

          {!images.length && !data.notes?.length && !data.seeds?.length && !data.files?.length ? (
            <div className="mt-4">
              <Empty title="Nothing matched">
                Try a different word. If the account has not been scanned, run Scan OCR + seeds so
                text inside images becomes searchable.
              </Empty>
            </div>
          ) : null}
        </div>
      ) : null}

      {open !== null && images[open] ? (
        <Lightbox
          accountId={account.id}
          items={images.map((item) => ({ path: item.path, name: item.name, thumb: item.thumb }))}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
