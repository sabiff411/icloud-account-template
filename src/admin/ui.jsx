import { bytes as formatBytes } from "./api.js";

export function statusTone(account) {
  if (!account) return "idle";
  if (account.locked) return "red";
  if (["dead", "twofa", "invalid", "error"].includes(account.status)) return "red";
  if (["connected", "done"].includes(account.status)) {
    return account.trusted ? (account.lastPingAt ? "green" : "yellow") : "yellow";
  }
  if (["queued", "auth", "exporting"].includes(account.status)) return "blue";
  return "yellow";
}

const DOT = {
  green: "bg-[#30a14e]",
  yellow: "bg-[#f0b429]",
  red: "bg-[#d70015]",
  blue: "bg-[#0071e3] animate-pulse",
  idle: "bg-[#c7c7cc]",
};

export function StatusDot({ account, className = "" }) {
  return (
    <span
      title={account?.locked ? "locked" : account?.status || "unknown"}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[statusTone(account)]} ${className}`}
    />
  );
}

const TONE = {
  green: "bg-[#edf8f0] text-[#1d7a3a] border-[#c6e9d0]",
  yellow: "bg-[#fff8e6] text-[#8a6100] border-[#f3dfa8]",
  red: "bg-[#fff2f2] text-[#c4000a] border-[#f3c9c9]",
  blue: "bg-[#eef5ff] text-[#0058b0] border-[#c9ddf7]",
  gray: "bg-[#f5f5f7] text-[#6e6e73] border-[#e5e5ea]",
};

export function Badge({ children, tone = "gray", className = "" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10px] font-medium uppercase tracking-[0.04em] ${TONE[tone] ?? TONE.gray} ${className}`}
    >
      {children}
    </span>
  );
}

export function AccountBadge({ account }) {
  if (!account) return null;
  if (account.locked) {
    return <Badge tone="red">locked{account.lockCode ? ` ${account.lockCode}` : ""}</Badge>;
  }
  const tone = statusTone(account);
  return <Badge tone={tone === "blue" ? "blue" : tone === "green" ? "green" : tone === "red" ? "red" : "yellow"}>
    {account.status}
  </Badge>;
}

export function Empty({ title, children, action }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-[#d8d8de] bg-white/60 px-6 py-10 text-center">
      <div className="text-[15px] font-medium text-[#1d1d1f]">{title}</div>
      {children ? <div className="max-w-[460px] text-[13px] leading-5 text-[#6e6e73]">{children}</div> : null}
      {action}
    </div>
  );
}

export function Spinner({ label = "Loading" }) {
  return (
    <div className="flex items-center gap-2 py-6 text-[13px] text-[#6e6e73]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#d2d2d7] border-t-[#0071e3]" />
      {label}…
    </div>
  );
}

export function Section({ title, right, children, className = "" }) {
  return (
    <section className={`rounded-[14px] border border-[#e5e5ea] bg-white ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0f0f2] px-4 py-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
          {title}
        </h3>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Bar({ value, total, className = "" }) {
  const percent = total ? Math.min(100, Math.round((Number(value) / Number(total)) * 100)) : 0;
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-[#ececf0] ${className}`}>
      <div className="h-full rounded-full bg-[#0071e3] transition-[width] duration-500" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function bytes(value) {
  return formatBytes(value);
}

/** Harvested names carry the asset UUID: show the human part in the panel. */
export function displayName(name) {
  const raw = String(name ?? "");
  return (
    raw
      .replace(/^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}[_-]/, "")
      .replace(/^(original_|livephoto-mov_)/, "") || raw
  );
}
