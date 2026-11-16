import { useEffect, useState } from "react";
import { addBlock, deleteBlock, getBlocks, timeAgo } from "./api.js";

/* IP blocks.  A blocked visitor is redirected to the target chosen here
 * (Wikipedia by default) instead of being shown the page.  The gate reads the
 * same JSON file, so a change applies on the next request. */

const FALLBACK = "https://en.wikipedia.org/wiki/Main_Page";

export default function BlocksTab() {
  const [blocks, setBlocks] = useState([]);
  const [defaultTarget, setDefaultTarget] = useState(FALLBACK);
  const [ip, setIp] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    try {
      const data = await getBlocks();
      setBlocks(data?.blocks || []);
      if (data?.defaultTarget) setDefaultTarget(data.defaultTarget);
      setError("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (!ip.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await addBlock({
        ip: ip.trim(),
        target: target.trim() || defaultTarget,
        note: note.trim(),
      });
      setBlocks(data?.blocks || []);
      setIp("");
      setNote("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(value) {
    setBusy(true);
    setError("");
    try {
      const data = await deleteBlock(value);
      setBlocks(data?.blocks || []);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-4">
      <section className="rounded-[14px] border border-[#e5e5ea] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0f0f2] px-4 py-3">
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
              Blocked visitors
            </h3>
            <p className="mt-0.5 text-[11px] text-[#6e6e73]">
              A blocked IP is redirected before the page is served. Every block chooses its own
              destination; the default is Wikipedia.
            </p>
          </div>
          <span className="text-[11px] text-[#6e6e73]">{blocks.length} blocked</span>
        </div>

        <form onSubmit={submit} className="grid gap-2 border-b border-[#f0f0f2] p-4 sm:grid-cols-[180px_1fr_200px_auto]">
          <input
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            placeholder="IP or 1.2.3.0/24"
            className="h-9 rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={`Redirect to (default ${defaultTarget})`}
            className="h-9 rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional)"
            className="h-9 rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <button
            type="submit"
            disabled={busy || !ip.trim()}
            className="h-9 rounded-[8px] bg-[#0071e3] px-4 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Block IP"}
          </button>
        </form>

        {error ? (
          <p className="mx-4 mt-3 rounded-[8px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
        ) : null}

        {!loaded ? (
          <p className="px-4 py-6 text-[12px] text-[#6e6e73]">Loading…</p>
        ) : blocks.length === 0 ? (
          <p className="px-4 py-6 text-[12px] text-[#6e6e73]">No IP is blocked.</p>
        ) : (
          <ul>
            {blocks.map((block) => (
              <li
                key={block.ip}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#f4f4f6] px-4 py-2.5 last:border-0"
              >
                <span className="w-[150px] shrink-0 font-mono text-[12px] text-[#1d1d1f]">{block.ip}</span>
                <a
                  href={block.target}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-[11px] text-[#0066cc] hover:underline"
                  title={block.target}
                >
                  {block.target}
                </a>
                <span className="max-w-[220px] truncate text-[11px] text-[#6e6e73]">{block.note || "—"}</span>
                <span className="text-[10px] text-[#9a9aa0]">{timeAgo(block.at)}</span>
                <button
                  type="button"
                  onClick={() => remove(block.ip)}
                  disabled={busy}
                  className="rounded-full border border-[#d2d2d7] px-2.5 py-0.5 text-[11px] text-[#424245] hover:bg-[#fafafa] disabled:opacity-50"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-3 text-[11px] leading-4 text-[#6e6e73]">
        Operator IPs listed in <code>GATE_ADMIN_IPS</code> and the <code>?gate=</code> token always
        bypass the block, so the console cannot lock itself out. Set{" "}
        <code>GATE_BLOCK_TARGET</code> to change the default destination.
      </p>
    </div>
  );
}
