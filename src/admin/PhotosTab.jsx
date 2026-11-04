import { useEffect, useState } from "react";
import { accountUrl, fileUrl, bytes } from "./api.js";
import { getJson } from "./api.js";
import { Empty, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";

const BASE_AREAS = ["Library", "Hidden", "Recently Deleted"];

export default function PhotosTab({ account }) {
  const [areas, setAreas] = useState(BASE_AREAS);
  const [area, setArea] = useState("Library");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1, page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let alive = true;
    getJson(accountUrl(account.id, "tree", { path: "Photos" }))
      .then((result) => {
        if (!alive) return;
        const names = (result.dirs || []).map((dir) => dir.name);
        setAreas([...new Set([...BASE_AREAS, ...names])]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [account.id]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    setPage(1);
  }, [area, query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    getJson(accountUrl(account.id, "gallery", { area, q: query, page, pageSize: 60 }))
      .then((result) => {
        if (!alive) return;
        setData(result);
        setLoading(false);
      })
      .catch((failure) => {
        if (!alive) return;
        setError(failure.message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [account.id, area, query, page]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {areas.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setArea(name)}
              className={`h-8 rounded-full px-3 text-[12px] font-medium ${
                area === name
                  ? "bg-[#1d1d1f] text-white"
                  : "border border-[#d2d2d7] bg-white text-[#424245] hover:bg-[#fafafa]"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Filter by filename…"
            className="h-8 w-[230px] rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <span className="text-[12px] text-[#6e6e73]">
            {data.total ? `${(data.page - 1) * 60 + 1}–${Math.min(data.page * 60, data.total)} of ${data.total.toLocaleString()}` : "0"}
          </span>
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded-[9px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
      ) : null}

      {loading ? (
        <Spinner label="Loading photos" />
      ) : data.items.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {data.items.map((item, index) => (
            <button
              key={item.path}
              type="button"
              onClick={() => setOpen(index)}
              className="group overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white text-left transition hover:border-[#0071e3] hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
            >
              <div className="relative aspect-square bg-[#f5f5f7]">
                {item.video && !item.thumb ? (
                  <div className="flex h-full items-center justify-center text-[28px]">🎬</div>
                ) : (
                  <img
                    loading="lazy"
                    src={fileUrl(account.id, item.thumb || item.path)}
                    alt={item.name}
                    className="h-full w-full object-cover"
                  />
                )}
                {item.video ? (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] text-white">
                    video
                  </span>
                ) : null}
              </div>
              <div className="px-2 py-1.5">
                <div className="truncate text-[11px] font-medium text-[#1d1d1f]" title={item.name}>{displayName(item.name)}</div>
                <div className="text-[10px] text-[#6e6e73]">{bytes(item.size)}</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-4">
          <Empty title={query ? "No photo matches that name" : "No photos in this area yet"}>
            {query
              ? "Try a shorter fragment, or use Search for text found inside images (OCR)."
              : "Run Export missing, then come back. Hidden and Recently Deleted are separate areas."}
          </Empty>
        </div>
      )}

      {data.pages > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-3 text-[12px]">
          <button
            type="button"
            disabled={data.page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <span className="text-[#6e6e73]">
            {data.page} / {data.pages}
          </span>
          <button
            type="button"
            disabled={data.page >= data.pages}
            onClick={() => setPage((value) => Math.min(data.pages, value + 1))}
            className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
      ) : null}

      {open !== null ? (
        <Lightbox
          accountId={account.id}
          items={data.items}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
