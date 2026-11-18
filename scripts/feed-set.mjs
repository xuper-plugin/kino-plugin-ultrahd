// The published set of the "Home pre-armado" job (.github/workflows/home.yml, scripts/gen-home.mjs).
// Contract shared with the readers (src/homeFeed.js): every run force-pushes the COMPLETE current set to the orphan `data`
// branch (no history), at the same relative paths `main` has always had (home/<serverKey>[.<lang>].enc.json and, in Ultra
// HD, live/<serverKey>.enc.json) and in the same sealed envelope. Readers try `data` first and fall back to `main`.
// `main` keeps a copy only for installed versions that read nothing else, rewritten far less often (MAIN_EVERY_MS).
// Every age here is the `at` sealed inside the feed, the field the readers check: never a file or commit date.
//
// Feed v2. Next to every feed, `data` (never `main`) also carries a compressed copy at the same path with `.v2.enc.json` in
// place of `.enc.json` (home/<serverKey>[.<lang>].v2.enc.json, live/<serverKey>.v2.enc.json). Its envelope is v1's with
// "v": 2, and its AES-256-GCM plaintext is the gzip (mtime 0) of the UTF-8 JSON of the same object; the IV stays random. A
// plugin may cap what its v2 copy carries (SuperTV's Home: what one screen can draw). A reader opens it with
// kino.crypto.decrypt(..., outputEncoding "base64") and kino.crypto.gunzip. The readers after Ultra HD 0.8.6 and SuperTV
// 0.4.1 try data/<path>.v2.enc.json, then main/<path>.enc.json. The v1 files stay exactly as they were: 0.8.5 and 0.4.0
// read main's v1, 0.8.6 and 0.4.1 read data's v1, then main's. A v2 copy always belongs to the same build as its v1 file
// (same `at`), is carried forward and dropped with the same rules, and never goes to `main`.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

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
/** Plain file on `data` with each path's sealed `at` (as builtAt) and size. Holds no secret. */
export const META = "data-meta.json";

// A language part is never "v2": "abc.v2.enc.json" is the v2 copy of "abc.enc.json".
const FEED_FILE = /^[0-9a-z]+(\.(?!v2\.)[0-9A-Za-z-]+)?(\.v2)?\.enc\.json$/;
const FEED_PATH = /^(home|live)\/[0-9a-z]+(\.(?!v2\.)[0-9A-Za-z-]+)?(\.v2)?\.enc\.json$/;
const V1_END = ".enc.json";
const V2_END = ".v2.enc.json";

/** True for a path this job publishes ("home/<key>.enc.json", "home/<key>.es-419.enc.json", "live/<key>.v2.enc.json"...). */
export const isFeedPath = (path) => FEED_PATH.test(String(path));

/** The server key a feed belongs to: "home/abc.es-419.enc.json" -> "abc". */
export const keyOfPath = (path) => String(path).slice(String(path).lastIndexOf("/") + 1).split(".")[0];

/** True for a feed v2 copy ("home/abc.v2.enc.json"). */
export const isV2Path = (path) => String(path).endsWith(V2_END);
/** The envelope version a feed path holds: 2 for a ".v2.enc.json", else 1. */
export const versionOfPath = (path) => (isV2Path(path) ? 2 : 1);
/** "home/abc.es-419.enc.json" -> "home/abc.es-419.v2.enc.json" (a v2 path is returned as it is). */
export const v2PathOf = (path) => (isV2Path(path) ? String(path) : String(path).slice(0, -V1_END.length) + V2_END);
/** "home/abc.es-419.v2.enc.json" -> "home/abc.es-419.enc.json" (a v1 path is returned as it is). */
export const v1PathOf = (path) => (isV2Path(path) ? String(path).slice(0, -V2_END.length) + V1_END : String(path));

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

/** The gzip of [text] as UTF-8, best compression. Its header carries mtime 0 and OS "unknown", so it never varies by run or by machine. */
export function gzipText(text) {
  const gz = gzipSync(Buffer.from(String(text), "utf8"), { level: 9 });
  gz.writeUInt32LE(0, 4); // MTIME
  gz[9] = 255; // OS: unknown (macOS and Linux write different codes)
  return gz;
}

/**
 * [obj] sealed with the 32-byte AES-256 [key] as feed version [v]: { v, iv: base64 of 12 random bytes, data: base64 of the
 * ciphertext with the 16-byte GCM tag after it }. v 1 seals the UTF-8 JSON of [obj]; v 2 seals its gzip (gzipText).
 */
export function sealFeed(obj, key, v = 1) {
  if (v !== 1 && v !== 2) throw new Error("unknown feed version: " + v);
  const json = JSON.stringify(obj);
  const plain = v === 2 ? gzipText(json) : Buffer.from(json, "utf8");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v, iv: iv.toString("base64"), data: data.toString("base64") });
}

/** The object sealed in [text] with [key], either version, and its envelope's version: { v, obj }; null when it does not open. */
export function openFeed(text, key) {
  try {
    const box = JSON.parse(text);
    if (!box || (box.v !== 1 && box.v !== 2) || typeof box.iv !== "string" || typeof box.data !== "string") return null;
    const iv = Buffer.from(box.iv, "base64"), data = Buffer.from(box.data, "base64");
    if (data.length < 16) return null;
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    return { v: box.v, obj: JSON.parse((box.v === 2 ? gunzipSync(plain) : plain).toString("utf8")) };
  } catch (_) { return null; }
}

/**
 * The `at` sealed in [dir]/[path] when it opens with [key] as the version its name says and belongs to the server key its
 * name says; else null.
 */
export function sealedAt(dir, path, key) {
  try {
    const o = openFeed(readFileSync(join(dir, path), "utf8"), key);
    return o && o.v === versionOfPath(path) && o.obj && o.obj.serverKey === keyOfPath(path) && isTime(o.obj.at) ? o.obj.at : null;
  } catch (_) { return null; }
}

/** At most [maxRails] of [rails], each with at most [maxItems] items; every other field of a rail is kept. */
export function capRails(rails, maxRails, maxItems) {
  return (Array.isArray(rails) ? rails : []).slice(0, maxRails)
    .map((r) => (r && Array.isArray(r.items) ? { ...r, items: r.items.slice(0, maxItems) } : r));
}

/**
 * Which files of the previous set this run carries forward: each path it did not write, unless it is superseded (no longer
 * applies, e.g. a language variant the account stopped having; a v2 copy follows its v1 path), while the `at` sealed inside
 * it is younger than maxAgeMs. So a key whose server failed this run, or left the list, keeps its last good feed until the
 * readers would drop it anyway.
 * A v2 copy is kept only as the copy of the same build as its v1 file (same `at`). Every v1 file of the new set whose v2
 * copy is missing or of another build is listed in `derive`, to be made again from the v1 file (deriveV2): so the first run
 * after v2 came in gives v2 copies to the keys it only carries.
 * written: Map path -> at (this run). atOf(path) -> the previous copy's `at`, or null when it does not open (dropped).
 * -> { carry: [{ path, at }], drop: [{ path, why: "superseded" | "unreadable" | "expired" | "mismatched" }],
 *      derive: [{ path, from, at }] }
 */
export function carryPlan({ prevPaths, written, superseded = new Set(), atOf, now, maxAgeMs = MAX_AGE_MS }) {
  const carry = [], drop = [], derive = [];
  for (const path of prevPaths) {
    if (written.has(path)) continue;
    if (superseded.has(path) || superseded.has(v1PathOf(path))) { drop.push({ path, why: "superseded" }); continue; }
    const at = atOf(path);
    if (!isTime(at)) drop.push({ path, why: "unreadable" });
    else if (now - at >= maxAgeMs) drop.push({ path, why: "expired" });
    else carry.push({ path, at });
  }
  const v1s = [...written, ...carry.map((c) => [c.path, c.at])].filter(([path]) => !isV2Path(path));
  for (const [from, at] of v1s) {
    const path = v2PathOf(from);
    if (written.has(path) && written.get(path) === at) continue;
    const i = carry.findIndex((c) => c.path === path);
    if (i >= 0 && carry[i].at === at) continue;
    if (i >= 0) { carry.splice(i, 1); drop.push({ path, why: "mismatched" }); }
    derive.push({ path, from, at });
  }
  return { carry, drop, derive };
}

/**
 * Makes each planned v2 copy (carryPlan's `derive`) in [dir] from its v1 file, already in [dir]: opened with [key], passed
 * through [v2Of] (from the v1 path and the opened object to what the v2 copy carries: the plugin's cap) and sealed as v2.
 * A v1 file that does not open as the planned build is skipped. -> Map path -> at of the copies written.
 */
export function deriveV2({ dir, derive, key, v2Of = (_path, obj) => obj }) {
  const done = new Map();
  for (const { path, from, at } of derive) {
    if (!isFeedPath(path) || !isV2Path(path) || v2PathOf(from) !== path || isV2Path(from)) throw new Error("not a v2 copy of a feed: " + path);
    let o = null;
    try { o = openFeed(readFileSync(join(dir, from), "utf8"), key); } catch (_) { o = null; }
    if (!o || o.v !== 1 || !o.obj || o.obj.at !== at || o.obj.serverKey !== keyOfPath(from)) continue;
    writeFileSync(join(dir, path), sealFeed(v2Of(from, o.obj), key, 2));
    done.set(path, at);
  }
  return done;
}

/**
 * What `main` needs this run, for the installed versions that read only `main`:
 * - write: a path of the current set whose `main` copy is missing or unreadable, or older than everyMs and older than the
 *   current copy. everyMs <= 0 turns writing off (for when no installed version reads `main` any more);
 * - remove: a feed on `main` that left the current set and is superseded, unreadable, or past maxAgeMs (no reader uses it).
 * v2 copies live only on `data`: they are never written to `main`, and this plan never touches one there.
 * set: Map path -> at (the current set). mainAtOf(path) -> the `at` of `main`'s copy, or null. -> { write, remove }, sorted.
 */
export function mainPlan({ set, mainPaths, mainAtOf, superseded = new Set(), now, everyMs = MAIN_EVERY_MS, maxAgeMs = MAX_AGE_MS }) {
  const write = [], remove = [];
  if (everyMs > 0) {
    for (const [path, at] of set) {
      if (isV2Path(path)) continue;
      const m = mainAtOf(path);
      if (!isTime(m) || (now - m > everyMs && at > m)) write.push(path);
    }
  }
  for (const path of mainPaths) {
    if (isV2Path(path) || set.has(path)) continue;
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

/** Map path -> size in bytes of each of [paths] under [dir]; a path that is missing is left out. */
export function sizesOf(dir, paths) {
  const out = new Map();
  for (const path of paths) { try { out.set(path, statSync(join(dir, path)).size); } catch (_) { /* missing */ } }
  return out;
}

/**
 * The v1 files of [set] that have their v2 copy, both totals in bytes: { files, v1, v2 } (for the log; sizes: Map path -> bytes).
 */
export function sizeWin(set, sizes) {
  let files = 0, v1 = 0, v2 = 0;
  for (const path of set.keys()) {
    if (isV2Path(path)) continue;
    const a = sizes.get(path), b = sizes.get(v2PathOf(path));
    if (typeof a !== "number" || typeof b !== "number") continue;
    files++; v1 += a; v2 += b;
  }
  return { files, v1, v2 };
}

/**
 * The plain data-meta.json object: run time, the readers' limit and each path's builtAt, with its size in bytes when
 * [sizes] has it, marked when it was carried forward from an earlier run, and marked derived when this run made the v2
 * copy from its v1 file (deriveV2).
 */
export function metaOf({ set, carried = new Set(), derived = new Set(), sizes = new Map(), now, maxAgeMs = MAX_AGE_MS }) {
  const files = {};
  for (const path of [...set.keys()].sort()) {
    files[path] = {
      builtAt: set.get(path),
      ...(sizes.has(path) ? { bytes: sizes.get(path) } : {}),
      ...(carried.has(path) ? { carried: true } : {}),
      ...(derived.has(path) ? { derived: true } : {}),
    };
  }
  return {
    $comment: "Written by the Home pre-armado job of this repo. This branch is force-pushed on every run with the complete current set; it has no history. Each <path>.v2.enc.json is the compressed copy (feed v2: gzip before sealing) of <path>.enc.json.",
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
