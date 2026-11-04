/* Tiny TTL cache.  Geo lookups are the only thing that needs it: one provider
 * request per visitor per half day instead of one per page view. */

export class TtlCache {
  constructor({ ttlMs, max = 5000 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) {
      // Map keeps insertion order, so the oldest entry is the first key.
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  clear() {
    this.map.clear();
  }
}
