import { useEffect, useMemo, useState } from "react";
import { accountUrl, getJson } from "./api.js";

/* Everything needed to open an account by hand: email, password, the exact
 * proxy and the already-trusted iCloud cookies. The cookies are enough; the
 * password is only a fallback. */
export default function ManualConnectModal({ account, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [copied, setCopied] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let alive = true;
    getJson(accountUrl(account.id, "manual"))
      .then((result) => {
        if (alive) setState({ loading: false, ...result });
      })
      .catch((failure) => {
        if (alive) setState({ loading: false, error: failure.message });
      });
    return () => {
      alive = false;
    };
  }, [account.id, refreshKey]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cookieJson = useMemo(
    () => (state.cookies ? JSON.stringify(state.cookies, null, 1) : ""),
    [state.cookies]
  );

  async function copy(label, value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1500);
  }

  function download() {
    const blob = new Blob([cookieJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${account.email}-cookies.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const proxy = state.proxy;
  const session = state.session || {};
  const expiresLabel = session.expiresAt
    ? new Date(session.expiresAt).toLocaleString()
    : "unknown";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,22,0.55)] p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Manual connect ${account.email}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[16px] bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#e5e5ea] px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#6e6e73]">
              Manual connect
            </div>
            <h2 className="mt-0.5 truncate text-[18px] font-semibold tracking-[-0.2px]">
              {account.email}
            </h2>
            <div className="mt-1 text-[11px] text-[#6e6e73]">
              {session.found
                ? `${session.count} cookies · expire ${expiresLabel}`
                : session.reason || "no session file"}
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
              className="rounded-full border border-[#d2d2d7] bg-white px-3 py-1.5 text-[12px] text-[#424245] hover:bg-[#f5f5f7]"
              title="Re-read the cookie from the VPS session"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[#d2d2d7] bg-white px-3 py-1.5 text-[12px] text-[#424245] hover:bg-[#f5f5f7]"
            >
              Close
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {state.loading ? (
            <div className="py-10 text-center text-[13px] text-[#6e6e73]">Loading…</div>
          ) : state.error ? (
            <div className="rounded-[10px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">
              {state.error}
            </div>
          ) : (
            <div className="space-y-4">
              <section>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
                  Account
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Email" value={state.account?.email} onCopy={copy} />
                  <Field label="Password" value={state.account?.password} onCopy={copy} />
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
                  Proxy <span className="font-normal normal-case text-[#9a9aa0]">(optional)</span>
                </h3>
                {proxy ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Server" value={proxy.server} onCopy={copy} />
                    <Field label="Username" value={proxy.username} onCopy={copy} />
                    <Field label="Password" value={proxy.password} onCopy={copy} />
                    <Field label="Country" value={proxy.country || "any"} onCopy={copy} />
                    <div className="sm:col-span-2">
                      <Field label="Full proxy URL" value={proxy.url} onCopy={copy} />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-[10px] bg-[#f5f5f7] px-3 py-2 text-[12px] text-[#6e6e73]">
                    No ANYIP_PROXY_URL configured. Direct browsing usually works.
                  </div>
                )}
              </section>

              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
                    Cookies <span className="font-normal normal-case text-[#9a9aa0]">(Cookie-Editor JSON)</span>
                  </h3>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => copy("cookies", cookieJson)}
                      disabled={!cookieJson}
                      className="rounded-[8px] bg-[#0071e3] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#0077ed] disabled:opacity-50"
                    >
                      {copied === "cookies" ? "Copied" : "Copy JSON"}
                    </button>
                    <button
                      type="button"
                      onClick={download}
                      disabled={!cookieJson}
                      className="rounded-[8px] border border-[#d2d2d7] bg-white px-3 py-1.5 text-[12px] hover:bg-[#fafafa] disabled:opacity-50"
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={() => copy("header", state.cookieHeader)}
                      disabled={!state.cookieHeader}
                      className="rounded-[8px] border border-[#d2d2d7] bg-white px-3 py-1.5 text-[12px] hover:bg-[#fafafa] disabled:opacity-50"
                    >
                      {copied === "header" ? "Copied" : "Copy header (curl)"}
                    </button>
                  </div>
                </div>
                <textarea
                  readOnly
                  value={cookieJson || "(no cookies in this session)"}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-[210px] w-full resize-y rounded-[10px] border border-[#d2d2d7] bg-[#fbfbfd] p-3 font-mono text-[11px] leading-4 text-[#1d1d1f]"
                  spellCheck={false}
                />
              </section>

              <section className="rounded-[10px] border border-[#e5e5ea] bg-[#fbfbfd] px-3 py-2 text-[12px] leading-5 text-[#424245]">
                <div className="font-medium text-[#1d1d1f]">Where to paste it</div>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  <li>Install <b>Cookie-Editor</b> by cgagnier (ID <code>hlkenndednhfkekhgcdicdfddnkalmdm</code>, ~2M users) — not “Cookies Editor” by tmtk.apps.</li>
                  <li>Open <b>https://www.icloud.com/</b>, click Cookie-Editor.</li>
                  <li>Cookie-Editor → <b>Import</b> → <b>Use text</b> → paste the JSON → <b>Import</b>.</li>
                  <li>Reload. No email/password/2FA is needed.</li>
                </ol>
                <div className="mt-1 text-[11px] text-[#6e6e73]">
                  Use <b>Copy JSON</b> for the browser: it keeps the domains
                  (icloud.com, apple.com, idmsa.apple.com). The header string is
                  only for curl/Postman and loses domain/path information.
                </div>
                <div className="mt-1 text-[11px] text-[#8a6100]">
                  Ping / Verify live refreshes the token on the VPS, so this
                  cookie can change. If the browser logs out, press
                  <b> Refresh</b> and import the new JSON.
                </div>
                {!session.found ? (
                  <div className="mt-1 text-[#c4000a]">
                    This account has no saved session. Use the password + proxy, but Apple will ask for 2FA.
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onCopy, secret = false }) {
  const shown = value || "—";
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.04em] text-[#9a9aa0]">
        {label}
      </span>
      <span className="flex items-stretch gap-1">
        <input
          readOnly
          value={shown}
          type={secret ? "password" : "text"}
          onFocus={(event) => event.currentTarget.select()}
          className="h-8 min-w-0 flex-1 rounded-[8px] border border-[#d2d2d7] bg-white px-2 font-mono text-[11px] text-[#1d1d1f]"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => onCopy(label, shown)}
          disabled={!value}
          className="rounded-[8px] border border-[#d2d2d7] bg-white px-2 text-[10px] text-[#424245] hover:bg-[#f5f5f7] disabled:opacity-40"
        >
          Copy
        </button>
      </span>
    </label>
  );
}
