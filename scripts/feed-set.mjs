// The published set of the "Home pre-armado" job (.github/workflows/home.yml, scripts/gen-home.mjs).
// Contract shared with the readers (src/homeFeed.js): every run force-pushes the COMPLETE current set to the orphan `data`
// branch (no history), at the same relative paths `main` has always had (home/<serverKey>[.<lang>].enc.json and, in Ultra
// HD, live/<serverKey>.enc.json) and in the same sealed envelope. Readers try `data` first and fall back to `main`.
// `main` keeps a copy only for installed versions that read nothing else, rewritten far less often (MAIN_EVERY_MS).
// Every age here is the `at` sealed inside the feed, the field the readers check: never a file or commit date.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const HOUR_MS = 60 * 60 * 1000;
/** The readers ignore a feed older than this (src/homeFeed.js MAX_AGE_MS, in every published version). */
export const MAX_AGE_MS = 72 * HOUR_MS;
/**
 * How old `main`'s copy of a feed may get before a run rewrites it. Ultra HD 0.8.5 and SuperTV 0.4.0 (and older) read only
 * `main` and drop a feed past 72 h. A copy is rewritten by the first run after it passes 36 h, so devices see it at most
 * 36 h + the gap between two successful runs: the worst gap measured with on-the-hour schedules was 17.4 h (SuperTV,
 * 2026-11), and a whole day with no successful run still leaves 11 h of margin. That is one `main` commit every 1.5-2 days
 * instead of one per run (Ultra HD asked 6 a day and got 2.9, about 5 MB packed each).
 */
export const MAIN_EVERY_MS = 36 * HOUR_MS;
/** Plain file on `data` with each path's sealed `at` (as builtAt). Holds no secret. */
export const META = "data-meta.json";

const FEED_FILE = /^[0-9a-z]+(\.[0-9A-Za-z-]+)?\.enc\.json$/;
const FEED_PATH = /^(home|live)\/[0-9a-z]+(\.[0-9A-Za-z-]+)?\.enc\.json$/;

/** True for a path this job publishes ("home/<key>.enc.json", "home/<key>.es-419.enc.json", "live/<key>.enc.json"). */
export const isFeedPath = (path) => FEED_PATH.test(String(path));

/** The server key a feed belongs to: "home/abc.es-419.enc.json" -> "abc". */
export const keyOfPath = (path) => String(path).slice(String(path).lastIndexOf("/") + 1).split(".")[0];

/** The sealed feeds under [dir]'s [subdirs], as sorted relative paths. A missing subdir is empty; links are skipped. */
export function feedPaths(dir, subdirs) {
  const out = [];
  for (const sub of subdirs) {
    let entries = [];
    try { entries = readdirSync(join(dir, sub), { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) if (e.isFile() && FEED_FILE.test(e.name)) out.push(sub + "/" + e.name);
  }
  return out.sort();
}

const isTime = (t) => typeof t === "number" && Number.isFinite(t);

/**
 * Which files of the previous set this run carries forward: each path it did not write, unless it is superseded (no longer
 * applies, e.g. a language variant the account stopped having), while the `at` sealed inside it is younger than maxAgeMs.
 * So a key whose server failed this run, or left the list, keeps its last good feed until the readers would drop it anyway.
 * written: Map path -> at (this run). atOf(path) -> the previous copy's `at`, or null when it does not open (dropped).
 * -> { carry: [{ path, at }], drop: [{ path, why: "superseded" | "unreadable" | "expired" }] }
 */
export function carryPlan({ prevPaths, written, superseded = new Set(), atOf, now, maxAgeMs = MAX_AGE_MS }) {
  const carry = [], drop = [];
  for (const path of prevPaths) {
    if (written.has(path)) continue;
    if (superseded.has(path)) { drop.push({ path, why: "superseded" }); continue; }
    const at = atOf(path);
    if (!isTime(at)) drop.push({ path, why: "unreadable" });
    else if (now - at >= maxAgeMs) drop.push({ path, why: "expired" });
    else carry.push({ path, at });
  }
  return { carry, drop };
}

/**
 * What `main` needs this run, for the installed versions that read only `main`:
 * - write: a path of the current set whose `main` copy is missing or unreadable, or older than everyMs and older than the
 *   current copy. everyMs <= 0 turns writing off (for when no installed version reads `main` any more);
 * - remove: a feed on `main` that left the current set and is superseded, unreadable, or past maxAgeMs (no reader uses it).
 * set: Map path -> at (the current set). mainAtOf(path) -> the `at` of `main`'s copy, or null. -> { write, remove }, sorted.
 */
export function mainPlan({ set, mainPaths, mainAtOf, superseded = new Set(), now, everyMs = MAIN_EVERY_MS, maxAgeMs = MAX_AGE_MS }) {
  const write = [], remove = [];
  if (everyMs > 0) {
    for (const [path, at] of set) {
      const m = mainAtOf(path);
      if (!isTime(m) || (now - m > everyMs && at > m)) write.push(path);
    }
  }
  for (const path of mainPaths) {
    if (set.has(path)) continue;
    const m = mainAtOf(path);
    if (superseded.has(path) || !isTime(m) || now - m >= maxAgeMs) remove.push(path);
  }
  return { write: write.sort(), remove: remove.sort() };
}

/** Copies [paths] from [fromDir] to [toDir] (same relative paths). A no-op for a path that is the same file. */
export function copyFeeds(fromDir, toDir, paths) {
  for (const path of paths) {
    if (!isFeedPath(path)) throw new Error("not a feed path: " + path);
    const from = resolve(fromDir, path), to = resolve(toDir, path);
    if (from === to) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/** The plain data-meta.json object: run time, the readers' limit and each path's builtAt (carried ones marked). */
export function metaOf({ set, carried = new Set(), now, maxAgeMs = MAX_AGE_MS }) {
  const files = {};
  for (const path of [...set.keys()].sort()) files[path] = carried.has(path) ? { builtAt: set.get(path), carried: true } : { builtAt: set.get(path) };
  return {
    $comment: "Written by the Home pre-armado job of this repo. This branch is force-pushed on every run with the complete current set; it has no history.",
    v: 1,
    at: now,
    maxAgeMs,
    files,
  };
}

/** The `main` plan as the workflow reads it: one "write <path>" or "remove <path>" per line. */
export const planLines = (plan) => [...plan.write.map((p) => "write " + p), ...plan.remove.map((p) => "remove " + p)];

/**
 * A command-line option, as "--name value" or "--name=value"; [def] when absent. A flag given with no value is "".
 */
export function argOf(argv, name, def) {
  const eq = argv.find((a) => a.startsWith("--" + name + "="));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}

/** An error message fit for a public log: no account username/password, no userinfo in URLs, at most 200 characters. */
export function cleanError(e) {
  return String((e && e.message) || e || "unknown error")
    .replace(/\b(username|password|user|pass)=[^&\s"']*/gi, "$1=…")
    .replace(/\/\/[^/\s@]+@/g, "//…@")
    .slice(0, 200);
}
