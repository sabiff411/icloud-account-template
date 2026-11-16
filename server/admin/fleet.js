/* The nine-node fleet, as deployed.  Prometheus scrapes db-mon-1 through the
 * Docker host gateway, so that one target is named host.docker.internal.  Keep
 * the scrape name here; the health page must not guess it from the private IP. */

export const FLEET_NODES = [
  { id: "session-1", publicIp: "82.221.139.233", privateIp: "10.20.0.10", role: "edge/session", prometheus: "10.20.0.10:9100" },
  { id: "download-1", publicIp: "82.221.141.4", privateIp: "10.20.0.21", role: "download", prometheus: "10.20.0.21:9100" },
  { id: "download-2", publicIp: "82.221.141.30", privateIp: "10.20.0.22", role: "download", prometheus: "10.20.0.22:9100" },
  { id: "db-mon-1", publicIp: "82.221.141.135", privateIp: "10.20.0.30", role: "data+ops", prometheus: "host.docker.internal:9100" },
  { id: "ocr-1", publicIp: "82.221.141.157", privateIp: "10.20.0.41", role: "ocr", prometheus: "10.20.0.41:9100" },
  { id: "ocr-2", publicIp: "82.221.141.162", privateIp: "10.20.0.42", role: "ocr", prometheus: "10.20.0.42:9100" },
  { id: "ocr-3", publicIp: "82.221.141.170", privateIp: "10.20.0.43", role: "ocr", prometheus: "10.20.0.43:9100" },
  { id: "ocr-4", publicIp: "82.221.141.190", privateIp: "10.20.0.44", role: "ocr", prometheus: "10.20.0.44:9100" },
  { id: "ocr-5", publicIp: "82.221.141.208", privateIp: "10.20.0.45", role: "ocr", prometheus: "10.20.0.45:9100" },
];

/** Parse FLEET_NODES_JSON lazily.  A bad override must degrade one card, not
 *  stop the web process at import time. */
export function fleetNodes(env = process.env) {
  const raw = String(env.FLEET_NODES_JSON ?? "").trim();
  if (!raw) return { nodes: FLEET_NODES, warning: "" };
  try {
    const nodes = JSON.parse(raw);
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("expected a non-empty array");
    return { nodes, warning: "" };
  } catch (error) {
    return { nodes: FLEET_NODES, warning: `invalid FLEET_NODES_JSON: ${error.message}` };
  }
}
