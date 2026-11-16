import { useEffect, useRef, useState } from "react";
import { fileUrl, getLibrary, thumbUrl, timeAgo } from "./api.js";
import { Badge, Empty, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";

/* Cross-account Crypto view: every seed finding plus photos, notes and Drive
 * files that mention a coin, exchange, wallet or recovery phrase.  The
 * catalog does the matching; this view only searches and renders. */

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|dng)$/i;
const VIDEO = /\.(mov|mp4|m4v|3gp)$/i;
const KINDS = [
  ["", "All evidence"],
  ["seed", "Seed phrases"],
  ["image", "Images"],
  ["note", "Notes"],
  ["file", "Drive / files"],
];
const SIGNAL_TONE = {
  seed: "green",
  address: "green",
  exchange: "blue",
  wallet: "blue",
  ticker: "yellow",
  crypto: "yellow",
  trading: "gray",
};

function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-[#6e6e73]">
      <span>
        page {page}/{pages}
      </span>
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded border border-[#d2d2d7] px-2 py-0.5 disabled:opacity-30"
      >
        ‹
      </button>
      <button
        type="button"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        className="rounded border border-[#d2d2d7] px-2 py-0.5 disabled:opacity-30"
      >
        ›
      </button>
    </div>
  );
}

function SourceBadge({ item }) {
  const tone =
    item.kind === "seed"
      ? item.checksum
        ? "green"
        : "yellow"
      : item.source === "Photos"
        ? "blue"
        : item.source === "Drive"
          ? "gray"
          : "yellow";
  return (
    <Badge tone={tone}>
      {item.kind === "seed" ? "seed phrase" : item.source || "file"}
    </Badge>
  );
}

export default function CryptoTab() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [accountId, setAccountId] = useState("");
  const [cryptoKind, setCryptoKind] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);
  const scrollRef = useRef(null);
  const prefetchRef = useRef(new Map());
  const cacheKey = (value) => `${query}|${accountId}|${cryptoKind}|${value}`;

  function goPage(next) {
    setPage(next);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    setPage(1);
    setOpen(null);
    prefetchRef.current.clear();
    scrollRef.current?.scrollTo({ top: 0 });
  }, [query, accountId, cryptoKind]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const cached = prefetchRef.current.get(cacheKey(page));
    if (cached) {
      setData(cached);
      setLoading(false);
    }
    getLibrary({ type: "crypto", q: query, accountId, cryptoKind, page, pageSize: 60 })
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
  }, [query, accountId, cryptoKind, page, tick]);

  useEffect(() => {
    if (!data?.pages || data.page >= data.pages) return;
    const next = data.page + 1;
    const key = cacheKey(next);
    if (prefetchRef.current.has(key)) return;
    let alive = true;
    getLibrary({ type: "crypto", q: query, accountId, cryptoKind, page: next, pageSize: 60 })
      .then((result) => {
        if (!alive) return;
        prefetchRef.current.set(key, result);
        for (const item of result.items ?? []) {
          if (item.kind === "seed" || item.video) continue;
          if (!IMAGE.test(item.path || "")) continue;
          const image = new Image();
          image.src = thumbUrl(item.accountId, item.path);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [data, query, accountId, cryptoKind]);

  const items = Array.isArray(data?.items) ? data.items : [];
  const images = items.filter((item) => IMAGE.test(item.path || ""));
  const summary = Array.isArray(data?.summary) ? data.summary : [];
  const counts = data?.counts ?? {};

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-[#f5f5f7]">
      <div className="sticky top-0 z-10 border-b border-[#e5e5ea] bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-1 text-[16px] font-semibold tracking-[-0.2px]">₿ Crypto</h2>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search coin, exchange, wallet, seed phrase, note, file or account…"
            className="h-9 min-w-[260px] flex-1 rounded-[9px] border border-[#d2d2d7] bg-white px-3 text-[13px] outline-none focus:border-[#0071e3]"
          />
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="h-9 max-w-[240px] rounded-[9px] border border-[#d2d2d7] bg-white px-2 text-[12px] outline-none focus:border-[#0071e3]"
          >
            <option value="">All accounts</option>
            {(data?.accounts ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setTick((value) => value + 1)}
            className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[12px]"
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#6e6e73]">
          <span>
            <b className="text-[#1d1d1f]">{counts.cryptoAccounts ?? 0}</b> accounts
          </span>
          <span>
            <b className="text-[#1d1d1f]">{counts.crypto ?? 0}</b> matches
          </span>
          <span>{counts.cryptoSeeds ?? 0} seed phrases (12+ words)</span>
          <span>indexed {timeAgo(data?.builtAt)}</span>
          <span>coins · exchanges · wallets · addresses · transaction screenshots</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {KINDS.map(([id, label]) => (
            <button
              key={id || "all"}
              type="button"
              onClick={() => setCryptoKind(id)}
              className={`h-6 rounded-full px-2.5 text-[10px] font-medium ${
                cryptoKind === id
                  ? "bg-[#eef5ff] text-[#0058b0]"
                  : "text-[#6e6e73] hover:bg-[#f5f5f7]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {error ? (
          <p className="mt-2 rounded-[8px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
        ) : null}
      </div>

      <div className="p-4">
        {loading && !data ? <Spinner label="Searching every account for crypto" /> : null}

        {!loading && summary.length ? (
          <div className="mb-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
                Accounts with crypto signals ({summary.length})
              </h3>
              {accountId ? (
                <button
                  type="button"
                  onClick={() => setAccountId("")}
                  className="text-[11px] text-[#0066cc] hover:underline"
                >
                  Clear account filter
                </button>
              ) : (
                <span className="text-[10px] text-[#9a9aa0]">click an account to filter everything below</span>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {summary.map((row) => (
                <button
                  key={row.accountId || row.email}
                  type="button"
                  onClick={() => setAccountId(accountId === row.accountId ? "" : row.accountId)}
                  className={`rounded-[12px] border p-3 text-left ${
                    accountId === row.accountId
                      ? "border-[#0071e3] bg-[#eef5ff]"
                      : "border-[#e5e5ea] bg-white hover:border-[#0071e3]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium">{row.email}</span>
                    <span className="shrink-0 text-[10px] text-[#6e6e73]">{row.count} items</span>
                  </div>
                  <div className="mt-1 text-[10px] text-[#6e6e73]">
                    {row.seeds} seeds · {row.images} images · {row.notes} notes · {row.files} files
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {row.hasAddress ? <Badge tone="green">address</Badge> : null}
                    {(row.signals ?? []).slice(0, 4).map((signal) => (
                      <Badge key={signal.name} tone={SIGNAL_TONE[signal.name] ?? "gray"}>
                        {signal.name} {signal.count}
                      </Badge>
                    ))}
                  </div>
                  {row.top?.length ? (
                    <div className="mt-1 truncate text-[10px] text-[#9a9aa0]" title={row.top.join(" · ")}>
                      {row.top.join(" · ")}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {!loading && items.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item, index) => {
              const image = IMAGE.test(item.path || "");
              const video = VIDEO.test(item.path || "");
              const display = item.kind === "seed" ? item.phrase : displayName(item.name || item.path);
              return (
                <div
                  key={`${item.accountId}-${item.path}-${item.phrase || ""}`}
                  className="flex flex-col overflow-hidden rounded-[12px] border border-[#e5e5ea] bg-white"
                >
                  {image || (video && item.thumb) ? (
                    <button
                      type="button"
                      onClick={() => {
                        const at = images.findIndex(
                          (entry) => entry.accountId === item.accountId && entry.path === item.path
                        );
                        if (at >= 0) setOpen(at);
                      }}
                      className="relative block h-[160px] w-full bg-[#f5f5f7]"
                    >
                      <img
                        loading="lazy"
                        decoding="async"
                        src={thumbUrl(item.accountId, item.path)}
                        alt={item.name}
                        className="h-full w-full object-cover"
                      />
                      {video ? (
                        <span className="absolute right-1 top-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white">
                          ▶ video
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <a
                      href={fileUrl(item.accountId, item.path, true)}
                      className="flex h-[92px] items-center gap-3 bg-[#f5f5f7] px-4"
                    >
                      <span className="text-[26px]">
                        {/\.pdf$/i.test(item.path || "") ? "📄" : /\.(csv|xlsx?|numbers)$/i.test(item.path || "") ? "📊" : "📁"}
                      </span>
                      <span className="truncate text-[11px] text-[#424245]">{displayName(item.name || item.path)}</span>
                    </a>
                  )}

                  <div className="flex min-h-0 flex-1 flex-col p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SourceBadge item={item} />
                      {item.signal && item.signal !== "seed" ? (
                        <Badge tone={SIGNAL_TONE[item.signal] ?? "gray"}>{item.signal}</Badge>
                      ) : null}
                      {item.matched && item.kind !== "seed" ? (
                        <Badge tone="gray">{item.matched}</Badge>
                      ) : null}
                      {item.kind === "seed" ? (
                        <Badge tone={item.checksum ? "green" : "yellow"}>
                          {item.words} words · {item.checksum ? "valid" : "failed"}
                        </Badge>
                      ) : null}
                    </div>
                    {item.kind === "seed" ? (
                      <p className="mt-2 break-words font-mono text-[12px] leading-5 text-[#1d1d1f]">
                        {item.phrase}
                      </p>
                    ) : (
                      <p className="mt-2 line-clamp-2 text-[12px] font-medium text-[#1d1d1f]">{display}</p>
                    )}
                    {item.snippet && item.kind !== "seed" ? (
                      <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-[#6e6e73]">{item.snippet}</p>
                    ) : null}
                    <div className="mt-auto pt-2">
                      <div className="truncate text-[10px] text-[#6e6e73]" title={item.email}>
                        {item.email}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="truncate text-[10px] text-[#9a9aa0]" title={item.path}>
                          {item.path}
                        </span>
                        <a
                          href={fileUrl(item.accountId, item.path, true)}
                          className="shrink-0 text-[11px] text-[#0066cc] hover:underline"
                        >
                          Open
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {!loading && !items.length ? (
          <Empty title="No crypto matches">
            The catalog looks for Bitcoin, BTC, Ethereum, Solana, exchanges, wallets, Sparplan and
            recovery phrases in photo OCR, note text and Drive files. Run <b>Scan all</b> to index
            new exports.
          </Empty>
        ) : null}

        <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={goPage} />
      </div>

      {open !== null && images[open] ? (
        <Lightbox
          items={images}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
