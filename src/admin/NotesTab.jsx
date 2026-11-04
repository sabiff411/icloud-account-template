import { useEffect, useMemo, useState } from "react";
import { accountUrl, bytes, fileUrl, getJson, getText } from "./api.js";
import { Empty, Spinner } from "./ui.jsx";

export default function NotesTab({ account }) {
  const [files, setFiles] = useState([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getJson(accountUrl(account.id, "tree", { path: "Notes/txt" }))
      .then((result) => {
        if (!alive) return;
        setFiles(result.files || []);
        setSelected(result.files?.[0]?.path || "");
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
  }, [account.id]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setReading(true);
    getText(fileUrl(account.id, selected))
      .then((text) => {
        if (alive) {
          setBody(text);
          setReading(false);
        }
      })
      .catch((failure) => {
        if (alive) {
          setBody(`Could not read this note: ${failure.message}`);
          setReading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [account.id, selected]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => file.name.toLowerCase().includes(needle));
  }, [files, filter]);

  if (loading) return <Spinner label="Loading notes" />;
  if (error) return <Empty title="Notes are not exported yet">{error}</Empty>;

  return (
    <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
      <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
        <div className="border-b border-[#f0f0f2] p-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter notes…"
            className="h-8 w-full rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          {visible.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelected(file.path)}
              className={`block w-full border-b border-[#f4f4f6] px-3 py-2 text-left ${
                selected === file.path ? "bg-[#eef5ff]" : "hover:bg-[#fafafa]"
              }`}
            >
              <div className="truncate text-[12px] font-medium text-[#1d1d1f]">{file.name}</div>
              <div className="text-[10px] text-[#6e6e73]">{bytes(file.size)}</div>
            </button>
          ))}
          {!visible.length ? <p className="px-3 py-6 text-center text-[12px] text-[#6e6e73]">No notes.</p> : null}
        </div>
      </div>

      <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-[#f0f0f2] px-3 py-2">
          <span className="truncate text-[12px] font-medium text-[#1d1d1f]">
            {selected || "Select a note"}
          </span>
          {selected ? (
            <a
              href={fileUrl(account.id, selected, true)}
              className="text-[11px] text-[#0066cc] hover:underline"
            >
              Download
            </a>
          ) : null}
        </div>
        <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-4 text-[13px] leading-6 text-[#1d1d1f]">
          {reading ? "Loading…" : body || "This note has no text."}
        </pre>
      </div>
    </div>
  );
}
