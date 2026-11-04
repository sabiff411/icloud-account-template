import { ProxyAgent } from "undici";

/* A round-robin pool of HTTP(S) proxies.
 *
 * Free geo APIs throttle by IP (ip-api.com allows 45 requests/minute, for
 * example).  Rotating the outbound IP spreads visitors over the proxies and
 * keeps one busy day from poisoning the whole deployment.
 *
 * This is deliberately process-local: for several Node workers put the proxy
 * list in a shared store, or give each worker a different slice. */

export class ProxyPool {
  constructor(urls = [], { timeoutMs = 4500 } = {}) {
    this.urls = urls;
    this.timeoutMs = timeoutMs;
    this.agents = new Map();
    this.cursor = 0;
  }

  get size() {
    return this.urls.length;
  }

  /** Proxy URLs in the order this lookup should try them. */
  candidates() {
    if (this.urls.length === 0) return [];
    const start = this.cursor % this.urls.length;
    this.cursor = (this.cursor + 1) % this.urls.length;
    return this.urls.map((_, i) => this.urls[(start + i) % this.urls.length]);
  }

  agentFor(url) {
    if (!this.agents.has(url)) {
      this.agents.set(
        url,
        new ProxyAgent({ uri: url, requestTls: { timeout: this.timeoutMs } })
      );
    }
    return this.agents.get(url);
  }

  close() {
    for (const agent of this.agents.values()) agent.close().catch(() => {});
    this.agents.clear();
  }
}
