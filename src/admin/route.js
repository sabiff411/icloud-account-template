/* The panel's URL state: #/accounts/<id>/<tab>, #/library, #/blocks …
 *
 * The hash is the source of truth so a refresh (or a copied link) lands on the
 * same view, account and tab instead of the account list. */

const VIEWS = new Set([
  "accounts",
  "library",
  "crypto",
  "submissions",
  "services",
  "blocks",
  "favorites",
]);

export function parseRoute() {
  const raw = String(location.hash || "").replace(/^#\/?/, "");
  const [path, search] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(search || "");
  const view = VIEWS.has(parts[0]) ? parts[0] : "accounts";
  if (view === "accounts" && parts[1]) {
    return {
      view,
      accountId: parts[1],
      tab: parts[2] || "overview",
      area: params.get("area") || "",
      kind: params.get("kind") || "",
      q: params.get("q") || "",
      favorite: params.get("favorite") === "1",
    };
  }
  return { view, accountId: "", tab: "", area: "", kind: "", q: "", favorite: false };
}

export function writeRoute(route, replace = true) {
  let path = route.view || "accounts";
  const params = new URLSearchParams();
  if (route.area) params.set("area", route.area);
  if (route.kind) params.set("kind", route.kind);
  if (route.q) params.set("q", route.q);
  if (route.favorite) params.set("favorite", "1");
  if (route.accountId) path = `accounts/${route.accountId}/${route.tab || "overview"}`;
  const suffix = params.toString() ? `?${params}` : "";
  const hash = `#/${path}${suffix}`;
  if (location.hash === hash) return;
  const method = replace ? "replaceState" : "pushState";
  history[method]({ ...route }, "", hash);
}
