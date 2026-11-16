import assert from "node:assert/strict";
import { dedupeSeeds, filterSeeds, isSpamPhrase, seedLabel } from "../admin/seeds.js";
import { BIP39 } from "../admin/bip39.js";

/* Seed identity, spam and filters. */

const SAMPLE = [...BIP39].slice(0, 24);

const GOOD = "again empty warm hip fat allow broccoli turn finger insane hunt service";
const OTHER = "victory split joke recall detect rather crack fabric immense cotton actor hidden";

assert.equal(isSpamPhrase("test test test test test test test test test test test test"), true);
assert.equal(
  isSpamPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
  true,
  "the canonical test vector is still one word filling the phrase"
);
assert.equal(isSpamPhrase("abandon abandon abandon"), true);
assert.equal(isSpamPhrase("style border top width border top style solid"), true);
assert.equal(
  isSpamPhrase("section main input type time section main input type"),
  true,
  "HTML/CSS tokens are not a seed"
);
assert.equal(
  isSpamPhrase(
    "bedienungsanleitung air beruhrungssensor sekunden mikrofon ladeschale ladekontakt led usb sekunden"
  ),
  true,
  "a document paragraph contains non-BIP39 words"
);
assert.equal(
  isSpamPhrase("victory split joke recall detect rather crack fabric immense cotton actor actor"),
  false,
  "one repeated word is still a possible seed"
);
assert.equal(
  isSpamPhrase(SAMPLE.slice(0, 17).join(" ")),
  true,
  "17 words is not a BIP39 length"
);
assert.equal(
  isSpamPhrase(SAMPLE.slice(0, 24).join(" ")),
  false,
  "24 distinct BIP39 words are a valid length"
);
assert.equal(
  isSpamPhrase([...SAMPLE.slice(0, 24), ...SAMPLE.slice(0, 6)].join(" ")),
  true,
  "merged prose longer than 24 words is noise"
);
assert.equal(isSpamPhrase(GOOD), false);
assert.equal(isSpamPhrase(OTHER), false);

const merged = dedupeSeeds([
  { file: "Notes/txt/a.txt", phrase: GOOD, words: 12, tier: "high", checksum: true, source: "note" },
  { file: "Notes/html/assets/b.png", phrase: ` ${GOOD.toUpperCase()} `, words: 12, tier: "high", checksum: true, source: "ocr" },
  { file: "Notes/txt/c.txt", phrase: GOOD, words: 12, tier: "high", checksum: false, source: "note" },
  { file: "Notes/txt/d.txt", phrase: OTHER, words: 12, tier: "high", checksum: false, source: "note" },
]);
assert.equal(merged.length, 2, "one entry per phrase");
const good = merged.find((item) => item.phrase === GOOD);
assert.ok(good, "phrase normalized to one entry");
assert.deepEqual(good.files.sort(), ["Notes/html/assets/b.png", "Notes/txt/a.txt", "Notes/txt/c.txt"]);
assert.equal(good.file, "Notes/html/assets/b.png", "an image source wins");
assert.equal(good.checksum, true);

assert.equal(filterSeeds(merged, { checksum: "valid" }).length, 1);
assert.equal(filterSeeds(merged, { checksum: "failed" }).length, 1);
assert.equal(filterSeeds(merged, { words: 12 }).length, 2);
assert.equal(filterSeeds(merged, { words: 24 }).length, 0);
assert.equal(filterSeeds(merged, { tier: "high" }).length, 2);

const line = seedLabel(good);
assert.ok(line.startsWith(GOOD));
assert.ok(line.includes("12 words"));
assert.ok(line.includes("checksum valid"));

console.log("seeds test ok");
