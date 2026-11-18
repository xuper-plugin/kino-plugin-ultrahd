// kino.storage admite 262144 bytes EN TOTAL por plugin. Todo lo persistente pasa por aquí: cada clase tiene su presupuesto,
// al pasarse se expulsan las entradas más antiguas de esa clase, y el total se mantiene bajo SOFT_CAP (queda holgura). Un
// set() que falle nunca rompe al plugin: se degrada (devuelve false).
// Kino keeps the whole store as one JSON file and rewrites it on every set (PluginStorage.set: the map copied, encoded and
// written atomically), so a write costs the whole store, not the value. Hence:
// - sizes are counted as Kino counts them (jsonSize: its JSON encoding, with Android's org.json escaping quotes, backslashes
//   and every "/"; the plugin used to count raw UTF-8, 8-14.5 % less), and kept in `_idx` with each key's write time, so a
//   put needs no read of every value;
// - a value equal to the stored one is not written again;
// - `_idx` itself is written once per call at most (flush, run by the entry point after every export), not after every put,
//   and only when a key came or went, or IDX_REFRESH_MS after its last write (sizes and times of keys it already lists
//   are exact in memory; on disk they may lag by that long, a few hundred bytes against 56 KB of headroom).
export const TOTAL_CAP = 262144;
export const SOFT_CAP = 200 * 1024;

// Clases: prefijo de clave -> presupuesto en bytes. "keep" = nunca se expulsa por falta de espacio de otra clase.
export const CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 8 * 1024, keep: true },
  // The person's choices: nothing else can evict them (they used to share the 2 KB "misc" class with avail:v1 and the health
  // result, and about 13 plays were enough to push srvChosen:v1 out).
  prefs: { match: (k) => k === "srvChosen:v1" || k === "browseTab" || k === "browseLang" || k === "seed:v1", budget: 256, keep: true },
  health: { match: (k) => k === "health:v1", budget: 3 * 1024, keep: true },
  panels: { match: (k) => k === "panels:v1", budget: 4 * 1024, keep: true },
  acct: { match: (k) => k === "acct:v1", budget: 2 * 1024, keep: true },
  // The live failover's last switch (live:v1): the account it moved a channel to survives a runtime restart.
  live: { match: (k) => k === "live:v1", budget: 512, keep: true },
  // Which server has which title (the "Servidor" menu's learning): its own class, trimmed by bytes in catalog.js.
  avail: { match: (k) => k === "avail:v1", budget: 16 * 1024 },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hero: { match: (k) => k.startsWith("vinfo:"), budget: 30 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  recent: { match: (k) => k.startsWith("recent:"), budget: 30 * 1024 },
  idx: { match: (k) => k.startsWith("idx:"), budget: 6 * 1024 },
  tmdb: { match: (k) => k.startsWith("tmdb:"), budget: 24 * 1024 },
  // Snapshots de las pestañas (Inicio/Películas/Series/En vivo, una entrada por servidor+pestaña+idioma): pintan al instante al reabrir.
  homeSnap: { match: (k) => k.startsWith("homeSnap:"), budget: 40 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 },
};
const ORDER = ["servers", "prefs", "health", "panels", "acct", "live", "avail", "cats", "hero", "hist", "recent", "idx", "tmdb", "homeSnap", "misc"];
const IDX = "_idx";
const TOUCH_MS = 60 * 60 * 1000;
const IDX_REFRESH_MS = 10 * 60 * 1000;

export const classOf = (key) => ORDER.find((c) => CLASSES[c].match(key));

export function utf8Len(s) {
  let n = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** [s] as Kino's store file holds it: a JSON string (quotes included), as Android's org.json writes it, in UTF-8 bytes. */
export function jsonSize(s) {
  const str = String(s);
  let n = utf8Len(str) + 2;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x2f || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x08 || c === 0x0c) n += 1;
    else if (c < 0x20) n += 5;
  }
  return n;
}

// One entry in Kino's file: "key":"value", (the colon and the comma).
const sizeOf = (key, value) => jsonSize(key) + jsonSize(value) + 2;

// ---- the index of sizes and write times, in memory ----
// `_idx` holds { key: [last write ms, size] } (older versions wrote { key: ms }: sizes then measured once). It is read once per
// runtime and kino.storage instance and kept in memory; the keys are checked against kino.storage.keys() on every put (a
// key written or removed elsewhere is measured or dropped).
let mem = null; // { storage, idx: { key: [ts, size] }, dirty, keys (a key came or went), at (last write of `_idx`) }

function load() {
  let storage = null;
  try { storage = kino.storage; } catch (_) { storage = null; }
  if (mem && mem.storage === storage) return mem;
  let raw = {};
  try {
    const o = JSON.parse(storage.get(IDX) || "null");
    if (o && typeof o === "object" && !Array.isArray(o)) raw = o;
  } catch (_) { raw = {}; }
  mem = { storage, idx: {}, dirty: false, keys: false, at: 0 };
  for (const k of Object.keys(raw)) {
    const e = raw[k];
    if (Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1])) mem.idx[k] = [e[0], e[1]];
    else mem.idx[k] = [Number(e) || 0, -1]; // the old format: the size is measured below
  }
  return mem;
}

// The index matching the store's keys now: sizes for keys it lacks or never measured, none for keys gone.
function sync(m) {
  let keys = [];
  try { keys = m.storage.keys(); } catch (_) { return m; }
  const present = new Set(keys);
  for (const k of Object.keys(m.idx)) if (!present.has(k)) { delete m.idx[k]; m.dirty = true; m.keys = true; }
  for (const k of keys) {
    if (k === IDX) continue;
    const e = m.idx[k];
    if (e && e[1] >= 0) continue;
    let v = null;
    try { v = m.storage.get(k); } catch (_) { v = null; }
    if (v === null || v === undefined) continue;
    if (!e) m.keys = true;
    m.idx[k] = [e ? e[0] : 0, sizeOf(k, v)];
    m.dirty = true;
  }
  return m;
}

const idxText = (m) => JSON.stringify(m.idx);

/**
 * Writes `_idx` when a key came or went since its last write, or when it changed and was last written IDX_REFRESH_MS ago
 * (or never in this runtime). The entry point runs it after every export (once per call).
 */
export function flush() {
  try {
    const m = mem;
    if (!m || !m.dirty) return;
    if (!m.keys && m.at && Date.now() - m.at < IDX_REFRESH_MS) return;
    let same = false;
    try { same = m.storage === kino.storage; } catch (_) { same = false; }
    if (!same) return;
    m.storage.set(IDX, idxText(m));
    m.dirty = false;
    m.keys = false;
    m.at = Date.now();
  } catch (_) { /* sin índice: se reconstruye con ts 0 */ }
}

function entries(m) {
  return Object.keys(m.idx).map((k) => ({ key: k, klass: classOf(k), bytes: m.idx[k][1], ts: m.idx[k][0] }));
}

export function usage() {
  const m = sync(load());
  const all = entries(m);
  const byClass = {};
  let total = 1 + sizeOf(IDX, idxText(m)); // the braces, minus the last entry's comma
  for (const e of all) { byClass[e.klass] = (byClass[e.klass] || 0) + e.bytes; total += e.bytes; }
  return { total, byClass, count: all.length };
}

function evict(m, list, key) {
  try { m.storage.remove(key); } catch (_) { /* ya no está */ }
  delete m.idx[key];
  m.dirty = true;
  m.keys = true;
  const i = list.findIndex((e) => e.key === key);
  if (i >= 0) list.splice(i, 1);
}

// Guarda [value] (texto) bajo [key]. Devuelve true si quedó guardado (o ya estaba igual); false si no cupo (el plugin sigue
// sin esa caché).
export function put(key, value) {
  try {
    const text = String(value);
    const klass = classOf(key);
    const need = sizeOf(key, text);
    if (need > CLASSES[klass].budget) return false;
    const m = sync(load());
    let stored = null;
    try { stored = m.storage.get(key); } catch (_) { stored = null; }
    if (stored === text) {
      // Unchanged: no write. Its time is renewed (the eviction order) at most once an hour, so this costs no `_idx` write
      // on every call either.
      const e = m.idx[key];
      if (!e || e[1] !== need || Date.now() - e[0] > TOUCH_MS) { m.idx[key] = [Date.now(), need]; m.dirty = true; }
      return true;
    }
    const list = entries(m).filter((e) => e.key !== key);
    const oldest = (pred) => list.filter(pred).sort((a, b) => a.ts - b.ts)[0];

    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest((e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(m, list, victim.key);
    }
    // The index's own entry counts too (about 32 bytes a key), and the store's braces.
    let total = list.reduce((n, e) => n + e.bytes, 0) + need + 2 + 32 * (list.length + 1) + 512;
    while (total > SOFT_CAP) {
      const victim = oldest((e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest((e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes + 32;
      evict(m, list, victim.key);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        m.storage.set(key, text);
        if (!m.idx[key]) m.keys = true;
        m.idx[key] = [Date.now(), need];
        m.dirty = true;
        return true;
      } catch (_) {
        const victim = oldest((e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(m, list, victim.key);
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

export function get(key) {
  try { return kino.storage.get(key); } catch (_) { return null; }
}

export function remove(key) {
  try { kino.storage.remove(key); } catch (_) { /* nada */ }
  if (mem && mem.idx[key]) { delete mem.idx[key]; mem.dirty = true; mem.keys = true; }
}
