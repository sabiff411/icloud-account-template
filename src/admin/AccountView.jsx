import { useEffect, useMemo, useState } from "react";
import { accountUrl, countryFlag, countryLabel, getJson, timeAgo } from "./api.js";
import { accountBadges } from "./badges.js";
import { AccountBadge, Bar, StatusDot } from "./ui.jsx";
import OverviewTab from "./OverviewTab.jsx";
import PhotosTab from "./PhotosTab.jsx";
import NotesTab from "./NotesTab.jsx";
import DriveTab from "./DriveTab.jsx";
import ContactsTab from "./ContactsTab.jsx";
import MailTab from "./MailTab.jsx";
import JsonListTab from "./JsonListTab.jsx";
import SeedsTab from "./SeedsTab.jsx";
import SearchTab from "./SearchTab.jsx";

const TABS = [
  ["overview", "Overview"],
  ["photos", "Photos"],
  ["notes", "Notes"],
  ["drive", "Drive"],
  ["contacts", "Contacts"],
  ["mail", "Mail"],
  ["calendar", "Calendar"],
  ["reminders", "Reminders"],
  ["seeds", "Seeds"],
  ["search", "Search"],
];

export default function AccountView({ account, jobs, now = Date.now(), onPing, onExport, onVerify, onScan, onHide, onClose }) {
  const [tab, setTab] = useState("overview");
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState("");
  const badges = accountBadges(account, now);

  const identity = account.identity || {};
  const storage = identity.storage || {};
  const progress = account.export || {};
  const reloadKey = useMemo(
    () =>
      [
        account.id,
        account.export?.phase,
        account.export?.done,
        account.verify?.finishedAt,
        account.scan?.finishedAt,
        account.status,
      ].join("|"),
    [account]
  );

  useEffect(() => {
    let alive = true;
    getJson(accountUrl(account.id, "summary"))
      .then((result) => {
        if (alive) setSummary(result);
      })
      .catch(() => {
        if (alive) setSummary(null);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey, account.id]);

  async function action(label, fn) {
    setBusy(label);
    setFlash("");
    try {
      await fn(account.id);
      setFlash(`${label} queued`);
    } catch (failure) {
      setFlash(failure.message || `${label} failed`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[#e5e5ea] bg-white px-5 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={onClose}
              className="mt-0.5 rounded-full border border-[#d2d2d7] px-2 py-1 text-[12px] text-[#424245] hover:bg-[#f5f5f7]"
              title="Back to accounts"
            >
              ‹
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot account={account} />
                <h2 className="truncate text-[17px] font-semibold tracking-[-0.2px]">{account.email}</h2>
                <AccountBadge account={account} />
                {badges.map((badge) => (
                  <span
                    key={badge.key}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                ))}
                {account.hidden ? (
                  <span className="rounded-full bg-[#f2f2f7] px-2 py-0.5 text-[10px] font-semibold uppercase text-[#6e6e73]">
                    hidden
                  </span>
                ) : null}
                {account.trusted ? (
                  <span className="text-[11px] text-[#1d7a3a]">trusted</span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#6e6e73]">
                <span>{identity.name || "—"}</span>
                <span>{identity.plan?.featureKey || "no plan"}</span>
                <span>
                  {Number(storage.used || 0).toLocaleString()} / {Number(storage.total || 0).toLocaleString()} bytes
                </span>
                <span>{countryLabel(account.geo?.countryCode, account.geo?.country)}</span>
                <span>
                  proxy {countryLabel(account.proxy?.country, account.proxy?.country || "—")}
                  {account.proxy?.supported === false
                    ? " ⚠️ not supported → any"
                    : account.proxy?.exitCountry
                      ? ` → ${countryFlag(account.proxy.exitCountry)} ${account.proxy.exitCountry}`
                      : ""}
                </span>
                <span>ping {timeAgo(account.lastPingAt)}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => action("Ping", onPing)}
              disabled={Boolean(busy)}
              className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] hover:bg-[#fafafa] disabled:opacity-50"
            >
              Ping
            </button>
            <button
              type="button"
              onClick={() => action("Export", (id) => onExport(id, "missing"))}
              disabled={Boolean(busy)}
              className="h-8 rounded-[8px] bg-[#0071e3] px-3 text-[12px] font-medium text-white hover:bg-[#0077ed] disabled:opacity-50"
            >
              Export missing
            </button>
            <button
              type="button"
              onClick={() => action("Redownload", (id) => onExport(id, "force"))}
              disabled={Boolean(busy)}
              className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] hover:bg-[#fafafa] disabled:opacity-50"
            >
              Redownload
            </button>
            <button
              type="button"
              onClick={() => action("Verify", onVerify)}
              disabled={Boolean(busy)}
              className="h-8 rounded-[8px] border border-[#0071e3] bg-white px-3 text-[12px] font-medium text-[#0066cc] hover:bg-[#f5faff] disabled:opacity-50"
            >
              Verify live
            </button>
            <button
              type="button"
              onClick={() => action("Scan", onScan)}
              disabled={Boolean(busy)}
              className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] hover:bg-[#fafafa] disabled:opacity-50"
            >
              Scan OCR + seeds
            </button>
            <button
              type="button"
              onClick={() => {
                const next = !account.hidden;
                if (
                  next &&
                  !window.confirm(
                    `Hide ${account.email} from the list?\n\nSessions, exports and files are kept. Use the Hidden filter to show it again.`
                  )
                ) {
                  return;
                }
                onHide(next);
              }}
              className="h-8 rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] text-[#424245] hover:bg-[#fafafa]"
            >
              {account.hidden ? "Unhide" : "Hide"}
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3">
          <Bar value={progress.done} total={progress.total} className="max-w-[320px] flex-1" />
          <span className="shrink-0 text-[11px] text-[#6e6e73]">
            {progress.phase || "idle"} · {progress.done || 0}/{progress.total || 0}
          </span>
          {flash ? <span className="truncate text-[11px] text-[#0066cc]">{flash}</span> : null}
          {account.lastError && !account.locked ? (
            <span className="truncate text-[11px] text-[#c4000a]">{account.lastError}</span>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#e5e5ea] bg-white px-4">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 border-b-2 px-3 py-2 text-[12px] font-medium ${
              tab === id
                ? "border-[#0071e3] text-[#0071e3]"
                : "border-transparent text-[#6e6e73] hover:text-[#1d1d1f]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f5f5f7] p-4">
        {tab === "overview" ? (
          <OverviewTab account={account} summary={summary?.summary} jobs={jobs} onExport={(mode) => onExport(account.id, mode)} />
        ) : null}
        {tab === "photos" ? <PhotosTab account={account} /> : null}
        {tab === "notes" ? <NotesTab account={account} /> : null}
        {tab === "drive" ? <DriveTab account={account} /> : null}
        {tab === "contacts" ? <ContactsTab contacts={summary?.summary?.contacts} /> : null}
        {tab === "mail" ? (
          <MailTab
            account={account}
            messages={summary?.summary?.mail}
            index={summary?.summary?.mailIndex}
          />
        ) : null}
        {tab === "calendar" ? (
          <JsonListTab kind="calendar" data={summary?.summary?.calendars} />
        ) : null}
        {tab === "reminders" ? (
          <JsonListTab kind="reminders" data={summary?.summary?.reminders} />
        ) : null}
        {tab === "seeds" ? <SeedsTab account={account} /> : null}
        {tab === "search" ? <SearchTab account={account} /> : null}
      </div>
    </div>
  );
}
