import { useEffect, useMemo, useState } from "react";
import { accountUrl, bytes, fileUrl, getJson } from "./api.js";
import { Empty, Spinner, displayName } from "./ui.jsx";
import PreviewModal from "./PreviewModal.jsx";

const ROOT = "Drive";

function crumbs(path) {
  const parts = String(path || ROOT).split("/").filter(Boolean);
  const out = [{ label: "Drive", path: ROOT }];
  for (let index = 1; index < parts.length; index += 1) {
    out.push({ label: parts[index], path: parts.slice(0, index + 1).join("/") });
  }
  return out;
}

export default function DriveTab({ account }) {
  const [path, setPath] = useState(ROOT);
  const [data, setData] = useState({ dirs: [], files: [] });
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    getJson(accountUrl(account.id, "tree", { path }))
      .then((result) => {
        if (!alive) return;
        setData({ dirs: result.dirs || [], files: result.files || [] });
        setLoading(false);
      })
      .catch((failure) => {
        if (!alive) return;
        setError(failure.message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [account.id, path]);

  const needle = filter.trim().toLowerCase();
  const dirs = useMemo(
    () => data.dirs.filter((dir) => !needle || dir.name.toLowerCase().includes(needle)),
    [data.dirs, needle]
  );
  const files = useMemo(
    () => data.files.filter((file) => !needle || file.name.toLowerCase().includes(needle)),
    [data.files, needle]
  );

  if (loading) return <Spinner label="Loading Drive" />;
  if (error) return <Empty title="Drive is not exported yet">{error}</Empty>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap items-center gap-1 text-[12px]">
          {crumbs(path).map((crumb, index) => (
            <span key={crumb.path} className="flex items-center gap-1">
              {index ? <span className="text-[#c7c7cc]">/</span> : null}
              <button
                type="button"
                onClick={() => setPath(crumb.path)}
                className={index === crumbs(path).length - 1 ? "font-medium" : "text-[#0066cc] hover:underline"}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter this folder…"
          className="ml-auto h-8 w-[220px] rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-[12px] border border-[#e5e5ea] bg-white">
        {dirs.map((dir) => (
          <button
            key={dir.path}
            type="button"
            onClick={() => setPath(dir.path)}
            className="flex w-full items-center gap-3 border-b border-[#f4f4f6] px-4 py-2.5 text-left hover:bg-[#fafafa]"
          >
            <span className="text-[16px]">📁</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{dir.name}</span>
            <span className="text-[11px] text-[#6e6e73]">folder</span>
          </button>
        ))}
        {files.map((file) => (
          <div
            key={file.path}
            onClick={() => setPreview(file)}
            className="flex cursor-pointer items-center gap-3 border-b border-[#f4f4f6] px-4 py-2.5 last:border-0 hover:bg-[#fafafa]"
            title="Open preview"
          >
            {file.media ? (
              <img
                loading="lazy"
                src={fileUrl(account.id, file.path)}
                alt={file.name}
                className="h-9 w-9 rounded-[6px] object-cover"
              />
            ) : (
              <span className="text-[16px]">📄</span>
            )}
            <span className="min-w-0 flex-1 truncate text-[13px]" title={file.name}>{displayName(file.name)}</span>
            <span className="text-[11px] text-[#6e6e73]">{bytes(file.size)}</span>
            <a
              href={fileUrl(account.id, file.path, true)}
              onClick={(event) => event.stopPropagation()}
              className="text-[11px] text-[#0066cc] hover:underline"
            >
              Download
            </a>
            <span className="text-[11px] text-[#9a9aa0]">Open</span>
          </div>
        ))}
        {!dirs.length && !files.length ? (
          <p className="px-4 py-8 text-center text-[12px] text-[#6e6e73]">This folder is empty.</p>
        ) : null}
      </div>

      {preview ? (
        <PreviewModal accountId={account.id} item={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
