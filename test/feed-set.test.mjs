// scripts/feed-set.mjs: the set the Home job publishes on `data` and what it keeps on `main` for installed versions.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  MAX_AGE_MS, MAIN_EVERY_MS, META, argOf, capRails, carryPlan, cleanError, copyFeeds, deriveV2, feedPaths, gzipText, isFeedPath,
  isV2Path, keyOfPath, mainPlan, metaOf, openFeed, planLines, sealFeed, sealedAt, sizeWin, sizesOf, v1PathOf, v2PathOf,
  versionOfPath,
} from "../scripts/feed-set.mjs";
import { createKino } from "../sdk/kino-shim.mjs";
import { validateManifest } from "../sdk/contract.mjs";

const H = 3600000;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const root = fileURLToPath(new URL("..", import.meta.url));

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "feed-set-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

// A Home feed shaped like SuperTV's (tabs of rails) with Ultra HD's fields too, longer than any cap.
function feedObj(serverKey, at = NOW) {
  const rail = (t, r) => ({
    id: `lcat-${t}${r}`, catId: String(100 * t.length + r), title: `Categoría ${t} ${r} — ñandú`, ref: `lcat:${r}`,
    items: Array.from({ length: 20 }, (_, i) => ({ id: `c${r}-${i}`, ref: `live:${r}${i}|${r}|cat|canal`, title: `Canal ${i} HD`, kind: "live", poster: `https://img.example/${r}/${i}.png` })),
  });
  const tabs = Object.fromEntries(["all", "premium", "paises"].map((t) => [t, Array.from({ length: 12 }, (_, r) => rail(t, r))]));
  return { v: 1, at, serverKey, lang: "es-419", langs: ["es-419", "es-ES"], tabs, rows: tabs.all.slice(0, 11), slides: [{ id: "s1", title: "Película", overview: "Sinopsis con acentos: acción" }] };
}
const capTabs = (obj, rails, items) => ({ ...obj, tabs: Object.fromEntries(Object.entries(obj.tabs).map(([t, r]) => [t, capRails(r, rails, items)])) });

test("the readers' limit and main's cadence leave room for a missed day", () => {
  assert.equal(MAX_AGE_MS, 72 * H);
  assert.equal(MAIN_EVERY_MS, 36 * H);
  assert.ok(MAIN_EVERY_MS + 24 * H < MAX_AGE_MS);
});

test("feedPaths lists only sealed feeds and their v2 copies, sorted; a missing subdir is empty and links are skipped", () => {
  const dir = tree({
    "home/b.enc.json": "{}", "home/a.es-419.enc.json": "{}", "home/a.enc.json": "{}", "home/index.json": "{}",
    "live/a.enc.json": "{}", "data-meta.json": "{}", "home/notes.txt": "x",
    "home/a.v2.enc.json": "{}", "home/a.es-419.v2.enc.json": "{}", "live/a.v2.enc.json": "{}", "home/a.v2.v2.enc.json": "{}",
  });
  symlinkSync(join(dir, "home/a.enc.json"), join(dir, "home/z.enc.json"));
  assert.deepEqual(feedPaths(dir, ["home", "live", "nope"]), [
    "home/a.enc.json", "home/a.es-419.enc.json", "home/a.es-419.v2.enc.json", "home/a.v2.enc.json", "home/b.enc.json",
    "live/a.enc.json", "live/a.v2.enc.json",
  ]);
  assert.deepEqual(feedPaths(join(dir, "missing"), ["home"]), []);
});

test("paths and keys, v1 and v2", () => {
  assert.equal(keyOfPath("home/1oij252.es-419.enc.json"), "1oij252");
  assert.equal(keyOfPath("live/vinhiu.enc.json"), "vinhiu");
  assert.equal(keyOfPath("home/1oij252.es-419.v2.enc.json"), "1oij252");
  assert.equal(keyOfPath("live/vinhiu.v2.enc.json"), "vinhiu");
  assert.ok(isFeedPath("home/abc.es-ES.enc.json") && isFeedPath("live/abc.enc.json"));
  assert.ok(isFeedPath("home/abc.es-ES.v2.enc.json") && isFeedPath("home/abc.v2.enc.json") && isFeedPath("live/abc.v2.enc.json"));
  for (const bad of ["home/index.json", "../home/a.enc.json", "home/../a.enc.json", "other/a.enc.json", "data-meta.json", "home/a/b.enc.json", "home/a.v2.v2.enc.json", "home/a.es-419.x.v2.enc.json"]) {
    assert.equal(isFeedPath(bad), false, bad);
  }
  assert.equal(v2PathOf("home/abc.es-419.enc.json"), "home/abc.es-419.v2.enc.json");
  assert.equal(v2PathOf("live/abc.enc.json"), "live/abc.v2.enc.json");
  assert.equal(v2PathOf("home/abc.v2.enc.json"), "home/abc.v2.enc.json");
  assert.equal(v1PathOf("home/abc.es-419.v2.enc.json"), "home/abc.es-419.enc.json");
  assert.equal(v1PathOf("home/abc.enc.json"), "home/abc.enc.json");
  assert.ok(isV2Path("home/abc.v2.enc.json") && !isV2Path("home/abc.enc.json"));
  assert.equal(versionOfPath("live/abc.v2.enc.json"), 2);
  assert.equal(versionOfPath("live/abc.enc.json"), 1);
});

test("v2 is gzip with mtime 0 under the same AES-256-GCM envelope with v 2; the IV stays random", () => {
  const key = randomBytes(32), obj = feedObj("k1");
  const box1 = JSON.parse(sealFeed(obj, key, 1)), box2 = JSON.parse(sealFeed(obj, key, 2));
  assert.deepEqual(Object.keys(box1), ["v", "iv", "data"]);
  assert.deepEqual(Object.keys(box2), ["v", "iv", "data"]);
  assert.equal(box1.v, 1);
  assert.equal(box2.v, 2);
  assert.equal(Buffer.from(box2.iv, "base64").length, 12);
  assert.notEqual(JSON.parse(sealFeed(obj, key, 2)).iv, box2.iv);
  const gz = gzipText(JSON.stringify(obj));
  assert.deepEqual([...gz.subarray(0, 3)], [0x1f, 0x8b, 8]);
  assert.equal(gz.readUInt32LE(4), 0, "mtime");
  assert.equal(gz[9], 255, "OS unknown");
  assert.ok(gz.length < JSON.stringify(obj).length / 3, `${gz.length} gzip bytes`);
  // The v2 ciphertext is the gzip's length plus the tag; v1's is the JSON's.
  assert.equal(Buffer.from(box2.data, "base64").length, gz.length + 16);
  assert.equal(Buffer.from(box1.data, "base64").length, Buffer.byteLength(JSON.stringify(obj)) + 16);
  assert.throws(() => sealFeed(obj, key, 3), /unknown feed version/);
});

test("v1 and v2 open to the same object (minus the cap), in Node and with the plugin's own kino.crypto calls", () => {
  const hex = randomBytes(32).toString("hex"); // a throwaway key, never a real FEED_KEY
  const key = Buffer.from(hex, "hex");
  const obj = feedObj("k1");
  const capped = capTabs(obj, 8, 10);
  const enc1 = sealFeed(obj, key, 1), enc2 = sealFeed(capped, key, 2), enc2full = sealFeed(obj, key, 2);
  // Node (the producer's own reader: previous sets, main's copies).
  assert.deepEqual(openFeed(enc1, key), { v: 1, obj });
  assert.deepEqual(openFeed(enc2, key), { v: 2, obj: capped });
  assert.deepEqual(openFeed(enc2full, key), { v: 2, obj });
  assert.equal(openFeed(enc2, randomBytes(32)), null);
  assert.equal(openFeed("not json", key), null);
  assert.equal(openFeed(JSON.stringify({ v: 3, iv: "", data: "" }), key), null);
  // The cap: 8 rails of 10 items per tab, every other field as v1 has it.
  for (const t of Object.keys(obj.tabs)) {
    assert.equal(capped.tabs[t].length, 8);
    assert.ok(capped.tabs[t].every((r) => r.items.length === 10));
    assert.deepEqual(capped.tabs[t], obj.tabs[t].slice(0, 8).map((r) => ({ ...r, items: r.items.slice(0, 10) })));
  }
  assert.deepEqual({ ...capped, tabs: null }, { ...obj, tabs: null });

  // The plugin's way, through the kit's kino.crypto with the manifest's sealed feedKey (a typed hex cipher key).
  const dir = mkdtempSync(join(tmpdir(), "feed-set-kit-"));
  writeFileSync(join(dir, "x.json"), JSON.stringify({ feedKey: hex }));
  const { manifest } = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
  const { kino } = createKino(manifest, {
    storageFile: join(dir, "s.json"), cookiesFile: join(dir, "c.json"), secretsFile: join(dir, "x.json"), config: {}, env: {},
    fetchImpl: () => Promise.reject(new Error("no network in this test")),
  });
  const open1 = (text) => {
    const box = JSON.parse(text);
    assert.equal(box.v, 1);
    return JSON.parse(kino.crypto.decrypt("aes-256-gcm", { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data }));
  };
  const open2 = (text) => {
    const box = JSON.parse(text);
    assert.equal(box.v, 2);
    const gz = kino.crypto.decrypt("aes-256-gcm", { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data, outputEncoding: "base64" });
    return JSON.parse(kino.crypto.gunzip(gz));
  };
  assert.deepEqual(open1(enc1), obj);
  assert.deepEqual(open2(enc2), capped);
  assert.deepEqual(open2(enc2full), open1(enc1));
});

test("sealedAt reads the `at` only from the version and the server key the path names", () => {
  const key = randomBytes(32);
  const dir = tree({
    "home/k1.enc.json": sealFeed(feedObj("k1", NOW - H), key, 1),
    "home/k1.v2.enc.json": sealFeed(feedObj("k1", NOW - H), key, 2),
    "home/k2.enc.json": sealFeed(feedObj("k2"), key, 2), // a v2 envelope under a v1 name
    "home/k3.v2.enc.json": sealFeed(feedObj("k3"), key, 1), // a v1 envelope under a v2 name
    "home/k4.v2.enc.json": sealFeed(feedObj("other"), key, 2), // another account's
    "home/k5.enc.json": "{}",
  });
  assert.equal(sealedAt(dir, "home/k1.enc.json", key), NOW - H);
  assert.equal(sealedAt(dir, "home/k1.v2.enc.json", key), NOW - H);
  for (const p of ["home/k2.enc.json", "home/k3.v2.enc.json", "home/k4.v2.enc.json", "home/k5.enc.json", "home/missing.enc.json"]) assert.equal(sealedAt(dir, p, key), null, p);
  assert.equal(sealedAt(dir, "home/k1.enc.json", randomBytes(32)), null);
});

test("capRails keeps the first rails and items, and copes with short or odd input", () => {
  const rails = [{ id: "a", items: [1, 2, 3] }, { id: "b", items: [4] }, { id: "c", items: [5, 6] }];
  assert.deepEqual(capRails(rails, 2, 2), [{ id: "a", items: [1, 2] }, { id: "b", items: [4] }]);
  assert.deepEqual(rails[0].items, [1, 2, 3], "the input is not changed");
  assert.deepEqual(capRails(null, 8, 10), []);
  assert.deepEqual(capRails([null, { id: "x" }], 8, 10), [null, { id: "x" }]);
});

test("carryPlan keeps what this run did not write while it is younger than 3 days", () => {
  const ats = {
    "home/ok.enc.json": NOW - 10 * H, // built this run: not carried
    "home/failed.enc.json": NOW - 30 * H, // its server failed this run: carried
    "live/failed.enc.json": NOW - 71 * H, // still under the limit: carried
    "home/gone.enc.json": NOW - 72 * H, // reached the limit: dropped
    "home/ok.es-ES.enc.json": NOW - 5 * H, // the account no longer has it: dropped
    "home/broken.enc.json": null, // does not open with the key: dropped
  };
  const written = new Map([["home/ok.enc.json", NOW], ["home/ok.v2.enc.json", NOW]]);
  const { carry, drop } = carryPlan({
    prevPaths: Object.keys(ats), written, superseded: new Set(["home/ok.es-ES.enc.json"]), atOf: (p) => ats[p], now: NOW,
  });
  assert.deepEqual(carry, [{ path: "home/failed.enc.json", at: NOW - 30 * H }, { path: "live/failed.enc.json", at: NOW - 71 * H }]);
  assert.deepEqual(drop, [
    { path: "home/gone.enc.json", why: "expired" },
    { path: "home/ok.es-ES.enc.json", why: "superseded" },
    { path: "home/broken.enc.json", why: "unreadable" },
  ]);
});

test("carryPlan: a v2 copy rides with its v1 file, and a carried v1 without its v2 copy gets one made", () => {
  const ats = {
    "home/a.enc.json": NOW - 30 * H, "home/a.v2.enc.json": NOW - 30 * H, // same build: both carried as they are
    "home/b.enc.json": NOW - 20 * H, // v1 only (the set before v2): carried, its v2 copy made from it
    "home/c.enc.json": NOW - 10 * H, "home/c.v2.enc.json": NOW - 40 * H, // v2 of another build: dropped, made again
    "home/d.enc.json": NOW - 80 * H, "home/d.v2.enc.json": NOW - 80 * H, // both expired
    "home/e.es-ES.enc.json": NOW - 5 * H, "home/e.es-ES.v2.enc.json": NOW - 5 * H, // superseded: both dropped
    "home/f.enc.json": null, "home/f.v2.enc.json": NOW - 5 * H, // v1 does not open: the v2 copy is kept on its own
    "home/g.v2.enc.json": NOW - 5 * H, // rebuilt this run: not carried
    "live/h.enc.json": NOW - 2 * H, "live/h.v2.enc.json": null, // v2 does not open: made again from v1
  };
  const written = new Map([["home/g.enc.json", NOW], ["home/g.v2.enc.json", NOW], ["home/w.enc.json", NOW]]);
  const { carry, drop, derive } = carryPlan({
    prevPaths: Object.keys(ats).sort(), written, superseded: new Set(["home/e.es-ES.enc.json"]), atOf: (p) => ats[p], now: NOW,
  });
  assert.deepEqual(carry, [
    { path: "home/a.enc.json", at: NOW - 30 * H }, { path: "home/a.v2.enc.json", at: NOW - 30 * H },
    { path: "home/b.enc.json", at: NOW - 20 * H }, { path: "home/c.enc.json", at: NOW - 10 * H },
    { path: "home/f.v2.enc.json", at: NOW - 5 * H }, { path: "live/h.enc.json", at: NOW - 2 * H },
  ]);
  assert.deepEqual(drop, [
    { path: "home/d.enc.json", why: "expired" }, { path: "home/d.v2.enc.json", why: "expired" },
    { path: "home/e.es-ES.enc.json", why: "superseded" }, { path: "home/e.es-ES.v2.enc.json", why: "superseded" },
    { path: "home/f.enc.json", why: "unreadable" }, { path: "live/h.v2.enc.json", why: "unreadable" },
    { path: "home/c.v2.enc.json", why: "mismatched" },
  ]);
  assert.deepEqual(derive, [
    { path: "home/w.v2.enc.json", from: "home/w.enc.json", at: NOW }, // written without its copy (never by gen-home)
    { path: "home/b.v2.enc.json", from: "home/b.enc.json", at: NOW - 20 * H },
    { path: "home/c.v2.enc.json", from: "home/c.enc.json", at: NOW - 10 * H },
    { path: "live/h.v2.enc.json", from: "live/h.enc.json", at: NOW - 2 * H },
  ]);
});

test("deriveV2 makes the v2 copy from the v1 file in place, through the plugin's cap, and skips one that is not that build", () => {
  const key = randomBytes(32);
  const b = feedObj("b", NOW - 20 * H), c = feedObj("c", NOW - 10 * H);
  const dir = tree({
    "home/b.enc.json": sealFeed(b, key, 1),
    "home/c.enc.json": sealFeed(c, key, 1),
    "home/x.enc.json": sealFeed(feedObj("x", NOW - 3 * H), key, 1), // planned for another `at`
  });
  const cap = (path, obj) => (path.startsWith("home/") ? capTabs(obj, 8, 10) : obj);
  const done = deriveV2({
    dir, key, v2Of: cap, derive: [
      { path: "home/b.v2.enc.json", from: "home/b.enc.json", at: NOW - 20 * H },
      { path: "home/c.v2.enc.json", from: "home/c.enc.json", at: NOW - 10 * H },
      { path: "home/x.v2.enc.json", from: "home/x.enc.json", at: NOW - 4 * H },
      { path: "home/m.v2.enc.json", from: "home/m.enc.json", at: NOW },
    ],
  });
  assert.deepEqual([...done], [["home/b.v2.enc.json", NOW - 20 * H], ["home/c.v2.enc.json", NOW - 10 * H]]);
  assert.deepEqual(openFeed(readFileSync(join(dir, "home/b.v2.enc.json"), "utf8"), key), { v: 2, obj: capTabs(b, 8, 10) });
  assert.equal(sealedAt(dir, "home/c.v2.enc.json", key), NOW - 10 * H);
  assert.equal(existsSync(join(dir, "home/x.v2.enc.json")), false);
  assert.equal(existsSync(join(dir, "home/m.v2.enc.json")), false);
  assert.throws(() => deriveV2({ dir, key, derive: [{ path: "home/b.enc.json", from: "home/b.enc.json", at: 0 }] }), /not a v2 copy/);
  assert.throws(() => deriveV2({ dir, key, derive: [{ path: "../b.v2.enc.json", from: "../b.enc.json", at: 0 }] }), /not a v2 copy/);
});

test("mainPlan rewrites a main copy only when it is missing or older than 36 h and older than the current one", () => {
  const set = new Map([
    ["home/new.enc.json", NOW], // never on main: written
    ["home/young.enc.json", NOW], // main copy 20 h old: left alone
    ["home/old.enc.json", NOW], // main copy 40 h old: rewritten
    ["home/carried.enc.json", NOW - 40 * H], // same copy as main's (carried, not rebuilt): left alone
    ["live/broken.enc.json", NOW], // main copy does not open: rewritten
  ]);
  const main = {
    "home/young.enc.json": NOW - 20 * H, "home/old.enc.json": NOW - 40 * H, "home/carried.enc.json": NOW - 40 * H, "live/broken.enc.json": null,
    "home/expired.enc.json": NOW - 80 * H, // left the set, past the readers' limit: removed
    "home/recent.enc.json": NOW - 30 * H, // left the set but a reader may still use it: kept
    "home/k.es-ES.enc.json": NOW - 3 * H, // superseded: removed (readers fall back to the default feed)
    "home/junk.enc.json": null, // left the set and does not open: removed
  };
  const plan = mainPlan({
    set, mainPaths: Object.keys(main), mainAtOf: (p) => (p in main ? main[p] : null), superseded: new Set(["home/k.es-ES.enc.json"]), now: NOW,
  });
  assert.deepEqual(plan.write, ["home/new.enc.json", "home/old.enc.json", "live/broken.enc.json"]);
  assert.deepEqual(plan.remove, ["home/expired.enc.json", "home/junk.enc.json", "home/k.es-ES.enc.json"]);
  assert.deepEqual(planLines(plan), [
    "write home/new.enc.json", "write home/old.enc.json", "write live/broken.enc.json",
    "remove home/expired.enc.json", "remove home/junk.enc.json", "remove home/k.es-ES.enc.json",
  ]);
  const off = mainPlan({ set, mainPaths: Object.keys(main), mainAtOf: (p) => (p in main ? main[p] : null), now: NOW, everyMs: 0 });
  assert.deepEqual(off.write, []);
  assert.deepEqual(off.remove, ["home/expired.enc.json", "home/junk.enc.json"]);
});

test("mainPlan never writes or removes a v2 copy: those live only on `data`", () => {
  const set = new Map([["home/a.enc.json", NOW], ["home/a.v2.enc.json", NOW], ["live/a.v2.enc.json", NOW]]);
  const main = { "home/a.v2.enc.json": null, "home/z.v2.enc.json": NOW - 90 * H };
  const plan = mainPlan({ set, mainPaths: Object.keys(main), mainAtOf: (p) => (p in main ? main[p] : null), now: NOW });
  assert.deepEqual(plan, { write: ["home/a.enc.json"], remove: [] });
});

test("over many runs with late and missing ones, main's copy never reaches the readers' limit", () => {
  // Gaps between successful runs, in hours: on time, late (measured up to 17.4 h), and a whole missed day.
  const gaps = [8, 8, 8, 13.8, 9, 15.6, 8.8, 17.4, 9.6, 14.4, 24, 8, 8, 30, 8, 8, 8, 8, 8, 8];
  let t = NOW, mainAt = NOW, maxAge = 0, writes = 0;
  for (let round = 0; round < 10; round++) {
    for (const g of gaps) {
      t += g * H;
      maxAge = Math.max(maxAge, t - mainAt); // what an installed version reading main sees just before this run
      const plan = mainPlan({ set: new Map([["home/k.enc.json", t]]), mainPaths: ["home/k.enc.json"], mainAtOf: () => mainAt, now: t });
      if (plan.write.length) { mainAt = t; writes++; }
    }
  }
  assert.ok(maxAge < MAX_AGE_MS, `max age ${maxAge / H} h`);
  const runs = gaps.length * 10;
  assert.ok(writes < runs / 3, `${writes} main writes in ${runs} runs`);
});

test("copyFeeds copies by relative path, skips a file onto itself and refuses anything but a feed path", () => {
  const from = tree({ "home/a.enc.json": "A", "live/a.enc.json": "L", "home/a.v2.enc.json": "A2" });
  const to = mkdtempSync(join(tmpdir(), "feed-set-to-"));
  copyFeeds(from, to, ["home/a.enc.json", "live/a.enc.json", "home/a.v2.enc.json"]);
  assert.equal(readFileSync(join(to, "home/a.enc.json"), "utf8"), "A");
  assert.equal(readFileSync(join(to, "live/a.enc.json"), "utf8"), "L");
  assert.equal(readFileSync(join(to, "home/a.v2.enc.json"), "utf8"), "A2");
  copyFeeds(from, from, ["home/a.enc.json"]);
  assert.equal(readFileSync(join(from, "home/a.enc.json"), "utf8"), "A");
  assert.throws(() => copyFeeds(from, to, ["../x.enc.json"]), /not a feed path/);
  assert.equal(existsSync(join(to, "..", "x.enc.json")), false);
});

test("metaOf is plain: run time, the limit and each path's builtAt, size and origin, v2 copies listed", () => {
  const set = new Map([
    ["home/b.enc.json", NOW - H], ["home/b.v2.enc.json", NOW - H], ["home/a.enc.json", NOW], ["home/a.v2.enc.json", NOW],
  ]);
  const sizes = new Map([["home/a.enc.json", 1000], ["home/a.v2.enc.json", 300], ["home/b.enc.json", 900], ["home/b.v2.enc.json", 250]]);
  const meta = metaOf({ set, carried: new Set(["home/b.enc.json", "home/b.v2.enc.json"]), derived: new Set(["home/b.v2.enc.json"]), sizes, now: NOW });
  assert.equal(META, "data-meta.json");
  assert.equal(meta.v, 1);
  assert.equal(meta.at, NOW);
  assert.equal(meta.maxAgeMs, MAX_AGE_MS);
  assert.deepEqual(Object.keys(meta.files), ["home/a.enc.json", "home/a.v2.enc.json", "home/b.enc.json", "home/b.v2.enc.json"]);
  assert.deepEqual(meta.files["home/a.enc.json"], { builtAt: NOW, bytes: 1000 });
  assert.deepEqual(meta.files["home/a.v2.enc.json"], { builtAt: NOW, bytes: 300 });
  assert.deepEqual(meta.files["home/b.enc.json"], { builtAt: NOW - H, bytes: 900, carried: true });
  assert.deepEqual(meta.files["home/b.v2.enc.json"], { builtAt: NOW - H, bytes: 250, carried: true, derived: true });
  assert.deepEqual(metaOf({ set: new Map([["home/a.enc.json", NOW]]), now: NOW }).files, { "home/a.enc.json": { builtAt: NOW } });
  assert.deepEqual(sizeWin(set, sizes), { files: 2, v1: 1900, v2: 550 });
});

test("sizesOf reads the size of each file there, and leaves out a missing one", () => {
  const dir = tree({ "home/a.enc.json": "12345", "home/a.v2.enc.json": "12" });
  assert.deepEqual([...sizesOf(dir, ["home/a.enc.json", "home/a.v2.enc.json", "home/b.enc.json"])], [["home/a.enc.json", 5], ["home/a.v2.enc.json", 2]]);
});

test("argOf reads --name value and --name=value", () => {
  const argv = ["node", "x", "--out", "/tmp/o", "--only=host.example:8080", "--flag", "--servers", "3"];
  assert.equal(argOf(argv, "out"), "/tmp/o");
  assert.equal(argOf(argv, "only"), "host.example:8080");
  assert.equal(argOf(argv, "flag", "d"), "");
  assert.equal(argOf(argv, "servers"), "3");
  assert.equal(argOf(argv, "missing", "def"), "def");
});

test("cleanError never lets an account's credentials into the log", () => {
  const e = new Error("fetch failed http://u1:p1@panel.example/player_api.php?username=alice&password=s3cret&action=get_live_categories");
  const msg = cleanError(e);
  assert.ok(!/alice|s3cret|u1:p1/.test(msg), msg);
  assert.match(msg, /panel\.example/);
  assert.equal(cleanError(new Error("x".repeat(500))).length, 200);
  assert.equal(cleanError(null), "unknown error");
});
