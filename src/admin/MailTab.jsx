import { useMemo, useState } from "react";
import { Empty } from "./ui.jsx";
import { fileUrl, getJson } from "./api.js";

function pretty(value) {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export default function MailTab({ account, messages, index }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [body, setBody] = useState("");
  const [reading, setReading] = useState(false);

  const list = useMemo(() => {
    const rows = Array.isArray(messages) ? messages : [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((message) =>
      [
        message.subject,
        message.sender,
        message.to,
        message.cc,
        message.folder?.name,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [messages, filter]);

  async function open(message) {
    setSelected(message);
    setBody("");
    if (!message?.path) return;
    setReading(true);
    try {
      const data = await getJson(fileUrl(account.id, message.path));
      const parts = data?.body?.parts || [];
      const text = parts
        .map((part) => part?.content || "")
        .filter(Boolean)
        .join("\n\n");
      setBody(text || "(no readable body)");
    } catch (failure) {
      setBody(`Could not read this message: ${failure.message}`);
    } finally {
      setReading(false);
    }
  }

  if (index?.available === false) {
    return (
      <Empty title="iCloud Mail is not exported">
        {index.reason || "The installed pyicloud has no Mail service."} Install
        the main/2026.10.2+ build, then run Export missing.
      </Empty>
    );
  }

  if (!Array.isArray(messages) || !messages.length) {
    return (
      <Empty title="Mail is not exported yet">
        Run Export missing to fetch folders and messages.
      </Empty>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
      <div className="rounded-[12px] border border-[#e5e5ea] bg-white">
        <div className="border-b border-[#f0f0f2] p-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search subject, sender, recipient…"
            className="h-8 w-full rounded-[8px] border border-[#d2d2d7] px-3 text-[12px] outline-none focus:border-[#0071e3]"
          />
          <p className="mt-1 text-[10px] text-[#6e6e73]">
            {list.length.toLocaleString()} of {messages.length.toLocaleString()} messages
            {index?.attachments ? ` · ${index.attachments} attachments` : ""}
          </p>
        </div>
        <div className="max-h-[560px] overflow-y-auto">
          {list.slice(0, 2000).map((message) => (
            <button
              key={message.path || message.id}
              type="button"
              onClick={() => open(message)}
              className={`block w-full border-b border-[#f4f4f6] px-3 py-2 text-left last:border-0 hover:bg-[#f7f9fc] ${
                selected?.id === message.id ? "bg-[#eef5ff]" : ""
              }`}
            >
              <div className="truncate text-[12px] font-medium">
                {message.subject || "(no subject)"}
              </div>
              <div className="truncate text-[11px] text-[#6e6e73]">
                {pretty(message.sender)} · {message.folder?.name || ""}
              </div>
            </button>
          ))}
          {!list.length ? (
            <p className="px-3 py-8 text-center text-[12px] text-[#6e6e73]">
              No message matches that search.
            </p>
          ) : null}
        </div>
      </div>

      <div className="rounded-[12px] border border-[#e5e5ea] bg-white p-4">
        {!selected ? (
          <p className="text-[13px] text-[#6e6e73]">Select a message to read it.</p>
        ) : (
          <>
            <h2 className="text-[15px] font-semibold">{selected.subject || "(no subject)"}</h2>
            <p className="mt-1 text-[11px] text-[#6e6e73]">
              From {pretty(selected.sender)} · To {pretty(selected.to)}
            </p>
            <p className="text-[11px] text-[#6e6e73]">
              {selected.folder?.name || ""} · {selected.date || ""}
            </p>
            <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#1d1d1f]">
              {reading ? "Reading…" : body}
            </pre>
            {selected.attachments?.length ? (
              <p className="mt-2 text-[11px] text-[#6e6e73]">
                Attachments: {selected.attachments.join(", ")}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
