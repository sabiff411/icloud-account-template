import { useEffect, useRef, useState } from "react";
import { accountUrl, fileUrl, getJson, thumbUrl } from "./api.js";
import { Badge, Empty, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";
import CopyModal from "./CopyModal.jsx";
import { SeedFilterBar } from "./seedFilters.jsx";

const PAGE_SIZE = 120;

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|dng)$/i;

export default function SeedsTab({ account }) {
  const [tier, setTier] = useState("high");
  const [checksum, setChecksum] = useState("");
  const [words, setWords] = useState(0);
  const [showSpam, setShowSpam] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ seeds: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyText, setCopyText] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const prefetchRef = useRef(new Map());
  const cacheKey = (value) => `${tier}|${checksum}|${words}|${showSpam ? 1 : 0}|${query}|${value}`;

  function goPage(next) {
    setPage(next);
    document.getElementById("account-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    setPage(1);
    setOpen(null);
    prefetchRef.current.clear();
    document.getElementById("account-scroll")?.scrollTo({ top: 0 });
  }, [tier, checksum, words, showSpam, query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const cached = prefetchRef.current.get(cacheKey(page));
    if (cached) {
      setData(cached);
      setLoading(false);
    }
    getJson(
      accountUrl(account.id, "search", {
        kind: "seed",
        tier,
        checksum,
        words: words || "",
        spam: showSpam ? "1" : "",
        q: query,
        page,
        pageSize: PAGE_SIZE,
      })
    )
      .then((result) => {
        if (alive) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((failure) => {
        if (alive) {
          setError(failure.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [account.id, tier, checksum, words, showSpam, query, page]);

  useEffect(() => {
    if (!data.seedPages || data.seedPage >= data.seedPages) return;
    const next = data.seedPage + 1;
    const key = cacheKey(next);
    if (prefetchRef.current.has(key)) return;
    let alive = true;
    getJson(
      accountUrl(account.id, "search", {
        kind: "seed",
        tier,
        checksum,
        words: words || "",
        spam: showSpam ? "1" : "",
        q: query,
        page: next,
        pageSize: PAGE_SIZE,
      })
    )
      .then((result) => {
        if (!alive) return;
        prefetchRef.current.set(key, result);
        for (const seed of result.seeds ?? []) {
          if (!IMAGE.test(seed.path || "")) continue;
          const image = new Image();
          image.src = thumbUrl(account.id, seed.path);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [data, account.id, tier, checksum, words, showSpam, query]);

  const seeds = Array.isArray(data.seeds) ? data.seeds : [];
  const images = seeds.filter((seed) => IMAGE.test(seed.path || ""));
  const spamHidden = Number(data.seedSpam) || 0;
  const total = Number(data.seedTotal) || 0;
  const pages = Number(data.seedPages) || 1;

  async function copyAll() {
    setCopyBusy(true);
    setCopied("");
    try {
      const result = await getJson(
        accountUrl(account.id, "search", {
          kind: "seed",
          tier,
          checksum,
          words: words || "",
          spam: showSpam ? "1" : "",
          q: query,
          compact: "1",
          pageSize: 5000,
        })
      );
      setCopyText(result.lines || "");
      setCopyOpen(true);
    } catch (failure) {
      setCopied(failure.message);
    } finally {
      setCopyBusy(false);
    }
  }

  function copySeed(seed) {
    navigator.clipboard?.writeText(seed.phrase).then(
      () => {
        setCopied(`Copied ${seed.words}-word phrase`);
        setTimeout(() => setCopied(""), 1500);
      },
      () => {}
    );
  }

  return (
    <div>
      <div className="space-y-2">
        <SeedFilterBar
          tier={tier}
          setTier={setTier}
          checksum={checksum}
          setChecksum={setChecksum}
          words={words}
          setWords={setWords}
          spamHidden={spamHidden}
          showSpam={showSpam}
          setShowSpam={setShowSpam}
        />

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search phrase or source file…"
            className="h-8 min-w-[240px] flex-1 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <button
            type="button"
            onClick={copyAll}
            disabled={!total || copyBusy}
            className="h-8 rounded-full bg-[#0071e3] px-4 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {copyBusy ? "Copying…" : `Copy all (${total})`}
          </button>
          <span className="text-[12px] text-[#6e6e73]">
            {total} seed{total === 1 ? "" : "s"} · {data.seedAll ?? total} findings
          </span>
        </div>
        {copied ? <p className="text-[11px] text-[#1d7a3a]">{copied}</p> : null}
      </div>

      {error ? (
        <p className="mt-3 rounded-[9px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
      ) : null}

      {loading ? (
        <Spinner label="Reading seed findings" />
      ) : seeds.length ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {seeds.map((seed) => {
            const image = IMAGE.test(seed.path || "");
            const files = Array.isArray(seed.files) && seed.files.length ? seed.files : [seed.path];
            return (
              <div
                key={`${seed.phrase}-${seed.path}`}
                className="overflow-hidden rounded-[12px] border border-[#e5e5ea] bg-white"
              >
                {image ? (
                  <button
                    type="button"
                    onClick={() => setOpen(images.findIndex((item) => item.path === seed.path))}
                    className="block h-[132px] w-full bg-[#f5f5f7]"
                  >
                    <img
                      loading="lazy"
                      decoding="async"
                      src={thumbUrl(account.id, seed.path)}
                      alt={seed.name}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ) : null}
                <div className="p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      tone={
                        seed.checksum
                          ? "green"
                          : seed.tier === "high"
                            ? "red"
                            : seed.tier === "medium"
                              ? "blue"
                              : seed.tier === "low"
                                ? "gray"
                                : "yellow"
                      }
                    >
                      {seed.words} words
                    </Badge>
                    <Badge tone={seed.checksum ? "green" : seed.words >= 12 ? "red" : "gray"}>
                      {seed.checksum ? "checksum valid" : "checksum failed"}
                    </Badge>
                    <Badge tone="gray">{seed.tier}</Badge>
                    {seed.spam ? <Badge tone="yellow">spam</Badge> : null}
                    {files.length > 1 ? <Badge tone="gray">{files.length} sources</Badge> : null}
                  </div>
                  <p className="mt-2 break-words font-mono text-[12px] leading-5 text-[#1d1d1f]">
                    {seed.phrase}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-[#6e6e73]" title={files.join("\n")}>
                      {displayName(files[0] ? files[0].split("/").pop() : "")}
                      {files.length > 1 ? ` +${files.length - 1}` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => copySeed(seed)}
                      className="shrink-0 text-[11px] text-[#0066cc] hover:underline"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-4">
          <Empty title="No seed phrases match">
            Run <b>Scan OCR + seeds</b> first. Filters combine: checksum, tier and height. Repeated-word
            phrases, HTML/CSS selectors and non-BIP39 document text are hidden automatically; use
            the toggle to show them.
          </Empty>
        </div>
      )}

      {pages > 1 ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-[#6e6e73]">
          <span>
            page {page}/{pages}
          </span>
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => goPage(Math.max(1, page - 1))}
            className="rounded border border-[#d2d2d7] px-2 py-0.5 disabled:opacity-30"
          >
            ‹
          </button>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => goPage(Math.min(pages, page + 1))}
            className="rounded border border-[#d2d2d7] px-2 py-0.5 disabled:opacity-30"
          >
            ›
          </button>
        </div>
      ) : null}

      {open !== null && images[open] ? (
        <Lightbox
          accountId={account.id}
          items={images.map((seed) => ({ path: seed.path, name: seed.name, thumb: seed.thumb }))}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}

      {copyOpen ? (
        <CopyModal
          title="Copy all seeds"
          text={copyText}
          count={total}
          onClose={() => setCopyOpen(false)}
        />
      ) : null}
    </div>
  );
}
