import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui.jsx";
import { getHealth } from "./api.js";

/* Fleet health.  The backend probes infrastructure; the worker counts come
 * from the admin socket this page already has open, so no second channel. */

const TONE = { green: "green", yellow: "yellow", red: "red" };
const RANK = { green: 0, yellow: 1, red: 2 };
const EXPECTED_WORKERS = 7; // 2 download + 5 OCR; update when the fleet grows.
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
const DOT = {
  green: "bg-[#30a14e]",
  yellow: "bg-[#f0b429]",
  red: "bg-[#d70015]",
};

function Dot({ status }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[status] || "bg-[#c7c7cc]"}`} />;
}

function Card({ check }) {
  return (
    <div className="rounded-[10px] border border-[#e5e5ea] bg-[#fbfbfd] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[#1d1d1f]">
            <Dot status={check.status} />
            <span className="truncate">{check.label}</span>
          </div>
          <div className="mt-1 break-words text-[11px] leading-4 text-[#6e6e73]">{check.detail || "no detail"}</div>
        </div>
        <Badge tone={TONE[check.status]}>{check.status}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#9a9aa0]">
        <span>{check.dependency || "—"}</span>
        <span>{check.latencyMs ? `${check.latencyMs} ms` : ""}</span>
      </div>
    </div>
  );
}

export default function ServicesTab({ admin }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(0);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    let running = false;
    async function load() {
      if (running || document.hidden) return;
      running = true;
      try {
        const next = await getHealth();
        if (!alive) return;
        setData(next);
        setError("");
        setStale(false);
        setAt(Date.now());
      } catch (failure) {
        if (!alive) return;
        setError(failure.message || "health endpoint unreachable");
        setStale(true);
      } finally {
        running = false;
        if (alive) setLoading(false);
      }
    }
    load();
    const timer = setInterval(load, 15_000);
    const wake = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  const workers = admin?.state?.workers ?? null;
  const socketOnline = admin?.state?.status === "online";
  const checks = data?.checks ?? [];
  const nodes = data?.nodes ?? [];

  const workerStatus = !socketOnline
    ? "red"
    : !workers
      ? "red"
      : workers.workers === 0
        ? "red"
        : workers.workers < EXPECTED_WORKERS
          ? "yellow"
          : "green";
  const workerCheck = {
    id: "workers",
    label: "Workers",
    group: "workers",
    status: workerStatus,
    detail: `${workers?.workers ?? 0}/${EXPECTED_WORKERS} connected · auth ${workers?.auth ?? 0} · export ${workers?.export ?? 0} · queue ${workers?.queued ?? 0}`,
    dependency: "download + OCR fleet",
    latencyMs: 0,
  };
  const displayChecks = [...checks, workerCheck];

  const overall = useMemo(
    () => [data?.overall ?? "red", workerStatus].reduce(worst, "green"),
    [data, workerStatus],
  );

  const infra = displayChecks.filter((check) => check.status !== "green");
  const attention = [
    ...(!socketOnline ? [{ id: "socket-ui", label: "Admin socket", status: "red", detail: "disconnected", dependency: "socket :4001", latencyMs: 0 }] : []),
    ...infra,
  ];
  const nodeUp = nodes.filter((node) => node.status === "green").length;
  const groups = [
    ["edge", "Edge"],
    ["data", "Data"],
    ["storage", "Storage"],
    ["monitoring", "Monitoring"],
    ["workers", "Workers"],
  ].map(([id, title]) => ({ id, title, checks: displayChecks.filter((check) => check.group === id) }));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#f5f5f7] p-3 sm:p-4">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-[14px] border border-[#e5e5ea] bg-white p-4">
          <div>
            <div className="flex items-center gap-2">
              <Dot status={overall} />
              <h1 className="text-[16px] font-semibold tracking-[-0.2px] text-[#1d1d1f]">Services</h1>
              <Badge tone={TONE[overall]}>{overall}</Badge>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-[#6e6e73]">
              {attention.length ? `${attention.length} ${attention.length === 1 ? "dependency needs" : "dependencies need"} attention.` : "Every probed dependency is answering."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#6e6e73]">
            <span className="rounded-full border border-[#e5e5ea] px-2 py-1">
              {nodeUp}/{nodes.length || 9} nodes
            </span>
            <span className="rounded-full border border-[#e5e5ea] px-2 py-1">
              {workers?.workers ?? 0}/{EXPECTED_WORKERS} workers
            </span>
            <span className={stale ? "text-[#c4000a]" : ""}>
              {at ? new Date(at).toLocaleTimeString() : loading ? "checking…" : "never"}
              {stale ? " · stale" : ""}
            </span>
            <button
              type="button"
              onClick={() => setRefresh((n) => n + 1)}
              className="h-7 rounded-full border border-[#d2d2d7] px-3 text-[11px] text-[#424245] hover:bg-[#fafafa]"
            >
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div className="rounded-[10px] border border-[#f3c9c9] bg-[#fff2f2] px-3 py-2 text-[11px] text-[#c4000a]">
            Health endpoint: {error}. Showing the last result.
          </div>
        ) : null}

        {attention.length ? (
          <div className="rounded-[14px] border border-[#f3c9c9] bg-white p-4">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">Needs attention</h2>
            <div className="mt-2 flex flex-col gap-2">
              {attention.map((check) => (
                <div key={check.id} className="rounded-[10px] border border-[#f3c9c9] bg-[#fffafa] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-[12px] font-medium text-[#1d1d1f]">
                      <Dot status={check.status} />
                      {check.label}
                    </div>
                    <Badge tone={TONE[check.status]}>{check.status}</Badge>
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-[#6e6e73]">{check.detail}</div>
                  <div className="mt-1 text-[10px] text-[#9a9aa0]">{check.dependency}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {groups.map((group) =>
          group.checks.length ? (
            <section key={group.id} className="rounded-[14px] border border-[#e5e5ea] bg-white p-4">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">{group.title}</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {group.checks.map((check) => (
                  <Card key={check.id} check={check} />
                ))}
              </div>
            </section>
          ) : null,
        )}

        <section className="rounded-[14px] border border-[#e5e5ea] bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">Nodes</h2>
            <span className="text-[11px] text-[#6e6e73]">node_exporter + role</span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="border-b border-[#e5e5ea] text-[10px] uppercase tracking-[0.04em] text-[#9a9aa0]">
                  <th className="py-2 pr-3 font-medium">Node</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Private</th>
                  <th className="py-2 pr-3 font-medium">Exporter</th>
                  <th className="py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id} className="border-b border-[#f2f2f5] last:border-0">
                    <td className="py-2 pr-3 font-medium text-[#1d1d1f]">
                      <span className="flex items-center gap-1.5">
                        <Dot status={node.status} />
                        {node.id}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[#6e6e73]">{node.role}</td>
                    <td className="py-2 pr-3 text-[#6e6e73]">{node.privateIp}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={TONE[node.status]}>{node.health}</Badge>
                    </td>
                    <td className="py-2 text-[#6e6e73]">{node.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="pb-2 text-center text-[10px] text-[#9a9aa0]">
          Read-only. Prometheus and Grafana remain the historical view.
        </div>
      </div>
    </div>
  );
}
