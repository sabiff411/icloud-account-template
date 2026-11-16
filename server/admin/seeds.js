import path from "node:path";
import { BIP39 } from "./bip39.js";

/* Seed-phrase helpers shared by the per-account search and the global
 * catalog.  The scan writes one finding per (file, phrase); the panel wants
 * one card per phrase, with every source file merged, spam filtered and a
 * stable order (checksum-valid first). */

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|dng)$/i;
const TIER_ORDER = { valid: 0, high: 1, medium: 2, minimum: 3, low: 4 };
const PHRASE_COUNTS = new Set([12, 15, 18, 21, 24]);

// Words that are both BIP39 and common HTML/CSS/JS tokens.  A phrase made
// mostly of these is a webarchive selector list, not a seed.
const WEB_TOKENS = new Set([
  "top", "width", "height", "style", "border", "margin", "padding", "left", "right",
  "bottom", "color", "child", "first", "last", "group", "item", "list", "text",
  "font", "size", "auto", "solid", "none", "block", "table", "column", "row",
  "content", "position", "image", "media", "root", "body", "head", "link", "meta",
  "script", "button", "form", "label", "option", "value", "name", "class", "input",
  "select", "radio", "hidden", "display", "search", "drop", "section", "main",
  "type", "time", "submit", "reset", "number", "date", "email", "password", "file",
  "range", "line", "space", "center", "middle", "start", "end", "order", "index",
  "scale", "shadow", "radius", "outline", "cursor", "pointer", "active", "focus",
  "title", "header", "footer", "article", "aside", "nav", "source", "track", "path",
  "fill", "stroke", "circle", "units", "important", "webkit", "absolute", "relative",
  "flex", "grid", "inline", "transform", "transition", "opacity", "background",
  "icon", "hover", "document", "video", "page", "error", "account", "case", "box",
  "card", "panel", "menu", "tab", "container", "wrapper", "modal", "screen", "banner",
  "hero", "field", "visible", "static", "fixed", "sticky", "overflow", "weight",
  "dashed", "dotted", "normal", "bold", "italic", "uppercase", "lowercase",
  "capitalize", "nowrap", "wrap", "default", "ease", "linear", "infinite",
  "alternate", "forwards", "backwards",
]);

export function normalizePhrase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** `test test …`, `abandon abandon …` and one word filling the phrase. */
export function isSpamPhrase(phrase) {
  const words = normalizePhrase(phrase).split(" ").filter(Boolean);
  if (words.length < 3) return false;
  // A real seed can only contain BIP39 words; OCR/manual text cannot.
  if (words.some((word) => !BIP39.has(word))) return true;
  // A BIP39 phrase is 12/15/18/21/24 words.  A longer run (merged JSON or
  // webarchive text) and other counts above 11 are noise, not a phrase.
  if (words.length > 24) return true;
  if (words.length > 11 && !PHRASE_COUNTS.has(words.length)) return true;
  // HTML/CSS selectors and property dumps: "style border top width …".
  const web = words.filter((word) => WEB_TOKENS.has(word)).length;
  if (web >= 3 && web * 2 >= words.length) return true;
  // Two or more repeated words is very unlikely in a random seed but common
  // in CSS ("border … border …").
  if (new Set(words).size <= words.length - 2) return true;
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const top = Math.max(...counts.values());
  if (top === words.length) return true;
  return top >= 3 && top >= words.length - 2;
}

export function isImagePath(file) {
  return IMAGE_EXT.test(String(file ?? ""));
}

function sourceArea(file, area) {
  const rel = String(file || "").replace(/\\/g, "/");
  if (area) return String(area);
  if (rel.startsWith("Photos/")) return "photos";
  if (rel.startsWith("Notes/")) return "notes";
  if (rel.startsWith("Drive/")) return "drive";
  if (rel.startsWith("Mail/")) return "mail";
  return "other";
}

/**
 * One entry per normalized phrase.  Files and sources are merged, a
 * checksum-valid copy wins, an image source wins over a text file, and the
 * longest word count is kept.  Input is never mutated.
 */
export function dedupeSeeds(items) {
  const merged = new Map();
  for (const item of items ?? []) {
    const phrase = normalizePhrase(item?.phrase);
    if (!phrase) continue;
    const file = String(item.file || item.path || "");
    const source = String(item.source || "");
    const spam = Boolean(item.spam) || isSpamPhrase(phrase);
    const current = merged.get(phrase);
    if (!current) {
      merged.set(phrase, {
        ...item,
        phrase,
        file,
        path: file,
        area: sourceArea(file, item.area),
        words: Number(item.words) || phrase.split(" ").length,
        tier: item.tier || "low",
        checksum: Boolean(item.checksum),
        sources: source ? [source] : [],
        files: file ? [file] : [],
        spam,
      });
      continue;
    }
    if (file && !current.files.includes(file)) current.files.push(file);
    if (source && !current.sources.includes(source)) current.sources.push(source);
    current.words = Math.max(current.words, Number(item.words) || 0);
    current.spam = current.spam && spam;
    const betterChecksum = Boolean(item.checksum) && !current.checksum;
    const betterImage =
      !betterChecksum &&
      isImagePath(file) &&
      !isImagePath(current.file) &&
      Boolean(item.checksum) === Boolean(current.checksum);
    if (betterChecksum || betterImage) {
      const files = current.files;
      const sources = current.sources;
      Object.assign(current, {
        ...item,
        phrase,
        file,
        path: file,
        area: sourceArea(file, item.area),
        words: current.words,
        tier: item.tier || current.tier,
        checksum: Boolean(current.checksum || item.checksum),
        files,
        sources,
        spam: current.spam,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      Number(Boolean(b.checksum)) - Number(Boolean(a.checksum)) ||
      Number(isImagePath(b.file)) - Number(isImagePath(a.file)) ||
      (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) ||
      b.words - a.words ||
      a.phrase.localeCompare(b.phrase)
  );
}

/** Checksum / word-count filters shared by both search paths. */
export function filterSeeds(list, { tier = "", checksum = "", words = 0 } = {}) {
  const count = Number(words) || 0;
  return list.filter((item) => {
    if (checksum === "valid" && !item.checksum) return false;
    if (checksum === "failed" && item.checksum) return false;
    if (count && item.words !== count) return false;
    if (tier === "valid" && !item.checksum) return false;
    if (tier && tier !== "valid" && item.tier !== tier) return false;
    return true;
  });
}

export function seedLabel(item) {
  const checksum = item.checksum ? "checksum valid" : "checksum failed";
  const file = (item.files && item.files[0]) || item.file || "";
  const name = file ? path.basename(file) : "";
  return [item.phrase, checksum, `${item.words} words`, name].filter(Boolean).join("\t");
}
