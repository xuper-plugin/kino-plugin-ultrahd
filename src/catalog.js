// Ultra Hd — catálogo (películas, series, en vivo).
// Las credenciales se obtienen automáticamente del servidor bootstrap,
// igual que la app original. El usuario no configura nada.

import { noteRecent } from "./recent.js";
import { put } from "./store.js";
import { indexSearch, indexStep, indexReady, indexStale, resolveIdxRef } from "./titleIndex.js";
import { enrichTmdb } from "./tmdbLazy.js";
import { LANG_ORDER, titleCase, countryMatch, COUNTRY_PHRASES } from "./names.js";
import { mergeVod, mergeLive, searchOrder, homeOrder } from "./categories.js";

const BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
const VEGETA_VERSION_CODE = "21"; // versionCode de la app (VegetaTV 11.1): el bootstrap rechaza menos de 21 con 426
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

const PER_PAGE = 60;
const HOME_PREVIEW = 20;

function cfg(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v === undefined || v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

export const showAdult = () => cfg("showAdult", false) === true;
export const liveFormat = () => (cfg("liveFormat", "m3u8") === "ts" ? "ts" : "m3u8");
export const homeCountry = () => String(cfg("homeCountry", "none"));

// ---- bootstrap / caché de credenciales ------------------------------------------

// Parsea una línea del servers_text ("http://host/player_api.php?username=u&password=p [nombre]")
// y extrae { url, username, password }.
function parseServerLine(line) {
  const url = line.split(/\s/)[0].trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (!path.endsWith("player_api.php") && !path.endsWith("get.php")) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    const password = u.searchParams.get("password") || u.searchParams.get("pass") || "";
    if (!username) return null;
    const base = (u.protocol + "//" + u.host).replace(/\/+$/, "");
    return { url: base, username, password };
  } catch (_) {
    return null;
  }
}

const vegetaHeaders = (code) => ({
  "X-Vegeta-Version-Code": String(code),
  "X-Vegeta-Servers-Direct": "1",
  "Cache-Control": "no-cache, no-store",
  "Pragma": "no-cache",
});

function readVersionCode() {
  try {
    const v = String(kino.storage.get("vcode") || "");
    return /^d+$/.test(v) && Number(v) >= Number(VEGETA_VERSION_CODE) ? v : VEGETA_VERSION_CODE;
  } catch (_) {
    return VEGETA_VERSION_CODE;
  }
}

const MAX_SERVERS = 12;

function parseServers(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const s = parseServerLine(t);
    if (!s) continue;
    const key = s.url + "|" + s.username;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  // HTTPS primero: es lo único que Kino deja usar con servidores externos.
  return out.sort((a, b) => (b.url.startsWith("https://") ? 1 : 0) - (a.url.startsWith("https://") ? 1 : 0));
}

// El bootstrap exige un código de versión mínimo (426 / ok:false). Se parte del guardado y se reintenta UNA vez con el
// mayor entre minimum_version_code y latest_version_code que el propio servicio declare; el que funciona se guarda.
async function fetchServerList() {
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" } });
    let data = null;
    try { data = r.json(); } catch (_) { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
      if (attempt === 0 && want > Number(code)) { code = String(want); continue; }
      throw kino.error("unavailable", "bootstrap " + r.status, { userMessage: "No se pudo conectar con el servicio." });
    }

    let list = [];
    if (typeof data.servers_text === "string" && data.servers_text.trim()) list = parseServers(data.servers_text);
    if (!list.length && typeof data.servers_url === "string" && data.servers_url.trim()) {
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" } });
      if (r2.ok) list = parseServers(r2.text());
    }
    if (!list.length) {
      const want = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
      if (attempt === 0 && want > Number(code)) { code = String(want); continue; }
      throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
    }
    put("vcode", String(code));
    return list.slice(0, MAX_SERVERS);
  }
  throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
}

// Clave corta del servidor activo (sin usuario ni contraseña a la vista): separa las cachés de catálogo entre servidores.
export function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv) return "";
  let h = 5381;
  const text = srv.url + "|" + srv.username;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function readSrvs() {
  try { return JSON.parse(kino.storage.get("srvs") || "null"); } catch (_) { return null; }
}

function writeSrvs(st) {
  put("srvs", JSON.stringify(st));
}

// Estado en storage: { ts, list, idx (servidor activo), ok (idx ya comprobado) }.
async function loadServers(force) {
  const cached = readSrvs();
  const usable = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usable && cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const st = { ts: Date.now(), list: await fetchServerList(), idx: 0, ok: false };
    writeSrvs(st);
    return st;
  } catch (e) {
    if (usable) return cached; // bootstrap caído: seguimos con la lista vieja
    throw e;
  }
}

// ---- Xtream Codes API -----------------------------------------------------------

function badAnswer(action, data) {
  if (data === null || typeof data !== "object") return true;
  if (!Array.isArray(data)) {
    const auth = data.user_info && data.user_info.auth;
    return auth !== undefined && String(auth) === "0";
  }
  return data.length === 0 && action.endsWith("_categories");
}

async function callServer(srv, action, extra) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, action, ...extra });
  const r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
    }
  });
  if (!r.ok) throw new Error("API " + r.status);
  const data = r.json();
  if (badAnswer(action, data)) throw new Error("respuesta inválida");
  return data;
}

async function api(action, extra = {}) {
  let last = "";
  for (let pass = 0; pass < 2; pass++) {
    const st = await loadServers(pass === 1);
    for (let n = 0; n < st.list.length; n++) {
      const i = (st.idx + n) % st.list.length;
      try {
        const data = await callServer(st.list[i], action, extra);
        if (i !== st.idx || !st.ok) {
          st.idx = i;
          st.ok = true;
          writeSrvs(st);
        }
        return data;
      } catch (e) {
        if (e && e.code === "rate_limited") throw e;
        last = String((e && e.message) || e).slice(0, 80);
      }
    }
  }
  throw kino.error("unavailable", "ningún servidor respondió (" + action + "): " + last, { userMessage: "Error al contactar el servidor." });
}

async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api("get_vod_categories");
    st = readSrvs();
  }
  return st.list[st.idx];
}

// ---- estado y cambio de servidor (ajustes) ---------------------------------------

const hostOf = (srv) => {
  try { return new URL(srv.url).host; } catch (_) { return ""; }
};

// Nunca expone usuario ni contraseña: solo el host y la posición en la lista.
export async function serverStatus() {
  try {
    await api("get_vod_categories");
    const st = readSrvs();
    return { ok: true, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: st.list.length };
  } catch (_) {
    const st = readSrvs();
    return { ok: false, host: st && st.list[st.idx] ? hostOf(st.list[st.idx]) : "", index: st ? st.idx + 1 : 0, total: st ? st.list.length : 0 };
  }
}

export async function switchServer() {
  const st = await loadServers(false);
  const n = st.list.length;
  for (let k = 1; k < n; k++) {
    const i = (st.idx + k) % n;
    try {
      await callServer(st.list[i], "get_vod_categories", {});
      st.idx = i;
      st.ok = true;
      writeSrvs(st);
      return { changed: true, host: hostOf(st.list[i]), index: i + 1, total: n };
    } catch (_) { /* probar el siguiente */ }
  }
  return { changed: false, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: n };
}

export async function refreshServers() {
  const st = await loadServers(true);
  let ok = true;
  try { await api("get_vod_categories"); } catch (_) { ok = false; }
  const now = readSrvs() || st;
  return { ok, total: now.list.length, host: hostOf(now.list[now.idx]) };
}

export async function settingsStatus() {
  const s = await serverStatus();
  if (!s.ok) return { status: s.host ? `Sin respuesta de ${s.host}` : "Sin conexión con el servicio" };
  return { status: `Conectado a ${s.host} (${s.index} de ${s.total})` };
}

export async function action(key) {
  if (key === "switchServer") {
    const r = await switchServer();
    return { message: r.changed ? `Servidor cambiado a ${r.host}` : "No hay otro servidor disponible ahora", refresh: true };
  }
  if (key === "refreshServers") {
    const r = await refreshServers();
    return { message: r.ok ? `Lista actualizada: ${r.total} servidores` : "No se pudo actualizar la lista", refresh: true };
  }
  throw kino.error("not_found");
}

// ---- items ----------------------------------------------------------------------

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Fichas de los destacados (get_vod_info / get_series_info): pequeñas, por servidor, máximo INFO_MAX.
const INFO_MAX = 80;
let infoMemo = null;

function infoCache() {
  const key = serverKey();
  if (infoMemo && infoMemo.key === key) return infoMemo.map;
  let map = {};
  try { map = JSON.parse(kino.storage.get("vinfo:" + key) || "{}") || {}; } catch (_) { map = {}; }
  infoMemo = { key, map };
  return map;
}

function saveFicha(itemId, ficha) {
  const map = infoCache();
  map[itemId] = ficha;
  const ids = Object.keys(map);
  if (ids.length > INFO_MAX) for (const old of ids.slice(0, ids.length - INFO_MAX)) delete map[old];
  // Presupuesto de las fichas: se recortan las más antiguas hasta caber.
  let text = JSON.stringify(map);
  while (text.length > 26 * 1024 && Object.keys(map).length > 1) {
    delete map[Object.keys(map)[0]];
    text = JSON.stringify(map);
  }
  put("vinfo:" + infoMemo.key, text);
}

const splitGenres = (g) => String(g || "").split(/[,/|]/).map((x) => x.trim()).filter(Boolean).slice(0, 5);

function extras(m, ficha) {
  const f = ficha || {};
  const out = {};
  const genres = splitGenres(m.genre).length ? splitGenres(m.genre) : f.genres || [];
  if (genres.length) out.genres = genres;
  let backdrop = m.backdrop_path || f.backdrop;
  if (Array.isArray(backdrop)) backdrop = backdrop[0];
  if (typeof backdrop === "string" && backdrop) out.backdrop = backdrop;
  const runtime = Math.round(num(m.duration_secs) / 60) || parseInt(m.episode_run_time, 10) || f.runtime || 0;
  if (runtime > 0) out.runtimeMinutes = runtime;
  const ids = {};
  const tmdb = parseInt(m.tmdb || m.tmdb_id, 10) || f.tmdb || 0;
  if (tmdb > 0) ids.tmdb = tmdb;
  if (/^tt\d+$/.test(String(m.imdb_id || m.imdb || ""))) ids.imdb = String(m.imdb_id || m.imdb);
  if (Object.keys(ids).length) out.ids = ids;
  return out;
}

const ratingOf = (m) => {
  const r = num(m.rating) || num(m.rating_5based) * 2;
  return r > 0 ? Math.min(10, r) : undefined;
};

function vodItem(m, adult) {
  const id = String(m.stream_id || "");
  if (!id) return null;
  const title = String(m.name || m.title || "").trim();
  if (!title) return null;
  const ext = String(m.container_extension || "mp4");
  return {
    id: "vod-" + id,
    ref: "vod:" + id + ":" + ext,
    title,
    kind: "movie",
    poster: m.stream_icon || m.cover || undefined,
    year: m.year ? String(m.year) : m.release_date ? String(m.release_date).slice(0, 4) : undefined,
    rating: ratingOf(m),
    overview: m.plot ? String(m.plot).slice(0, 500) : undefined,
    ...extras(m, infoCache()["vod-" + id]),
    ...(adult ? { adult: true } : {}),
  };
}

function seriesItem(s, adult) {
  const id = String(s.series_id || "");
  if (!id) return null;
  const title = String(s.name || s.title || "").trim();
  if (!title) return null;
  return {
    id: "series-" + id,
    ref: "series:" + id,
    title,
    kind: "series",
    poster: s.cover || s.poster || undefined,
    year: s.year ? String(s.year) : s.release_date ? String(s.release_date).slice(0, 4) : undefined,
    rating: ratingOf(s),
    overview: s.plot ? String(s.plot).slice(0, 500) : undefined,
    ...extras(s, infoCache()["series-" + id]),
    ...(adult ? { adult: true } : {}),
  };
}

async function fetchFicha(kind, id) {
  const vod = kind === "vod";
  const data = await api(vod ? "get_vod_info" : "get_series_info", vod ? { vod_id: id } : { series_id: id });
  const info = (data && data.info) || {};
  let backdrop = info.backdrop_path;
  if (Array.isArray(backdrop)) backdrop = backdrop[0];
  const ficha = {};
  if (typeof backdrop === "string" && /^https:\/\//.test(backdrop)) ficha.backdrop = backdrop;
  const tmdb = parseInt(info.tmdb_id || info.tmdb, 10);
  if (tmdb > 0) ficha.tmdb = tmdb;
  const runtime = Math.round(num(info.duration_secs) / 60) || parseInt(info.episode_run_time, 10) || 0;
  if (runtime > 0) ficha.runtime = runtime;
  const genres = splitGenres(info.genre);
  if (genres.length) ficha.genres = genres;
  return ficha;
}

// Solo para unos pocos destacados (backdrop y tmdb no vienen en la lista). Devuelve cuántas fichas nuevas guardó.
export async function enrichFeatured(kind, items, max = 6) {
  const prefix = kind === "vod" ? "vod-" : "series-";
  const todo = items.filter((it) => it && it.id.startsWith(prefix) && !infoCache()[it.id]).slice(0, max);
  let saved = 0;
  let limited = false;
  await pool(todo, 3, async (it) => {
    if (limited) return;
    try {
      const ficha = await fetchFicha(kind, it.id.slice(prefix.length));
      saveFicha(it.id, ficha);
      saved++;
    } catch (e) {
      if (e && e.code === "rate_limited") limited = true; /* el destacado se queda sin fondo */
    }
  });
  return saved;
}

// ---- genre hint -----------------------------------------------------------------

function genreOf(name) {
  const n = String(name || "").toLowerCase();
  if (/acci[oó]n|action/.test(n)) return "acción";
  if (/comedia|comedy/.test(n)) return "comedia";
  if (/drama/.test(n)) return "drama";
  if (/terror|horror/.test(n)) return "terror";
  if (/animaci[oó]n|anime|cartoon/.test(n)) return "animación";
  if (/documenta/.test(n)) return "documentales";
  if (/romance/.test(n)) return "romance";
  if (/thriller|suspen/.test(n)) return "thriller";
  if (/pelic|movie|film|cine/.test(n)) return "películas";
  if (/serie/.test(n)) return "series";
  return undefined;
}

// Concurrencia acotada: el servidor falla en silencio con muchas peticiones a la vez.
async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

// Una categoría: vacía ([]) es válida; fallar lanza (se reintenta una vez, con respaldo de servidor dentro de api()).
async function fetchCategory(action, categoryId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action, { category_id: String(categoryId) });
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      return data;
    } catch (e) {
      if (attempt >= 1 || (e && e.code === "rate_limited")) throw e;
    }
  }
}

const byAddedDesc = (a, b) => num(b.added) - num(a.added);

// ---- categorías y filas ---------------------------------------------------------

// Lista real de categorías (pequeña): en memoria y en storage, con la clave del servidor activo y vigencia de 6 h.
const CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
const catMemo = {};

async function categoryList(kind) {
  const key = serverKey();
  const m = catMemo[kind];
  if (key && m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return m.list;
  if (key) {
    try {
      const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
      if (o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS) {
        const list = o.l.map(([category_id, category_name]) => ({ category_id, category_name }));
        catMemo[kind] = { key, ts: o.ts, list };
        return list;
      }
    } catch (_) { /* se vuelve a pedir */ }
  }
  const data = await api(CAT_ACTIONS[kind]);
  const list = (Array.isArray(data) ? data : []).map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  const now = serverKey();
  catMemo[kind] = { key: now, ts: Date.now(), list };
  put("cats:" + kind + ":" + now, JSON.stringify({ ts: Date.now(), l: list.map((c) => [c.category_id, c.category_name]) }));
  return list;
}

const mergedVod = async (kind) => mergeVod(kind, await categoryList(kind), { showAdult: showAdult() });

const itemOf = (kind, x, adult) => (kind === "vod" ? vodItem(x, adult) : seriesItem(x, adult));

// { rails, langs (los que existen), lang (el elegido), failed (categorías que no cargaron) }.
// opts: { lang, home } — home excluye las grabaciones de cámara.
export async function loadRailsInfo(kind, maxRails, perRail, opts = {}) {
  const vod = kind === "vod";
  let cats = await mergedVod(kind);
  const langs = LANG_ORDER.filter((l) => cats.some((c) => c.lang === l));
  const lang = opts.lang && langs.includes(opts.lang) ? opts.lang : langs[0] || null;
  const inLang = lang ? cats.filter((c) => c.lang === lang) : cats;
  // Con el 18+ encendido, una fila adulta (marcada) se suma al final aunque pase del tope.
  const plain = (opts.home ? homeOrder(inLang) : inLang.filter((c) => !c.adult)).slice(0, maxRails);
  const chosen = opts.home ? plain : [...plain, ...inLang.filter((c) => c.adult).slice(0, 1)];

  const fetched = await pool(chosen, 3, async (cat) => {
    try { return { cat, data: await fetchCategory(vod ? "get_vod_streams" : "get_series", cat.id) }; } catch (_) { return { cat, failed: true }; }
  });

  const seen = new Set();
  const rails = [];
  let failed = 0;
  for (const r of fetched) {
    if (r.failed) { failed++; continue; }
    const items = [];
    for (const x of [...r.data].sort(byAddedDesc)) {
      if (items.length >= perRail) break;
      const it = itemOf(kind, x, r.cat.adult);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    }
    if (!items.length) continue;
    rails.push({
      id: (vod ? "vod-" : "series-") + r.cat.id,
      title: r.cat.title,
      genre: genreOf(r.cat.name) || (vod ? "películas" : "series"),
      ref: (vod ? "vod:" : "series:") + r.cat.id + (r.cat.adult ? ":a" : ""),
      lang: r.cat.lang,
      items,
    });
  }
  if (!rails.length && failed) throw kino.error("unavailable", "ninguna categoría cargó", { userMessage: "No se pudo cargar el catálogo." });
  // TMDB perezoso: solo el id de lo que se ve al abrir (primeras filas), con tope por llamada; Kino completa el resto con él.
  await enrichTmdb(rails.slice(0, vod ? 2 : 1).flatMap((r) => r.items.slice(0, 8)), { max: vod ? 16 : 8, budgetMs: 2500 });
  return { rails, langs, lang, failed };
}

export async function loadRails(kind, maxRails, perRail, opts) {
  return (await loadRailsInfo(kind, maxRails, perRail, opts)).rails;
}

// ---- home -----------------------------------------------------------------------

export async function home() {
  // El índice de títulos se puebla/actualiza mientras carga el Home (un paso acotado en tiempo; nunca lanza).
  const indexing = indexStep({ budgetMs: 7000 });
  const vod = await loadRailsInfo("vod", 4, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const series = await loadRailsInfo("series", 3, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const live = await countryRow().catch(() => null);
  await indexing;
  const rows = [...vod.rails, ...series.rails].map(({ lang, ...r }) => r);
  if (!rows.length) throw kino.error("unavailable", "sin contenido", { userMessage: "Sin contenido disponible por ahora." });
  if (live) rows.push({ id: live.id, title: live.title, genre: "tv", items: live.items });
  return rows;
}

// ---- browse ---------------------------------------------------------------------

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const [kindPrefix, catId, flag] = String(ref || "").split(":");
  if (kindPrefix === "lcat" && /^\d+$/.test(catId || "")) {
    const out = await liveChannels({ categoryId: catId });
    const all = out.items.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...(i.adult ? { adult: true } : {}) }));
    return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : undefined };
  }
  const kind = kindPrefix === "vod" ? "vod" : kindPrefix === "series" ? "series" : null;
  if (!kind || !/^\d+$/.test(catId || "")) return { items: [] };

  const adult = flag === "a";
  if (adult && !showAdult()) return { items: [] };
  const data = await fetchCategory(kind === "vod" ? "get_vod_streams" : "get_series", catId);
  const seen = new Set();
  const all = [...data].sort(byAddedDesc).map((x) => itemOf(kind, x, adult)).filter((it) => it && !seen.has(it.id) && seen.add(it.id));
  return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : undefined };
}

// ---- search ---------------------------------------------------------------------

// Recorre las categorías en el orden recibido (idioma preferido y géneros primero), de 3 en 3. Se detiene al llegar al límite
// de resultados, de categorías (cada una es una petición: el servidor IPTV admite 60 por minuto) o de tiempo.
async function searchKind(kind, cats, q, limit, seen, { maxCats, deadline }) {
  const action = kind === "vod" ? "get_vod_streams" : "get_series";
  const items = [];
  let failed = 0;
  let capped = false;
  let scanned = 0;
  for (let i = 0; i < cats.length && items.length < limit; i += 3) {
    if (scanned >= maxCats || Date.now() > deadline) { capped = true; break; }
    const slice = cats.slice(i, i + 3);
    scanned += slice.length;
    const batch = await Promise.all(slice.map(async (cat) => {
      try {
        const data = await fetchCategory(action, cat.id);
        return { cat, hits: data.filter((x) => String(x.name || x.title || "").toLowerCase().includes(q)) };
      } catch (e) {
        if (e && e.code === "rate_limited") capped = true; else failed++;
        return { cat, hits: [] };
      }
    }));
    for (const { cat, hits } of batch) {
      for (const x of hits) {
        if (items.length >= limit) break;
        const it = itemOf(kind, x, cat.adult);
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    }
    if (capped) break;
  }
  if (items.length < limit && scanned < cats.length) capped = true;
  return { items, failed, capped };
}

// Primero el índice de títulos (kino.catalog). Sin catálogo, sin índice listo o sin resultados devuelve null y se busca en vivo.
async function viaIndex(q, type) {
  const ready = indexReady();
  const [found] = await Promise.all([ready ? indexSearch(q, type) : null, !ready || indexStale() ? indexStep({ budgetMs: ready ? 3000 : 4000 }) : null]);
  const res = found || (!ready && indexReady() ? await indexSearch(q, type) : null);
  if (!res || !res.items.length) return null;
  await enrichTmdb(res.items.slice(0, 20), { max: 20, budgetMs: 2500 }); // solo los primeros resultados
  return { items: res.items, partial: false };
}

// { items, partial }: partial = alguna categoría no respondió y puede faltar algo.
export async function searchDetailed(query, { budgetMs = 11000 } = {}) {
  const q = String((query && query.q) || "").trim().toLowerCase();
  if (!q) return { items: [], partial: false };
  const type = String((query && query.type) || "any");
  const indexed = await viaIndex(q, type).catch(() => null);
  if (indexed) return indexed;
  const deadline = Date.now() + Math.max(3000, budgetMs - 4000);
  const wantVod = type === "any" || type === "movie";
  const wantSeries = type === "any" || type === "series";
  const seen = new Set();
  let failed = 0;
  let capped = false;
  let items = [];
  if (wantVod) {
    const cats = searchOrder(await mergedVod("vod"));
    const r = await searchKind("vod", cats, q, 40, seen, { maxCats: 24, deadline });
    items = items.concat(r.items);
    failed += r.failed;
    capped = capped || r.capped;
  }
  if (wantSeries) {
    const cats = searchOrder(await mergedVod("series"));
    const r = await searchKind("series", cats, q, 20, seen, { maxCats: 12, deadline });
    items = items.concat(r.items);
    failed += r.failed;
    capped = capped || r.capped;
  }
  if (!items.length && failed) throw kino.error("unavailable", "la búsqueda no pudo completarse", { userMessage: "No se pudo completar la búsqueda." });
  return { items: items.slice(0, 60), partial: failed > 0 || capped };
}

export async function search(query) {
  return (await searchDetailed(query)).items;
}

// ---- episodes -------------------------------------------------------------------

export async function episodes(ref) {
  if (String(ref || "").startsWith("idx:s:")) ref = await resolveIdxRef(ref, fetchCategory);
  const id = String(ref || "").replace(/^series:/, "");
  if (!/^\d+$/.test(id)) throw kino.error("not_found");

  const data = await api("get_series_info", { series_id: id });
  if (!data || typeof data !== "object") throw kino.error("not_found");

  const info = data.info || {};
  const seriesInfo = {
    title: info.name ? String(info.name) : undefined,
    poster: info.cover || info.movie_image || undefined,
    overview: info.plot ? String(info.plot).slice(0, 500) : undefined,
    year: info.year ? String(info.year) : undefined,
    rating: info.rating ? parseFloat(info.rating) || undefined : undefined,
    genres: info.genre ? String(info.genre).split(/[,/]/).map((g) => g.trim()).filter(Boolean) : undefined,
  };

  const eps = [];
  for (const [season, epList] of Object.entries(data.episodes || {})) {
    const seasonNum = parseInt(season, 10) || 1;
    for (const ep of Array.isArray(epList) ? epList : []) {
      const epId = String(ep.id || "");
      if (!epId) continue;
      const ext = String((ep.info && ep.info.container_extension) || ep.container_extension || "mp4");
      eps.push({
        season: seasonNum,
        number: parseInt(ep.episode_num, 10) || 1,
        ref: "ep:" + epId + ":" + ext,
        title: ep.title ? String(ep.title) : undefined,
        overview: ep.info && ep.info.plot ? String(ep.info.plot).slice(0, 300) : undefined,
        still: ep.info && ep.info.movie_image ? String(ep.info.movie_image) : undefined,
        airDate: ep.air_date ? String(ep.air_date) : undefined,
      });
    }
  }

  eps.sort((a, b) => a.season - b.season || a.number - b.number);
  return { series: seriesInfo, episodes: eps };
}

// ---- live -----------------------------------------------------------------------

const LIVE_PAGE = 200;
const LIVE_CATS_TTL_MS = 10 * 60 * 1000;
let liveCatsMemo = null;

// Las categorías cambian de un servidor a otro: la caché lleva la clave del servidor activo.
async function liveCats() {
  const key = serverKey();
  if (liveCatsMemo && key && liveCatsMemo.key === key && Date.now() - liveCatsMemo.ts < LIVE_CATS_TTL_MS) return liveCatsMemo.list;
  const merged = mergeLive(await categoryList("live"), { showAdult: true });
  liveCatsMemo = { key: serverKey(), ts: Date.now(), list: merged };
  return merged;
}

const visibleLive = (list) => (showAdult() ? list : list.filter((c) => !c.adult));

export async function liveCategories() {
  return visibleLive(await liveCats()).map((c) => ({
    id: c.id,
    title: c.title,
    ...(c.country ? { country: c.country } : {}),
    ...(c.genre ? { genre: c.genre } : {}),
    ...(c.adult ? { adult: true } : {}),
  }));
}

function liveItem(s, categoryId, adult) {
  const id = String(s.stream_id || "");
  const title = String(s.name || "").trim();
  if (!id || !title) return null;
  return {
    id: "live-" + id,
    title,
    ref: "live:" + id,
    logo: s.stream_icon || undefined,
    number: parseInt(s.num, 10) || undefined,
    categoryId: String(categoryId || s.category_id || ""),
    ...(adult ? { adult: true } : {}),
  };
}

export async function liveChannels({ categoryId, cursor }) {
  const cat = (await liveCats().catch(() => [])).find((c) => c.id === String(categoryId));
  const adult = !!(cat && cat.adult);
  if (adult && !showAdult()) return { items: [] };
  const all = await fetchCategory("get_live_streams", String(categoryId || ""));
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  const items = all.slice(start, start + LIVE_PAGE).map((s) => liveItem(s, categoryId, adult)).filter(Boolean);
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : undefined };
}

export async function liveSearchDetailed({ query }, { budgetMs = 11000 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { items: [], partial: false };
  const deadline = Date.now() + budgetMs;
  const cats = visibleLive(await liveCats());
  const LIMIT = 100;
  const MAX_CATS = 36; // una petición por categoría; el servidor IPTV admite 60 por minuto
  const items = [];
  const seen = new Set();
  let failed = 0;
  let capped = false;
  let scanned = 0;
  for (let i = 0; i < cats.length && items.length < LIMIT; i += 3) {
    if (scanned >= MAX_CATS || Date.now() > deadline) { capped = true; break; }
    const slice = cats.slice(i, i + 3);
    scanned += slice.length;
    const batch = await Promise.all(slice.map(async (cat) => {
      try {
        const data = await fetchCategory("get_live_streams", cat.id);
        return data.filter((s) => String(s.name || "").toLowerCase().includes(q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean)
          .map((it) => ({ ...it, adult: cat.adult === true }));
      } catch (e) {
        if (e && e.code === "rate_limited") capped = true; else failed++;
        return [];
      }
    }));
    for (const list of batch) for (const it of list) if (items.length < LIMIT && !seen.has(it.id)) { seen.add(it.id); items.push(it); }
    if (capped) break;
  }
  if (items.length < LIMIT && scanned < cats.length) capped = true;
  if (!items.length && failed) throw kino.error("unavailable", "la búsqueda no pudo completarse", { userMessage: "No se pudo completar la búsqueda." });
  return { items, partial: failed > 0 || capped };
}

export async function liveSearch(args) {
  const { items } = await liveSearchDetailed(args);
  return { items };
}

// ---- canales de tu país ---------------------------------------------------------

export const isCountryCode = (cc) => COUNTRY_PHRASES.some(([, code]) => code === cc);

// El país va en el nombre de la categoría ("COLOMBIA", "DEPORTES PERU", "VIX - MEXICO"): las que SON el país primero.
export async function countryRow(limit = 20) {
  const cc = homeCountry();
  if (!isCountryCode(cc)) return null;
  const ranked = visibleLive(await liveCats())
    .filter((c) => c.country === cc)
    .map((c) => ({ c, m: countryMatch(c.title) }))
    .sort((a, b) => (a.m && a.m.exact ? 0 : a.m && a.m.starts ? 1 : 2) - (b.m && b.m.exact ? 0 : b.m && b.m.starts ? 1 : 2) || a.c.order - b.c.order)
    .slice(0, 3);
  const items = [];
  const seen = new Set();
  for (const { c } of ranked) {
    if (items.length >= limit) break;
    const data = await fetchCategory("get_live_streams", c.id).catch(() => []);
    for (const s of data) {
      const it = liveItem(s, c.id, c.adult);
      if (!it || items.length >= limit || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...(c.adult ? { adult: true } : {}) });
    }
  }
  return items.length ? { id: "live-country", title: "Canales en vivo", items } : null;
}

function b64text(s) {
  const str = String(s || "");
  if (!str) return "";
  try {
    const bin = atob(str);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += "%" + bin.charCodeAt(i).toString(16).padStart(2, "0");
    return decodeURIComponent(out);
  } catch (_) {
    return str;
  }
}

export async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).slice(0, 50);
  const lists = await Promise.all(ids.map(async (cid) => {
    const streamId = String(cid).replace(/^live-/, "");
    if (!/^\d+$/.test(streamId)) return [];
    try {
      const data = await api("get_short_epg", { stream_id: streamId, limit: "20" });
      const rows = Array.isArray(data) ? data : (data && (data.epg_listings || data.listings || data.epg)) || [];
      return rows.map((e) => ({
        channelId: String(cid),
        title: b64text(e.title),
        description: b64text(e.description || e.descr),
        start: (parseInt(e.start_timestamp, 10) || 0) * 1000,
        end: (parseInt(e.stop_timestamp || e.end_timestamp, 10) || 0) * 1000,
      })).filter((e) => e.title && e.end > e.start && e.end > from && e.start < to);
    } catch (_) {
      return [];
    }
  }));
  return lists.flat();
}

// ---- resolve --------------------------------------------------------------------

export async function resolve(ref) {
  const { url, username, password } = await activeServer();
  let s = String(ref || "");
  if (s.startsWith("idx:m:")) s = await resolveIdxRef(s, fetchCategory);

  if (s.startsWith("live:")) {
    const id = s.slice(5);
    if (!/^\d+$/.test(id)) throw kino.error("not_found");
    return { url: `${url}/live/${username}/${password}/${id}.${liveFormat()}` };
  }

  if (s.startsWith("vod:")) {
    const parts = s.slice(4).split(":");
    const streamId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(streamId)) throw kino.error("not_found");
    noteRecent(streamId, ext, serverKey());
    return { url: `${url}/movie/${username}/${password}/${streamId}.${ext}` };
  }

  if (s.startsWith("ep:")) {
    const parts = s.slice(3).split(":");
    const epId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(epId)) throw kino.error("not_found");
    return { url: `${url}/series/${username}/${password}/${epId}.${ext}` };
  }

  throw kino.error("not_found", "ref desconocido: " + s.slice(0, 30));
}

export async function vodInfoItem(streamId) {
  const data = await api("get_vod_info", { vod_id: String(streamId) });
  const info = (data && data.info) || {};
  const md = (data && data.movie_data) || {};
  return vodItem({
    stream_id: md.stream_id || streamId,
    name: md.name || info.name,
    container_extension: md.container_extension,
    stream_icon: info.movie_image || info.cover_big,
    plot: info.plot,
    rating: info.rating,
    year: info.releasedate ? String(info.releasedate).slice(0, 4) : "",
    genre: info.genre,
    backdrop_path: info.backdrop_path,
    duration_secs: info.duration_secs,
    tmdb_id: info.tmdb_id,
  }, false);
}

// Une a un item la ficha guardada (fondo, tmdb, duración) si la hay.
export function withFicha(item) {
  const e = extras({}, infoCache()[item.id]);
  const out = { ...item };
  if (!out.backdrop && e.backdrop) out.backdrop = e.backdrop;
  if (!out.ids && e.ids) out.ids = e.ids;
  if (!out.runtimeMinutes && e.runtimeMinutes) out.runtimeMinutes = e.runtimeMinutes;
  if (!out.genres && e.genres) out.genres = e.genres;
  return out;
}

export { api, vodItem, seriesItem, genreOf, liveItem };
