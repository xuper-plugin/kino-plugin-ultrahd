// TMDB perezoso: solo el id de lo que se muestra (primeras filas del Home, primeros resultados de búsqueda), nunca un barrido.
// Orden: caché (fila del catálogo o mapa pequeño en kino.storage) -> kino.tmdb (la clave y la caché son de Kino: el plugin no
// lleva ninguna). Cada título se consulta una vez; los que no coinciden se reintentan pasados 14 días. Si no hay tiempo, se
// devuelve lo que hay y el resto queda para la próxima (Kino ya guarda en su caché lo que llegó a pedirse).
import { findKey, cleanTitle, idOf, dataOf } from "./titleIndex.js";
import { get as sget, put } from "./store.js";

const DAY_MS = 86400000;
const RETRY_DAYS = 14;
const CONCURRENCY = 3;
const MAP_KEY = "tmdb:cache";
const MAP_MAX_BYTES = 22 * 1024;

let disabled = false; // sin clave de TMDB en esta Kino: se deja de intentar durante la sesión
const stats = { queries: 0, cached: 0, skippedFresh: 0, found: 0, missed: 0, errors: 0, rateLimited: 0 };
export const tmdbStats = () => ({ ...stats });
export const resetTmdbStats = () => { for (const k of Object.keys(stats)) stats[k] = 0; disabled = false; };

const today = () => Math.floor(Date.now() / DAY_MS);

export const tmdbAvailable = () => {
  try { return !disabled && typeof kino !== "undefined" && typeof kino.tmdb === "function"; } catch (_) { return false; }
};

const yearOfResult = (r) => {
  const d = r.release_date || r.first_air_date || "";
  return /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : 0;
};

// Coincidencia segura: título (o título original) igual y año ±1, o un único resultado compatible con el año.
export function pickTmdbFull(results, entry) {
  const list = Array.isArray(results) ? results : [];
  const okYear = (r) => !entry.year || !yearOfResult(r) || Math.abs(yearOfResult(r) - entry.year) <= 1;
  const same = list.filter((r) => [r.title, r.name, r.original_title, r.original_name].some((t) => t && findKey(t) === entry.find) && okYear(r));
  if (same.length) return same[0];
  if (list.length === 1 && okYear(list[0]) && entry.year) return list[0];
  return null;
}
export const pickTmdb = (results, entry) => { const r = pickTmdbFull(results, entry); return r ? r.id : 0; };
const POSTER = "https://image.tmdb.org/t/p/w342";
const posterUrl = (p) => (p && p !== "-" ? POSTER + p : undefined); // "-": TMDB no tiene póster, no se vuelve a pedir

function readMap() {
  try { const o = JSON.parse(sget(MAP_KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (_) { return {}; }
}

function writeMap(map) {
  let ids = Object.keys(map);
  let text = JSON.stringify(map);
  while (text.length > MAP_MAX_BYTES && ids.length > 1) { delete map[ids.shift()]; text = JSON.stringify(map); }
  put(MAP_KEY, text);
}

async function withTimeout(p, ms) {
  if (typeof kino.sleep !== "function") return p;
  let timer = null;
  const gate = new Promise((res) => { timer = kino.sleep(Math.max(50, ms)).then(() => res({ timeout: true })); });
  const out = await Promise.race([p.then((v) => ({ v })), gate]);
  void timer;
  if (out.timeout) throw Object.assign(new Error("tiempo agotado"), { code: "timeout" });
  return out.v;
}

async function queryOne(c) {
  const params = { query: c.name, language: "es-MX", include_adult: false };
  if (c.year) params[c.tv ? "first_air_date_year" : "year"] = c.year;
  const res = await kino.tmdb(c.tv ? "/search/tv" : "/search/movie", params);
  const r = pickTmdbFull(res && res.results, c);
  return r ? { id: r.id, p: typeof r.poster_path === "string" ? r.poster_path : "" } : { id: 0, p: "" };
}

const hasCatalogGet = () => { try { return typeof kino.catalog === "object" && kino.catalog && typeof kino.catalog.get === "function"; } catch (_) { return false; } };

// Pone items[i].ids.tmdb en lo que ya se sabe y consulta TMDB solo lo que falta (hasta [max] por llamada y [budgetMs]).
// Muta los items y devuelve cuántos tienen id ahora. Nunca lanza.
export async function enrichTmdb(items, { max = 24, budgetMs = 2500 } = {}) {
  try {
    if (!tmdbAvailable() || !Array.isArray(items) || !items.length) return 0;
    const deadline = Date.now() + budgetMs;
    const cands = [];
    const seen = new Set();
    for (const it of items.slice(0, 48)) {
      if (!it || it.poster || (it.kind !== "movie" && it.kind !== "series") || !it.title) continue;
      const { name, year } = cleanTitle(it.title, it.year);
      const find = findKey(name);
      if (!find) continue;
      const tv = it.kind === "series";
      const id = idOf(tv ? "series" : "movies", find, year);
      if (seen.has(id)) continue;
      seen.add(id);
      cands.push({ item: it, id, name, find, year, tv, kind: tv ? "series" : "movies" });
    }
    if (!cands.length) return 0;

    // 1) caché: fila del catálogo (trae data.t y data.a) o mapa pequeño en kino.storage
    const rows = new Map();
    if (hasCatalogGet()) {
      try { for (const r of (await kino.catalog.get(cands.map((c) => c.id))) || []) rows.set(r.id, r); } catch (_) { /* sin filas */ }
    }
    const map = readMap();
    const now = today();
    const queue = [];
    for (const c of cands) {
      const row = rows.get(c.id);
      const d = row ? dataOf(row) : null;
      const t = d ? Number(d.t) || 0 : (map[c.id] && map[c.id][0]) || 0;
      const tried = d ? Number(d.a) || 0 : (map[c.id] && map[c.id][1]) || 0;
      const p = d ? (typeof d.p === "string" ? d.p : "") : (map[c.id] && typeof map[c.id][2] === "string" ? map[c.id][2] : "");
      if (t > 0 && p) { c.item.ids = { ...(c.item.ids || {}), tmdb: t }; if (!c.item.poster) c.item.poster = posterUrl(p); stats.cached++; continue; }
      if (t > 0) { c.item.ids = { ...(c.item.ids || {}), tmdb: t }; } // ya hay id pero falta el póster: se pide una vez más
      if (tried && now - tried < RETRY_DAYS) { stats.skippedFresh++; continue; }
      queue.push(c);
    }

    // 2) TMDB: concurrencia 3, tope por llamada y por tiempo
    const work = queue.slice(0, max);
    const done = [];
    let stop = false;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
      while (!stop && next < work.length && Date.now() < deadline) {
        const c = work[next++];
        try {
          stats.queries++;
          const r = await withTimeout(queryOne(c), deadline - Date.now());
          const id = r.id;
          done.push([c, id, r.p]);
          if (id) { stats.found++; c.item.ids = { ...(c.item.ids || {}), tmdb: id }; if (r.p && !c.item.poster) c.item.poster = posterUrl(r.p); } else stats.missed++;
        } catch (e) {
          stats.errors++;
          const code = e && e.code;
          if (code === "rate_limited") { stats.rateLimited++; stop = true; }
          else if (code === "no_tmdb_key") { disabled = true; stop = true; }
          else if (code === "timeout") stop = true;
        }
      }
    }));

    // 3) persistir: en la fila del catálogo si existe (conserva el resto de su data), si no en el mapa
    if (done.length) {
      const upserts = [];
      let mapDirty = false;
      for (const [c, id, p] of done) {
        const row = rows.get(c.id);
        if (row) upserts.push({ id: row.id, title: row.title, sort: row.sort, data: { ...dataOf(row), t: id, ...(id ? { p: p || "-" } : {}), ...(id ? { a: 0 } : { a: now }) } });
        else { delete map[c.id]; map[c.id] = id ? [id, now, p || "-"] : [id, now]; mapDirty = true; }
      }
      if (upserts.length) { try { await kino.catalog.upsert(upserts); } catch (_) { /* se vuelve a consultar */ } }
      if (mapDirty) writeMap(map);
    }
    return cands.filter((c) => c.item.ids && c.item.ids.tmdb).length;
  } catch (_) {
    return 0;
  }
}
