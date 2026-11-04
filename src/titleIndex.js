// Índice de títulos en kino.catalog (el SQLite que Kino da al plugin): búsqueda al instante sin recorrer categorías en vivo.
// Lo genera un workflow diario (repo xuper-plugin/kino-plugin-ultrahd-data, rama data) y lo publica como snapshot por trozos
// más los deltas de los últimos 7 días. El plugin guarda la REVISIÓN aplicada: si ya está en la última no descarga datos;
// si está a ≤ 7 revisiones aplica solo los deltas intermedios; solo desde cero, tras restaurar una copia o ante cualquier
// incoherencia vuelca el snapshot completo (idempotente) y retira lo que ya no está. Sin catálogo (Kino viejo), sin índice
// listo o sin resultados, el plugin cae a la búsqueda en vivo de siempre: nunca deja al usuario sin buscar.
import { get as sget, put } from "./store.js";

export const BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd-data/data/";
import { displayTitle } from "./names.js";
const FORMAT = 1;
const STATE_KEY = "idx:state";
const DAY_MS = 24 * 3600 * 1000;
// Lote adaptativo: arranca chico y se ajusta a lo que mida el aparato (un TV lento no se atasca, un celular rápido va más ligero).
const BATCH_MIN = 25;
const BATCH_MAX = 500;
const TARGET_MS = 300;
let batchSize = 100;
let lastBatchMs = 0;
const timed = async (st, rows, fn) => {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  lastBatchMs = ms;
  if (ms < TARGET_MS / 2) batchSize = Math.min(BATCH_MAX, batchSize * 2);
  else if (ms > TARGET_MS * 1.5) batchSize = Math.max(BATCH_MIN, Math.floor(batchSize / 2));
  const p = st.perf || (st.perf = { b: 0, ms: 0, rows: 0 });
  p.b++; p.ms += ms; p.rows += rows;
};
// El último trozo descargado se guarda en memoria: reanudar a mitad de trozo no lo vuelve a bajar ni a parsear.
let partCache = null;
const MIN_COVERAGE = 0.9;
const MAX_TITLE = 300;
const REV = /^\d{8}T\d{6}Z$/;
const RETRY_FIRST_MS = 60 * 1000;
const RETRY_LATER_MS = 10 * 60 * 1000;

let fetchBase = BASE;
export const __setBase = (url) => { fetchBase = url; };

// ---- nombres (idénticos a los del generador: scripts/gen-index.mjs del repo de datos) ------------------------------

export function cleanTitle(raw, yearField) {
  let name = String(raw || "").replace(/[\r\n\t]+/g, " ");
  let year = 0;
  for (let i = 0; i < 6; i++) {
    const before = name;
    name = name.replace(/\s*\(\s*(LAT|CAST|ENG|SUB|DUAL|4K|UHD|FHD|HD)\s*\)\s*$/i, "").replace(/\s*\[\s*(LAT|CAST|ENG|SUB)\s*\]\s*$/i, "");
    const y = name.match(/\s*\(\s*((?:19|20)\d\d)\s*\)\s*$/);
    if (y) { if (!year) year = Number(y[1]); name = name.slice(0, y.index); }
    if (name === before) break;
  }
  if (/^(19|20)\d\d$/.test(String(yearField || "").trim())) year = Number(String(yearField).trim());
  name = name.replace(/\s+/g, " ").trim();
  if (name.length > MAX_TITLE) name = name.slice(0, MAX_TITLE).replace(/[\uD800-\uDBFF]$/, "").trim();
  return { name, year };
}

export const findKey = (text) => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function h32(s, seed) {
  let h = seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Id estable: tipo + hash del nombre normalizado y el año. No depende del orden ni del trozo; idéntico al del generador.
export function idOf(kind, find, year) {
  const k = `${find}|${year || 0}`;
  return (kind === "movies" ? "m-" : "s-") + h32(k, 2166136261).toString(36) + h32(k, 0x9747b28c).toString(36);
}

// ---- estado (kino.storage, pequeño) --------------------------------------------------------------------------------

const hasCatalog = () => {
  try { return typeof kino !== "undefined" && !!kino.catalog && typeof kino.catalog.search === "function"; } catch (_) { return false; }
};

function readState() {
  try {
    const o = JSON.parse(sget(STATE_KEY) || "null");
    return o && typeof o === "object" && o.v === FORMAT ? o : null;
  } catch (_) { return null; }
}

function writeState(st) { put(STATE_KEY, JSON.stringify(st)); }

async function safeCount() {
  try {
    const r = await kino.catalog.count();
    return typeof r === "number" ? r : r && typeof r.count === "number" ? r.count : -1;
  } catch (_) { return -1; }
}

const sleep = async (ms) => { try { if (typeof kino.sleep === "function") await kino.sleep(ms); } catch (_) { /* sin pausa */ } };

// ---- descarga y validación -----------------------------------------------------------------------------------------

async function fetchJson(file, hash, tries) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await kino.fetch(`${fetchBase}${file}?v=${hash || Date.now()}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    } catch (e) { last = e; if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  throw last || new Error("descarga fallida");
}

const isList = (x) => Array.isArray(x);

export function validManifest(m) {
  if (!m || typeof m !== "object" || m.v !== FORMAT || typeof m.generated !== "string" || typeof m.hash !== "string") return false;
  if (typeof m.revision !== "string" || !REV.test(m.revision)) return false;
  if (!(m.coverage >= MIN_COVERAGE && m.coverage <= 1)) return false;
  for (const k of ["movies", "series"]) {
    const s = m[k];
    if (!s || !isList(s.parts) || !isList(s.hashes) || s.parts.length !== s.hashes.length || !Number.isInteger(s.count)) return false;
    if (s.parts.some((f) => typeof f !== "string" || !new RegExp(`^${k}-\\d+\\.json$`).test(f))) return false;
    if (s.hashes.some((h) => typeof h !== "string")) return false;
  }
  return m.movies.parts.length + m.series.parts.length > 0;
}

// La cadena de deltas desde [rev] hasta la última revisión, o null si no existe completa y consecutiva.
export function chainFor(rev, m) {
  const list = isList(m.deltas) ? m.deltas.filter((d) => d && REV.test(d.from) && REV.test(d.to) && d.file === `delta-${d.from}-${d.to}.json`) : [];
  const i = list.findIndex((d) => d.from === rev);
  if (i < 0) return null;
  const chain = list.slice(i);
  for (let j = 1; j < chain.length; j++) if (chain[j].from !== chain[j - 1].to) return null;
  return chain[chain.length - 1].to === m.revision && chain.length <= 7 ? chain.map((d) => ({ file: d.file, to: d.to })) : null;
}

// Devuelve { names, year, tmdb, cats } o lanza si el trozo no es válido (nunca se vuelca un trozo dañado).
export function validPart(p) {
  if (!p || typeof p.name !== "string" || !isList(p.year) || !isList(p.tmdb) || !isList(p.cats)) throw new Error("trozo inválido");
  const names = p.name === "" ? [] : p.name.split("\n");
  if (p.year.length !== names.length || p.tmdb.length !== names.length || p.cats.length !== names.length) throw new Error("listas desalineadas");
  return { names, year: p.year, tmdb: p.tmdb, cats: p.cats };
}

// Un delta válido: { from, to, total, added: [{k,n,y,t,c}], removed: [ids] }, o lanza.
export function validDelta(d, from, to) {
  if (!d || d.from !== from || d.to !== to || !Number.isInteger(d.total) || !isList(d.added) || !isList(d.removed)) throw new Error("delta inválido");
  for (const e of d.added) {
    if (!e || (e.k !== "m" && e.k !== "s") || typeof e.n !== "string" || !e.n || e.n.length > MAX_TITLE || !Number.isInteger(e.y) || !Number.isInteger(e.t) || !isList(e.c)) throw new Error("delta: entrada inválida");
  }
  if (d.removed.some((id) => typeof id !== "string" || !/^[ms]-[a-z0-9]{2,26}$/.test(id))) throw new Error("delta: id inválido");
  return d;
}

const rowOf = (kindLetter, name, year, tmdb, cats, r) => ({
  id: idOf(kindLetter === "m" ? "movies" : "series", findKey(name), year),
  title: name,
  sort: year,
  data: { y: year, t: tmdb, c: (isList(cats) ? cats.filter((x) => Number.isInteger(x)) : []).slice(0, 8), r },
});

const dataOf = (row) => {
  const d = row && row.data;
  if (d && typeof d === "object") return d;
  try { return JSON.parse(d || "{}") || {}; } catch (_) { return {}; }
};

// Un id de TMDB (o el intento de buscarlo) que el plugin ya resolvió al vuelo no se pierde al re-subir la fila.
async function upsertKeeping(rows, existing) {
  if (existing && rows.length) {
    let have = [];
    try { have = (await kino.catalog.get(rows.map((r) => r.id))) || []; } catch (_) { have = []; }
    const byId = new Map(have.map((x) => [x.id, dataOf(x)]));
    for (const r of rows) {
      const old = byId.get(r.id);
      if (old && !r.data.t && old.t) r.data.t = old.t;
      if (old && old.a && !r.data.t) r.data.a = old.a;
    }
  }
  return kino.catalog.upsert(rows);
}

// ---- poblado por etapas --------------------------------------------------------------------------------------------

let running = null;

// Texto para los ajustes: cuántos títulos hay y de qué revisión.
export async function indexLabel() {
  if (!hasCatalog()) return "No cargada: este Kino no trae catálogo, la búsqueda va en vivo";
  const st = readState();
  const n = await safeCount();
  const fmt = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const ago = (ts) => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  };
  if (st && st.stage) return `Descargando… ${fmt(Math.max(n, 0))}${st.stage.total ? " de " + fmt(st.stage.total) : ""} títulos`;
  if (st && st.done && st.rev && n > 0) {
    const parts = ["Cargada", st.mc ? `${fmt(st.mc)} películas · ${fmt(st.sc || 0)} series` : `${fmt(n)} títulos`];
    const gen = st.gen ? String(st.gen).replace("T", " ").slice(0, 16) + " UTC" : "";
    if (gen) parts.push("lista del " + gen);
    if (st.checked) parts.push("comprobada hace " + ago(st.checked));
    parts.push("en el aparato: " + fmt(n));
    if (st.perf && st.perf.b) parts.push(`lote medio ${Math.round(st.perf.ms / st.perf.b)} ms (${Math.round(st.perf.rows / st.perf.b)} filas)`);
    return parts.join(" · ");
  }
  if (st && st.done && n === 0) return "Vacía: se volverá a descargar al abrir Inicio";
  if (st && st.retryAt && Date.now() < st.retryAt) return "No se pudo descargar; se reintenta sola (sin red o GitHub no responde)";
  return "No cargada todavía: se descarga al abrir Inicio";
}

// ¿Hay trabajo de índice pendiente ahora? (la pantalla lo usa para decidir si pide otro paso en su siguiente tick)
export function indexNeeded() {
  if (!hasCatalog()) return false;
  const st = readState();
  if (!st || !st.done) return !(st && st.retryAt && Date.now() < st.retryAt && !st.stage);
  if (st.stage) return true;
  return Date.now() - (st.checked || 0) >= DAY_MS;
}

// Un paso del poblado/actualización, acotado por [budgetMs]. Idempotente y reanudable; nunca lanza.
// Devuelve: "unsupported" | "fresh" | "paused" | "done" | "wait" | "error".
export function indexStep(opts = {}) {
  if (!hasCatalog()) return Promise.resolve("unsupported");
  if (running) return running;
  running = step(opts).catch(() => "error").then((r) => { running = null; return r; });
  return running;
}

const stats = { downloads: 0, upserted: 0, removed: 0 }; // para pruebas y medidas
export const indexStats = () => ({ ...stats });
export const resetIndexStats = () => { stats.downloads = 0; stats.upserted = 0; stats.removed = 0; };

async function download(file, hash, tries) {
  stats.downloads++;
  return fetchJson(file, hash, tries);
}

function snapshotStage(m, fresh) {
  return {
    mode: "snapshot", target: m.revision, hash: m.hash, gen: m.generated, mc: m.movies.count, sc: m.series.count, total: m.movies.count + m.series.count, fresh,
    files: [...m.movies.parts.map((f, i) => [f, m.movies.hashes[i]]), ...m.series.parts.map((f, i) => [f, m.series.hashes[i]])],
    next: 0, offset: 0, fails: 0, purge: null,
  };
}

async function step({ budgetMs = 6000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let st = readState();
  const now = Date.now();

  // El catálogo vive en el dispositivo pero kino.storage viaja en las copias de seguridad: si el estado dice "indexado"
  // y el catálogo está vacío (copia restaurada o reinicio), se empieza de nuevo.
  if (st && st.rev) {
    const c = await safeCount();
    if (c === 0) st = null;
  }

  if (st && st.done && !st.stage && now - (st.checked || 0) < DAY_MS) return "fresh";
  if (st && st.retryAt && now < st.retryAt && !st.stage) return "wait";

  if (!st || !st.stage) {
    const first = !st || !st.done;
    let m;
    try {
      m = await download("index.json", "", first ? 3 : 1);
      if (!validManifest(m)) throw new Error("manifiesto inválido");
    } catch (_) {
      const keep = st || { v: FORMAT, done: false, snap: 0 };
      keep.retryAt = Date.now() + (first ? RETRY_FIRST_MS : RETRY_LATER_MS);
      writeState(keep);
      return "error";
    }
    // Ya está en la revisión actual: cero descargas de datos.
    if (st && st.done && st.rev === m.revision) { st.checked = now; st.retryAt = 0; writeState(st); return "fresh"; }

    const usable = !!st && st.done && (await safeCount()) > 0;
    const chain = usable ? chainFor(st.rev, m) : null;
    if (usable && chain) {
      st.stage = { mode: "delta", target: m.revision, hash: m.hash, gen: m.generated, mc: m.movies.count, sc: m.series.count, chain, next: 0, offA: 0, offR: 0, fails: 0, snap: snapshotStage(m, false) };
    } else if (usable) {
      st.stage = snapshotStage(m, false); // atrasado más de 7 revisiones: snapshot completo sobre el catálogo actual
    } else {
      try { await kino.catalog.clear(); } catch (_) { return "error"; }
      st = { v: FORMAT, done: false, snap: st && st.snap ? st.snap : 0, checked: 0 };
      st.stage = snapshotStage(m, true);
    }
    if (st.stage.mode === "snapshot") st.snap = (st.snap || 0) + 1;
    st.retryAt = 0;
    writeState(st);
  }

  for (let guard = 0; guard < 4 && st.stage; guard++) {
    const out = st.stage.mode === "delta" ? await runDelta(st, deadline) : await runSnapshot(st, deadline);
    if (out !== "again") return out;
  }
  return "paused";
}

// Aplica los deltas en orden: upsert de las altas y remove de las bajas, en lotes de 500. Cualquier fallo del delta (ausente,
// corrupto, o el catálogo no cuadra con su total) cae al snapshot completo sin tocar lo que ya funciona.
async function runDelta(st, deadline) {
  const sg = st.stage;
  const toSnapshot = () => { st.stage = sg.snap; st.snap = (st.snap || 0) + 1; writeState(st); return "again"; };
  while (sg.next < sg.chain.length) {
    if (Date.now() + 2000 > deadline) { writeState(st); return "paused"; }
    const { file, to } = sg.chain[sg.next];
    const from = sg.next === 0 ? st.rev : sg.chain[sg.next - 1].to;
    let d;
    try {
      d = validDelta(await download(file, to, 1), from, to);
    } catch (e) {
      sg.fails++;
      if (sg.fails >= 2 || /inválid|desaline/.test(String(e && e.message))) return toSnapshot();
      writeState(st);
      return "error";
    }
    try {
      for (let off = sg.offA; off < d.added.length;) {
        if (Date.now() + lastBatchMs > deadline) { sg.offA = off; writeState(st); return "paused"; }
        const n = batchSize;
        const rows = d.added.slice(off, off + n).map((e) => rowOf(e.k, e.n, e.y, e.t, e.c, st.snap));
        await timed(st, rows.length, () => upsertKeeping(rows, true));
        stats.upserted += rows.length;
        off += n;
      }
      sg.offA = d.added.length;
      for (let off = sg.offR; off < d.removed.length;) {
        if (Date.now() + lastBatchMs > deadline) { sg.offR = off; writeState(st); return "paused"; }
        const n = batchSize;
        const ids = d.removed.slice(off, off + n);
        await timed(st, ids.length, () => kino.catalog.remove(ids));
        stats.removed += ids.length;
        off += n;
      }
    } catch (e) {
      if (e && e.code === "limit") { st.capped = true; } else { writeState(st); return "error"; }
    }
    // Coherencia: el catálogo debe tener exactamente los títulos que dice el delta.
    if (!st.capped) {
      const c = await safeCount();
      if (c >= 0 && c !== d.total) return toSnapshot();
    }
    st.rev = to;
    st.total = d.total;
    sg.next++;
    sg.offA = 0;
    sg.offR = 0;
    sg.fails = 0;
    writeState(st);
  }
  st.hash = sg.hash;
  st.gen = sg.gen; st.mc = sg.mc || 0; st.sc = sg.sc || 0;
  st.done = true;
  st.checked = Date.now();
  st.retryAt = 0;
  st.stage = null;
  writeState(st);
  return "done";
}

// Vuelca el snapshot trozo a trozo (upsert idempotente: la fila de un título es siempre la misma) y, si el catálogo ya tenía
// contenido, retira lo que ya no está: cada fila lleva la etiqueta r del snapshot que la subió; al final se recorre el catálogo
// y se borran las de otra etiqueta. Mientras tanto el catálogo anterior sigue sirviendo búsquedas.
async function runSnapshot(st, deadline) {
  const sg = st.stage;
  while (sg.next < sg.files.length) {
    if (!(partCache && sg.offset > 0) && Date.now() + 1200 > deadline) { writeState(st); return "paused"; }
    const [file, hash] = sg.files[sg.next];
    const kind = file.startsWith("movies") ? "m" : "s";
    let part;
    try {
      if (partCache && partCache.file === file && partCache.hash === hash) part = partCache.part;
      else { part = validPart(await download(file, hash, 1)); partCache = { file, hash, part }; }
    } catch (_) {
      sg.fails++;
      if (sg.fails >= 3) { st.stage = null; st.retryAt = Date.now() + RETRY_LATER_MS; writeState(st); return "error"; }
      writeState(st);
      return "error";
    }
    for (let off = sg.offset; off < part.names.length;) {
      if (Date.now() + lastBatchMs > deadline) { sg.offset = off; writeState(st); return "paused"; }
      const n = batchSize;
      const rows = [];
      for (let i = off; i < Math.min(off + n, part.names.length); i++) {
        const title = part.names[i];
        if (title && title.length <= MAX_TITLE) rows.push(rowOf(kind, title, Number(part.year[i]) || 0, Number(part.tmdb[i]) || 0, part.cats[i], st.snap));
      }
      try {
        await timed(st, rows.length, () => upsertKeeping(rows, !sg.fresh));
        stats.upserted += rows.length;
        off += n;
      } catch (e) {
        if (e && e.code === "limit") { st.capped = true; sg.next = sg.files.length; break; }
        sg.offset = off;
        writeState(st);
        return "error";
      }
    }
    if (st.capped) break;
    partCache = null;
    sg.next++;
    sg.offset = 0;
    sg.fails = 0;
    writeState(st);
  }

  if (!sg.fresh && !st.capped) {
    if (!sg.purge) sg.purge = { offset: 0 };
    for (;;) {
      if (Date.now() + 1500 > deadline) { writeState(st); return "paused"; }
      let page;
      try { page = await kino.catalog.search({ q: "", limit: 100, offset: sg.purge.offset, order: "title" }); } catch (_) { writeState(st); return "error"; }
      const items = page && isList(page.items) ? page.items : [];
      if (!items.length) break;
      const stale = items.filter((r) => dataOf(r).r !== st.snap).map((r) => r.id);
      if (stale.length) { try { await kino.catalog.remove(stale); stats.removed += stale.length; } catch (_) { writeState(st); return "error"; } }
      sg.purge.offset += items.length - stale.length;
      if (items.length < 100) break;
    }
  }

  st.rev = sg.target;
  st.hash = sg.hash;
  st.gen = sg.gen; st.mc = sg.mc || 0; st.sc = sg.sc || 0;
  st.total = sg.total;
  st.done = true;
  st.checked = Date.now();
  st.retryAt = 0;
  st.stage = null;
  writeState(st);
  return "done";
}

export function indexStatus() {
  const st = readState();
  return st ? { done: !!st.done, staging: !!st.stage, rev: st.rev || "", gen: st.gen || "", total: st.total || 0, capped: !!st.capped, checked: st.checked || 0 } : null;
}

// ¿Conviene refrescar? (índice completo pero con más de un día)
export const indexStale = () => {
  const st = readState();
  return !!st && st.done && !st.stage && Date.now() - (st.checked || 0) >= DAY_MS;
};

export const indexReady = () => {
  const st = readState();
  return hasCatalog() && !!st && st.done;
};

// ---- búsqueda ------------------------------------------------------------------------------------------------------

export { dataOf };

export function itemOfRow(row) {
  const movie = String(row.id).startsWith("m-");
  const d = dataOf(row);
  const year = Number(d.y) || Number(row.sort) || 0;
  const cats = Array.isArray(d.c) ? d.c : [];
  const t = Number(d.t) || 0;
  return {
    id: row.id,
    ref: `idx:${movie ? "m" : "s"}:${findKey(row.title)}|${year}|${cats.join(",")}`,
    title: displayTitle(row.title),
    kind: movie ? "movie" : "series",
    year: year ? String(year) : undefined,
    ...(t > 0 ? { ids: { tmdb: t } } : {}),
  };
}

// { items, total } del catálogo, o null si no hay índice utilizable (el que llama cae a la búsqueda en vivo).
export async function indexSearch(q, type = "any", limit = 60) {
  if (!hasCatalog()) return null;
  const st = readState();
  if (!st || !st.done) return null;
  let res;
  try { res = await kino.catalog.search({ q: String(q || "").slice(0, 250), limit: 100, order: "newest" }); } catch (_) { return null; }
  if (!res || !isList(res.items)) return null;
  if (!res.items.length && (await safeCount()) === 0) { writeState({ ...st, done: false, rev: "", stage: null, checked: 0, hash: "" }); return null; }
  const want = type === "movie" ? "m-" : type === "series" ? "s-" : "";
  const items = res.items.filter((r) => !want || String(r.id).startsWith(want)).slice(0, limit).map(itemOfRow);
  return { items, total: res.total || items.length };
}

// ---- abrir un resultado: el id real se pide en vivo, solo a las categorías del título ------------------------------

export function parseIdxRef(ref) {
  const m = /^idx:([ms]):([^|]*)\|(\d*)\|([\d,]*)$/.exec(String(ref || ""));
  if (!m) return null;
  return { kind: m[1] === "m" ? "movies" : "series", find: m[2], year: Number(m[3]) || 0, cats: m[4] ? m[4].split(",").map(Number).filter((n) => n > 0).slice(0, 4) : [] };
}

// [fetchCategory(action, id)] devuelve la lista cruda de una categoría. Devuelve "vod:<id>:<ext>" o "series:<id>", o lanza not_found.
export async function resolveIdxRef(ref, fetchCategory) {
  const p = parseIdxRef(ref);
  if (!p) throw kino.error("not_found", "ref desconocido");
  const action = p.kind === "movies" ? "get_vod_streams" : "get_series";
  let failed = 0;
  for (const cat of p.cats) {
    let data;
    try { data = await fetchCategory(action, cat); } catch (_) { failed++; continue; }
    for (const x of data) {
      const { name, year } = cleanTitle(x.name || x.title, x.year || (x.release_date ? String(x.release_date).slice(0, 4) : ""));
      if (year !== p.year || findKey(name) !== p.find) continue;
      if (p.kind === "movies") return `vod:${x.stream_id}:${x.container_extension || "mp4"}`;
      return `series:${x.series_id}`;
    }
  }
  if (failed === p.cats.length && failed > 0) throw kino.error("unavailable", "no se pudo consultar el catálogo", { userMessage: "No se pudo abrir el título. Inténtalo de nuevo." });
  throw kino.error("not_found", "el título ya no está en el catálogo", { userMessage: "Este título ya no está disponible." });
}
