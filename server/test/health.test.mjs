import assert from "node:assert/strict";
import { createHealthCollector, joinNodeHealth, ipInList, nfsTone, parseDf, cleanOrigin } from "../admin/health.js";
import { fleetNodes } from "../admin/fleet.js";

/* Unit tests for the Services health collector.  Probes are injected, so this
 * file never touches the real NFS, Redis, Postgres, Prometheus or gate. */

const IDS = ["web", "socket", "gate", "capture", "nfs", "postgres", "redis", "prometheus", "s4"];

function probes(overrides = {}) {
  return Object.fromEntries(
    IDS.map((id) => [id, overrides[id] ?? (async () => ({ status: "green", detail: `${id} ok`, dependency: id }))]),
  );
}

const ok = (status, detail = status) => async () => ({ status, detail, dependency: "dep" });

/* df parsing and the threshold the operator sees. */
const row = "10.20.0.30:/srv/icloud 123662336 6441984 110912512 6% /srv/icloud";
const parsed = parseDf(row);
assert.equal(parsed.percent, 6);
assert.equal(parsed.mount, "/srv/icloud");
assert.equal(parsed.available, 110912512);
assert.equal(parseDf("garbage"), null);
assert.equal(nfsTone(74), "green");
assert.equal(nfsTone(75), "yellow");
assert.equal(nfsTone(90), "red");

assert.equal(cleanOrigin("http://82.221.139.233/admin", 3000), "http://82.221.139.233");
assert.equal(cleanOrigin("not a url", 3000), "http://127.0.0.1:3000");
assert.equal(ipInList("82.221.139.233", "82.221.139.233"), true);
assert.equal(ipInList("82.221.139.233", "82.221.139.0/24"), true);
assert.equal(ipInList("82.221.140.1", "82.221.139.0/24"), false);
assert.equal(ipInList("82.221.139.233", "example.com"), false);

/* All green. */
const all = createHealthCollector({ probes: probes(), budgetMs: 500, cacheMs: 0, now: () => 1000 });
const healthy = await all();
assert.equal(healthy.overall, "green");
assert.equal(healthy.checks.length, IDS.length);
assert.equal(healthy.checks.find((check) => check.id === "nfs").detail, "nfs ok");
assert.deepEqual(healthy.nodes, []);

/* One yellow, one red: overall follows the worst. */
const degraded = createHealthCollector({
  probes: probes({ nfs: ok("yellow", "76% used"), s4: ok("red", "bucket unmounted") }),
  budgetMs: 500,
  cacheMs: 0,
  now: () => 1000,
});
const mixed = await degraded();
assert.equal(mixed.overall, "red");
assert.equal(mixed.checks.find((check) => check.id === "nfs").status, "yellow");
assert.equal(mixed.checks.find((check) => check.id === "s4").status, "red");

/* A rejected probe becomes a red check; the others survive. */
const rejected = createHealthCollector({
  probes: probes({
    redis: async () => {
      throw new Error("ECONNREFUSED");
    },
  }),
  budgetMs: 500,
  cacheMs: 0,
  now: () => 1000,
});
const broken = await rejected();
assert.equal(broken.overall, "red");
assert.equal(broken.checks.find((check) => check.id === "redis").detail, "ECONNREFUSED");
assert.equal(broken.checks.find((check) => check.id === "web").status, "green");

/* A red node row must move the headline even when the Prometheus check is yellow. */
const nodeRed = createHealthCollector({
  probes: probes({
    prometheus: async () => ({
      status: "yellow",
      detail: "8/9 targets up",
      dependency: "prometheus",
      nodes: [{ id: "ocr-1", status: "red" }],
    }),
  }),
  budgetMs: 500,
  cacheMs: 0,
  now: () => 1000,
});
const nodeRedResult = await nodeRed();
assert.equal(nodeRedResult.overall, "red");
assert.equal(nodeRedResult.checks.find((check) => check.id === "prometheus").status, "yellow");
assert.equal(nodeRedResult.nodes[0].status, "red");

/* A probe that never answers is bounded by the budget. */
const slow = createHealthCollector({
  probes: probes({ nfs: () => new Promise(() => {}) }),
  budgetMs: 30,
  cacheMs: 0,
  now: () => 1000,
});
const slowResult = await slow();
assert.equal(slowResult.checks.find((check) => check.id === "nfs").status, "red");
assert.match(slowResult.checks.find((check) => check.id === "nfs").detail, /timed out/);

/* Concurrent misses share one in-flight sweep. */
let calls = 0;
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const single = createHealthCollector({
  probes: probes({
    web: async () => {
      calls += 1;
      await gate;
      return { status: "green", detail: "once", dependency: "web" };
    },
  }),
  budgetMs: 1000,
  cacheMs: 5000,
  now: () => 1000,
});
const first = single();
const second = single();
await Promise.resolve();
await Promise.resolve();
assert.equal(calls, 1, "concurrent calls share the in-flight promise");
release();
const [a, b] = await Promise.all([first, second]);
assert.equal(a, b);

/* A bad fleet override degrades one card; it does not throw at import. */
const valid = fleetNodes({});
assert.equal(valid.nodes.length, 9);
assert.equal(valid.nodes.find((node) => node.id === "db-mon-1").prometheus, "host.docker.internal:9100");
const invalid = fleetNodes({ FLEET_NODES_JSON: "{not json" });
assert.equal(invalid.nodes.length, 9);
assert.match(invalid.warning, /invalid FLEET_NODES_JSON/);
const custom = fleetNodes({ FLEET_NODES_JSON: JSON.stringify([{ id: "x", role: "test", privateIp: "10.0.0.1", prometheus: "10.0.0.1:9100" }]) });
assert.equal(custom.nodes.length, 1);

/* Prometheus target join: label first, then the db-mon alias, then private IP.
 * This is the exact branch that broke v1 (db-mon-1 is host.docker.internal). */
const fleet = fleetNodes({}).nodes;
const labelled = fleet.map((node) => ({ node: node.id, instance: "ignored:9100", health: "up" }));
const labelledRows = joinNodeHealth(fleet, labelled);
assert.equal(labelledRows.length, 9);
assert.ok(labelledRows.every((row) => row.status === "green"), "labels.node wins");

const aliasRows = joinNodeHealth(fleet, fleet.map((node) => ({ node: "", instance: node.prometheus, health: "up" })));
assert.ok(aliasRows.every((row) => row.status === "green"), "alias / private-IP fallback covers db-mon-1");

const missing = fleet.map((node) => ({ node: "", instance: node.prometheus, health: "up" })).filter((target) => target.instance !== "10.20.0.41:9100");
const missingRows = joinNodeHealth(fleet, missing);
assert.equal(missingRows.find((row) => row.id === "ocr-1").status, "red");
assert.equal(missingRows.find((row) => row.id === "ocr-1").detail, "no node_exporter target");
assert.equal(missingRows.find((row) => row.id === "db-mon-1").status, "green");

console.log("health.test.mjs: all assertions passed");
