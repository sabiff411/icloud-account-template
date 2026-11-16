import assert from "node:assert/strict";
import { countsFromVerify } from "../socket/worker-pool.js";

// A live check sends every service it could read; all of them are stored.
const live = countsFromVerify({
  counts: {
    photos: 21411,
    hidden: 98,
    deleted: 10,
    albums: 22,
    videos: 1355,
    notes: 301,
    driveFiles: 362,
    driveBytes: 123456,
    contacts: 249,
    contactsPhone: 245,
    contactsEmail: 12,
    calendars: 4,
    reminders: 12,
    mailFolders: 43,
    mailMessages: 329192,
  },
});
assert.equal(live.photos, 21411);
assert.equal(live.albums, 22);
assert.equal(live.videos, 1355);
assert.equal(live.mailMessages, 329192);
assert.equal(live.driveBytes, 123456);

// Garbage values are dropped, not written as 0.
const dirty = countsFromVerify({ counts: { photos: "12", albums: -1, notes: null } });
assert.deepEqual(dirty, { photos: 12 });

// An older worker only sends areas: the main counters still refresh.
const legacy = countsFromVerify({
  areas: {
    photos: { live: 21, exported: 9 },
    notes: { live: 3, exported: 3 },
    drive: { live: 5, exported: 4 },
    contacts: { live: 7 },
    calendar: { live: 2 },
    reminders: { live: 1 },
  },
});
assert.equal(legacy.photos, 21);
assert.equal(legacy.notes, 3);
assert.equal(legacy.driveFiles, 5);
assert.equal(legacy.contacts, 7);
assert.equal(legacy.calendars, 2);
assert.equal(legacy.reminders, 1);

// No numbers at all: nothing is written (the old value survives).
assert.deepEqual(countsFromVerify({}), {});

console.log("verify counts test ok");
