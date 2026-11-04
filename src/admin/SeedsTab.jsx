import { useEffect, useState } from "react";
import { accountUrl, fileUrl, getJson } from "./api.js";
import { Badge, Empty, Spinner } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";

const TIERS = [
  { id: "", label: "All" },
  { id: "valid", label: "Checksum valid" },
  { id: "minimum", label: "5+ minimum" },
  { id: "medium", label: "8+ medium" },
  { id: "high", label: "12+ high" },
];

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif)$/i;

export default function SeedsTab({ account }) {
  const [tier, setTier] = useState("");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState({ seeds: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    getJson(accountUrl(account.id, "search", { kind: "seed", tier, q: query, pageSize: 120 }))
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
  }, [account.id, tier, query]);

  const images = data.seeds.filter((seed) => IMAGE.test(seed.path || ""));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {TIERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setTier(option.id)}
              className={`h-8 rounded-full px-3 text-[12px] font-medium ${
                tier === option.id
                  ? "bg-[#1d1d1f] text-white"
                  : "border border-[#d2d2d7] bg-white text-[#424245] hover:bg-[#fafafa]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search phrase or source file…"
          className="ml-auto h-8 w-[280px] rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
        />
        <span className="text-[12px] text-[#6e6e73]">{data.seeds.length} found</span>
      </div>

      {error ? (
        <p className="mt-3 rounded-[9px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
      ) : null}

      {loading ? (
        <Spinner label="Reading seed findings" />
      ) : data.seeds.length ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.seeds.map((seed, index) => {
            const image = IMAGE.test(seed.path || "");
            return (
              <div key={`${seed.phrase}-${index}`} className="overflow-hidden rounded-[12px] border border-[#e5e5ea] bg-white">
                {image ? (
                  <button
                    type="button"
                    onClick={() => setOpen(images.findIndex((item) => item.path === seed.path))}
                    className="block h-[132px] w-full bg-[#f5f5f7]"
                  >
                    <img
                      loading="lazy"
                      src={fileUrl(account.id, seed.thumb || seed.path)}
                      alt={seed.name}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ) : null}
                <div className="p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={seed.tier === "high" ? "red" : seed.tier === "medium" ? "blue" : "yellow"}>
                      {seed.words} words · {seed.tier}
                    </Badge>
                    {seed.checksum ? (
                      <Badge tone="green">checksum valid</Badge>
                    ) : seed.words >= 12 ? (
                      <Badge tone="gray">checksum failed</Badge>
                    ) : null}
                    <span className="text-[10px] text-[#6e6e73]">{seed.source}</span>
                  </div>
                  <p className="mt-2 break-words font-mono text-[12px] leading-5 text-[#1d1d1f]">
                    {seed.phrase}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-[#6e6e73]" title={seed.path}>
                      {seed.name || seed.path}
                    </span>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(seed.phrase).catch(() => {})}
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
          <Empty title="No seed phrases found">
            Run <b>Scan OCR + seeds</b> first. The scan reads notes and image text; 5–7 words is
            minimum, 8–11 medium, 12+ high, and checksum-valid phrases get their own filter.
          </Empty>
        </div>
      )}

      {open !== null && images[open] ? (
        <Lightbox
          accountId={account.id}
          items={images.map((seed) => ({ path: seed.path, name: seed.name, thumb: seed.thumb }))}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
