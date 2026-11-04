// kino.storage admite 262144 bytes EN TOTAL por plugin (clave + valor de cada entrada). Todo lo persistente pasa por aquí:
// cada clase tiene su presupuesto, al pasarse se expulsan las entradas más antiguas de esa clase, y el total se mantiene
// bajo SOFT_CAP (queda holgura). Un set() que falle nunca rompe al plugin: se degrada (devuelve false).
export const TOTAL_CAP = 262144;
export const SOFT_CAP = 200 * 1024;

// Clases: prefijo de clave -> presupuesto en bytes. "keep" = nunca se expulsa por falta de espacio de otra clase.
export const CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 5 * 1024, keep: true },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hero: { match: (k) => k.startsWith("vinfo:"), budget: 30 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  recent: { match: (k) => k.startsWith("recent:"), budget: 30 * 1024 },
  idx: { match: (k) => k.startsWith("idx:"), budget: 6 * 1024 },
  tmdb: { match: (k) => k.startsWith("tmdb:"), budget: 24 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 },
};
const ORDER = ["servers", "cats", "hero", "hist", "recent", "idx", "tmdb", "misc"];
const IDX = "_idx";

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

const sizeOf = (key, value) => utf8Len(key) + utf8Len(value);

function readIndex() {
  try {
    const o = JSON.parse(kino.storage.get(IDX) || "null");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (_) { return {}; }
}

function writeIndex(idx) {
  try { kino.storage.set(IDX, JSON.stringify(idx)); } catch (_) { /* sin índice: se reconstruye con ts 0 */ }
}

function entries() {
  let keys = [];
  try { keys = kino.storage.keys(); } catch (_) { return []; }
  const idx = readIndex();
  const out = [];
  for (const k of keys) {
    if (k === IDX) continue;
    let v = null;
    try { v = kino.storage.get(k); } catch (_) { v = null; }
    if (v === null || v === undefined) continue;
    out.push({ key: k, klass: classOf(k), bytes: sizeOf(k, v), ts: Number(idx[k]) || 0 });
  }
  return out;
}

export function usage() {
  const all = entries();
  const byClass = {};
  let total = utf8Len(IDX) + utf8Len(JSON.stringify(readIndex()));
  for (const e of all) { byClass[e.klass] = (byClass[e.klass] || 0) + e.bytes; total += e.bytes; }
  return { total, byClass, count: all.length };
}

function evict(list, idx, key) {
  try { kino.storage.remove(key); } catch (_) { /* ya no está */ }
  delete idx[key];
  const i = list.findIndex((e) => e.key === key);
  if (i >= 0) list.splice(i, 1);
}

// Guarda [value] (texto) bajo [key]. Devuelve true si quedó guardado; false si no cupo (el plugin sigue sin esa caché).
export function put(key, value) {
  try {
    const klass = classOf(key);
    const need = sizeOf(key, value);
    if (need > CLASSES[klass].budget) return false;
    const idx = readIndex();
    const list = entries().filter((e) => e.key !== key);
    const oldest = (pred) => list.filter(pred).sort((a, b) => a.ts - b.ts)[0];

    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest((e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(list, idx, victim.key);
    }
    let total = list.reduce((n, e) => n + e.bytes, 0) + need + 512;
    while (total > SOFT_CAP) {
      const victim = oldest((e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest((e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes;
      evict(list, idx, victim.key);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        kino.storage.set(key, value);
        idx[key] = Date.now();
        writeIndex(idx);
        return true;
      } catch (_) {
        const victim = oldest((e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(list, idx, victim.key);
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
}
