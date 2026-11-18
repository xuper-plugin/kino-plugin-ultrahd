// scripts/feed-set.mjs: the set the Home job publishes on `data` and what it keeps on `main` for installed versions.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_AGE_MS, MAIN_EVERY_MS, META, argOf, carryPlan, cleanError, copyFeeds, feedPaths, isFeedPath, keyOfPath, mainPlan, metaOf, planLines,
} from "../scripts/feed-set.mjs";

const H = 3600000;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "feed-set-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("the readers' limit and main's cadence leave room for a missed day", () => {
  assert.equal(MAX_AGE_MS, 72 * H);
  assert.equal(MAIN_EVERY_MS, 36 * H);
  assert.ok(MAIN_EVERY_MS + 24 * H < MAX_AGE_MS);
});

test("feedPaths lists only sealed feeds, sorted; a missing subdir is empty and links are skipped", () => {
  const dir = tree({
    "home/b.enc.json": "{}", "home/a.es-419.enc.json": "{}", "home/a.enc.json": "{}", "home/index.json": "{}",
    "live/a.enc.json": "{}", "data-meta.json": "{}", "home/notes.txt": "x",
  });
  symlinkSync(join(dir, "home/a.enc.json"), join(dir, "home/z.enc.json"));
  assert.deepEqual(feedPaths(dir, ["home", "live", "nope"]), ["home/a.enc.json", "home/a.es-419.enc.json", "home/b.enc.json", "live/a.enc.json"]);
  assert.deepEqual(feedPaths(join(dir, "missing"), ["home"]), []);
});

test("paths and keys", () => {
  assert.equal(keyOfPath("home/1oij252.es-419.enc.json"), "1oij252");
  assert.equal(keyOfPath("live/vinhiu.enc.json"), "vinhiu");
  assert.ok(isFeedPath("home/abc.es-ES.enc.json") && isFeedPath("live/abc.enc.json"));
  for (const bad of ["home/index.json", "../home/a.enc.json", "home/../a.enc.json", "other/a.enc.json", "data-meta.json", "home/a/b.enc.json"]) {
    assert.equal(isFeedPath(bad), false, bad);
  }
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
  const written = new Map([["home/ok.enc.json", NOW]]);
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
  const from = tree({ "home/a.enc.json": "A", "live/a.enc.json": "L" });
  const to = mkdtempSync(join(tmpdir(), "feed-set-to-"));
  copyFeeds(from, to, ["home/a.enc.json", "live/a.enc.json"]);
  assert.equal(readFileSync(join(to, "home/a.enc.json"), "utf8"), "A");
  assert.equal(readFileSync(join(to, "live/a.enc.json"), "utf8"), "L");
  copyFeeds(from, from, ["home/a.enc.json"]);
  assert.equal(readFileSync(join(from, "home/a.enc.json"), "utf8"), "A");
  assert.throws(() => copyFeeds(from, to, ["../x.enc.json"]), /not a feed path/);
  assert.equal(existsSync(join(to, "..", "x.enc.json")), false);
});

test("metaOf is plain: run time, the limit and each path's builtAt", () => {
  const set = new Map([["home/b.enc.json", NOW - H], ["home/a.enc.json", NOW]]);
  const meta = metaOf({ set, carried: new Set(["home/b.enc.json"]), now: NOW });
  assert.equal(META, "data-meta.json");
  assert.equal(meta.v, 1);
  assert.equal(meta.at, NOW);
  assert.equal(meta.maxAgeMs, MAX_AGE_MS);
  assert.deepEqual(Object.keys(meta.files), ["home/a.enc.json", "home/b.enc.json"]);
  assert.deepEqual(meta.files["home/a.enc.json"], { builtAt: NOW });
  assert.deepEqual(meta.files["home/b.enc.json"], { builtAt: NOW - H, carried: true });
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
