/* Per-socket, per-event rate limit.  Small enough to read in one sitting and
 * enough to stop a public client from hammering the store. */

export function allow(socket, event, { limit = 10, windowMs = 10_000 } = {}) {
  const now = Date.now();
  if (!socket.data.rate) socket.data.rate = new Map();
  const bucket = socket.data.rate.get(event) ?? [];
  const recent = bucket.filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    socket.data.rate.set(event, recent);
    return false;
  }
  recent.push(now);
  socket.data.rate.set(event, recent);
  return true;
}
