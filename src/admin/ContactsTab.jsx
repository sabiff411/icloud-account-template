import { useMemo, useState } from "react";
import { Empty } from "./ui.jsx";

function values(list, key) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : item?.[key] ?? item?.value ?? ""))
    .filter(Boolean);
}

function text(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" · ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function person(contact) {
  const first = contact.firstName ?? contact.first_name ?? "";
  const last = contact.lastName ?? contact.last_name ?? "";
  const company = contact.companyName ?? contact.company ?? "";
  const name = [first, last].filter(Boolean).join(" ") || contact.name || company || "(no name)";
  const phones = values(contact.phones, "field");
  const emails = values(contact.emails, "field");
  const note = text(contact.notes ?? contact.note ?? "");
  return { name, phones, emails, company, note };
}

export default function ContactsTab({ contacts }) {
  const [filter, setFilter] = useState("");
  const list = useMemo(() => {
    const raw = Array.isArray(contacts?.contacts) ? contacts.contacts : [];
    const mapped = raw.map(person);
    const needle = filter.trim().toLowerCase();
    if (!needle) return mapped;
    return mapped.filter((item) =>
      [item.name, item.company, item.note, ...item.phones, ...item.emails]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [contacts, filter]);

  if (!Array.isArray(contacts?.contacts)) {
    return <Empty title="Contacts are not exported yet">Run Export missing to fetch the address book.</Empty>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-[#6e6e73]">
          {list.length.toLocaleString()} shown · {contacts.contacts.length.toLocaleString()} total
        </span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search name, phone, email, company, note…"
          className="h-8 w-[300px] rounded-[8px] border border-[#d2d2d7] bg-white px-3 text-[12px] outline-none focus:border-[#0071e3]"
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-[12px] border border-[#e5e5ea] bg-white">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[#e5e5ea] text-[10px] uppercase tracking-[0.05em] text-[#6e6e73]">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Phones</th>
              <th className="px-3 py-2 font-medium">Emails</th>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, 1000).map((contact, index) => (
              <tr key={`${contact.name}-${index}`} className="border-b border-[#f4f4f6] last:border-0">
                <td className="px-3 py-2 font-medium">{contact.name}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-[#424245]">
                  {contact.phones.join(", ") || "—"}
                </td>
                <td className="px-3 py-2 text-[#424245]">{contact.emails.join(", ") || "—"}</td>
                <td className="px-3 py-2 text-[#6e6e73]">{contact.company || "—"}</td>
                <td className="px-3 py-2 text-[#6e6e73]" title={contact.note}>
                  {contact.note.length > 120 ? `${contact.note.slice(0, 120)}…` : contact.note || "—"}
                </td>
              </tr>
            ))}
            {!list.length ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[#6e6e73]">
                  No contact matches that search.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {list.length > 1000 ? (
        <p className="mt-2 text-[11px] text-[#6e6e73]">Showing the first 1,000 matches; refine the search.</p>
      ) : null}
    </div>
  );
}
