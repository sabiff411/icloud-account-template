import { useState } from "react";
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

function Panel({ admin }) {
  const { state, disconnect, loadPage, openItem, clearSelected, saveItem, deleteItem, sendNotice } =
    admin;
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
            onClick={() => loadPage(state.page, state.query)}
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

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total" value={state.stats?.total ?? 0} />
        <Stat label="New" value={state.stats?.byStatus?.new ?? 0} />
        <Stat label="Reviewed" value={state.stats?.byStatus?.reviewed ?? 0} />
        <Stat label="Done" value={state.stats?.byStatus?.done ?? 0} />
      </div>

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
