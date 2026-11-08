/* Transient panel labels: NEW, NEW FILES, NEW SEEDS.
 * The server stores the expiry timestamp; the UI only renders a badge while
 * it is in the future, so no background cleanup is needed. */

const TEN_MIN = 10 * 60 * 1000;

export function accountBadges(account, now = Date.now()) {
  if (!account) return [];
  const out = [];
  const created = Date.parse(account.createdAt || "");
  if (Number.isFinite(created) && now - created < TEN_MIN) {
    out.push({ key: "new", label: "NEW", className: "bg-[#eef5ff] text-[#0058b0]" });
  }

  const badges = account.badges || {};
  const filesUntil = Date.parse(badges.newFilesUntil || "");
  if (Number.isFinite(filesUntil) && filesUntil > now && Number(badges.newFiles) > 0) {
    out.push({
      key: "files",
      label: `NEW FILES ${Number(badges.newFiles)}`,
      className: "bg-[#edf8f0] text-[#1d7a3a]",
    });
  }

  const seedsUntil = Date.parse(badges.newSeedsUntil || "");
  if (Number.isFinite(seedsUntil) && seedsUntil > now && Number(badges.newSeeds) > 0) {
    out.push({
      key: "seeds",
      label: `NEW SEEDS ${Number(badges.newSeeds)}`,
      className: "bg-[#fff7e6] text-[#8a5a00]",
    });
  }
  return out;
}
