import { useMemo, useState } from "react";
import { Empty } from "./ui.jsx";

function title(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  return (
    value.title ||
    value.name ||
    value.summary ||
    value.displayName ||
    value.guid ||
    value.id ||
    "(untitled)"
  );
}

function CalendarView({ data }) {
  const calendars = Array.isArray(data?.calendars) ? data.calendars : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  if (!calendars.length && !events.length) return null;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-[12px] border border-[#e5e5ea] bg-white p-4">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
          Calendars ({calendars.length})
        </h3>
        <ul className="mt-2 space-y-1 text-[13px]">
          {calendars.map((calendar, index) => (
            <li key={index} className="flex items-center gap-2 border-b border-[#f4f4f6] py-1.5">
              <span className="text-[12px]">📅</span>
              {title(calendar)}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-[12px] border border-[#e5e5ea] bg-white p-4">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
          Events this month ({events.length})
        </h3>
        <ul className="mt-2 space-y-1 text-[13px]">
          {events.slice(0, 200).map((event, index) => (
            <li key={index} className="border-b border-[#f4f4f6] py-1.5">
              <div className="font-medium">{title(event)}</div>
              <div className="text-[11px] text-[#6e6e73]">
                {event.startDate || event.start || event.dueDate || ""}
              </div>
            </li>
          ))}
          {!events.length ? <li className="text-[#6e6e73]">No events.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function RemindersView({ data }) {
  const lists = Array.isArray(data) ? data : [];
  const [filter, setFilter] = useState("");
  const blocks = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lists.map((entry) => {
      const items = Array.isArray(entry.reminders) ? entry.reminders : [];
      return {
        list: title(entry.list),
        items: needle
          ? items.filter((item) => title(item).toLowerCase().includes(needle))
          : items,
      };
    });
  }, [lists, filter]);

  if (!lists.length) return null;
  return (
    <div>
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Search reminders…"
        className="mb-3 h-8 w-[280px] rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {blocks.map((block, index) => (
          <div key={index} className="rounded-[12px] border border-[#e5e5ea] bg-white p-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#6e6e73]">
              {block.list} ({block.items.length})
            </h3>
            <ul className="mt-2 space-y-1 text-[13px]">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="flex items-start gap-2 border-b border-[#f4f4f6] py-1.5">
                  <span className="mt-[1px] text-[12px]">{item.completed ? "☑" : "☐"}</span>
                  <span className={item.completed ? "text-[#86868b] line-through" : ""}>{title(item)}</span>
                </li>
              ))}
              {!block.items.length ? <li className="text-[#6e6e73]">Nothing here.</li> : null}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function JsonListTab({ kind, data }) {
  if (kind === "calendar") {
    if (!data?.calendars && !data?.events) {
      return <Empty title="Calendar is not exported yet">Run Export missing to fetch calendars.</Empty>;
    }
    return <CalendarView data={data} />;
  }
  if (!Array.isArray(data) || !data.length) {
    return <Empty title="Reminders are not exported yet">Run Export missing to fetch reminder lists.</Empty>;
  }
  return <RemindersView data={data} />;
}
