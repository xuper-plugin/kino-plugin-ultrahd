// Ultra Hd — películas y series.
// Las credenciales se obtienen automáticamente del servidor bootstrap,
// igual que la app original. El usuario no configura nada.

const BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
const VEGETA_VERSION_CODE = "20"; // android:versionCode from APK manifest
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

const PER_PAGE = 60;
const HOME_PREVIEW = 20;

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

const VEGETA_HEADERS = {
  "X-Vegeta-Version-Code": VEGETA_VERSION_CODE,
  "X-Vegeta-Servers-Direct": "1",
  "Cache-Control": "no-cache, no-store",
  "Pragma": "no-cache",
};

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

async function fetchServerList() {
  const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), {
    headers: { ...VEGETA_HEADERS, "Accept": "application/json" }
  });
  if (!r.ok) throw kino.error("unavailable", "bootstrap " + r.status, { userMessage: "No se pudo conectar con el servicio." });
  const data = r.json();

  let list = [];
  if (typeof data.servers_text === "string" && data.servers_text.trim()) list = parseServers(data.servers_text);
  if (!list.length && typeof data.servers_url === "string" && data.servers_url.trim()) {
    const r2 = await kino.fetch(data.servers_url, { headers: { ...VEGETA_HEADERS, "Accept": "text/plain" } });
    if (r2.ok) list = parseServers(r2.text());
  }
  if (!list.length) throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
  return list.slice(0, MAX_SERVERS);
}

function readSrvs() {
  try { return JSON.parse(kino.storage.get("srvs") || "null"); } catch (_) { return null; }
}

function writeSrvs(st) {
  kino.storage.set("srvs", JSON.stringify(st));
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
      } catch (_) { /* siguiente servidor */ }
    }
  }
  throw kino.error("unavailable", "ningún servidor respondió", { userMessage: "Error al contactar el servidor." });
}

async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api("get_vod_categories");
    st = readSrvs();
  }
  return st.list[st.idx];
}

// ---- items ----------------------------------------------------------------------

const ADULT_RE = /(\bxxx\b|\badult[oa]?s?\b|\bporn\w*|\ber[oó]tic\w*|\bsex(o|y)?\b|\bhentai\b|\+\s?18|18\s?\+|\b18\s?plus\b)/i;

function isAdultName(name) {
  return ADULT_RE.test(String(name || ""));
}

function extras(m) {
  const out = {};
  const genres = String(m.genre || "").split(/[,/|]/).map((g) => g.trim()).filter(Boolean).slice(0, 5);
  if (genres.length) out.genres = genres;
  let backdrop = m.backdrop_path;
  if (Array.isArray(backdrop)) backdrop = backdrop[0];
  if (typeof backdrop === "string" && backdrop) out.backdrop = backdrop;
  const runtime = Math.round((parseInt(m.duration_secs, 10) || 0) / 60) || parseInt(m.episode_run_time, 10) || 0;
  if (runtime > 0) out.runtimeMinutes = runtime;
  const ids = {};
  const tmdb = parseInt(m.tmdb || m.tmdb_id, 10);
  if (tmdb > 0) ids.tmdb = tmdb;
  if (/^tt\d+$/.test(String(m.imdb_id || m.imdb || ""))) ids.imdb = String(m.imdb_id || m.imdb);
  if (Object.keys(ids).length) out.ids = ids;
  return out;
}

function vodItem(m, adult) {
  const id = String(m.stream_id || "");
  if (!id) return null;
  const title = String(m.name || "").trim();
  if (!title) return null;
  const ext = String(m.container_extension || "mp4");
  return {
    id: "vod-" + id,
    ref: "vod:" + id + ":" + ext,
    title,
    kind: "movie",
    poster: m.stream_icon || m.cover || undefined,
    year: m.year ? String(m.year) : undefined,
    rating: m.rating ? parseFloat(m.rating) || undefined : undefined,
    overview: m.plot ? String(m.plot).slice(0, 500) : undefined,
    ...extras(m),
    ...(adult ? { adult: true } : {}),
  };
}

function seriesItem(s, adult) {
  const id = String(s.series_id || "");
  if (!id) return null;
  const title = String(s.name || "").trim();
  if (!title) return null;
  return {
    id: "series-" + id,
    ref: "series:" + id,
    title,
    kind: "series",
    poster: s.cover || s.poster || undefined,
    year: s.year ? String(s.year) : undefined,
    rating: s.rating ? parseFloat(s.rating) || undefined : undefined,
    overview: s.plot ? String(s.plot).slice(0, 500) : undefined,
    ...extras(s),
    ...(adult ? { adult: true } : {}),
  };
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

// ---- home -----------------------------------------------------------------------

export async function home() {
  const [vodCats, seriesCats] = await Promise.all([
    api("get_vod_categories").catch(() => []),
    api("get_series_categories").catch(() => []),
  ]);

  const plain = (cats) => (Array.isArray(cats) ? cats : []).filter((c) => !isAdultName(c.category_name));
  const topVod = plain(vodCats).slice(0, 4);
  const topSeries = plain(seriesCats).slice(0, 3);

  const vodRows = await Promise.all(topVod.map(async (cat) => {
    try {
      const data = await api("get_vod_streams", { category_id: cat.category_id });
      const items = (Array.isArray(data) ? data : []).slice(0, HOME_PREVIEW).map((x) => vodItem(x)).filter(Boolean);
      if (!items.length) return null;
      return { id: "vod-" + cat.category_id, title: cat.category_name, genre: genreOf(cat.category_name) || "películas", ref: "vod:" + cat.category_id, items };
    } catch (_) { return null; }
  }));

  const seriesRows = await Promise.all(topSeries.map(async (cat) => {
    try {
      const data = await api("get_series", { category_id: cat.category_id });
      const items = (Array.isArray(data) ? data : []).slice(0, HOME_PREVIEW).map((x) => seriesItem(x)).filter(Boolean);
      if (!items.length) return null;
      return { id: "series-" + cat.category_id, title: cat.category_name, genre: genreOf(cat.category_name) || "series", ref: "series:" + cat.category_id, items };
    } catch (_) { return null; }
  }));

  const rows = [...vodRows, ...seriesRows].filter(Boolean);
  if (!rows.length) throw kino.error("unavailable", "sin contenido", { userMessage: "Sin contenido disponible por ahora." });
  return rows;
}

// ---- browse ---------------------------------------------------------------------

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;

  if (ref.startsWith("vod:")) {
    const catId = ref.slice(4);
    const data = await api("get_vod_streams", { category_id: catId });
    const all = (Array.isArray(data) ? data : []).map((x) => vodItem(x)).filter(Boolean);
    return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : undefined };
  }

  if (ref.startsWith("series:")) {
    const catId = ref.slice(7);
    // Si el ref tiene solo la categoría (sin ":"), browsear categoría
    if (!/^\d+:\d+/.test(catId)) {
      const data = await api("get_series", { category_id: catId });
      const all = (Array.isArray(data) ? data : []).map((x) => seriesItem(x)).filter(Boolean);
      return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : undefined };
    }
  }

  return { items: [] };
}

// ---- search ---------------------------------------------------------------------

async function searchInCategories(action, catList, q, mapFn, limit) {
  const results = [];
  // Fetch categories in batches of 8 in parallel
  const BATCH = 8;
  for (let i = 0; i < catList.length && results.length < limit; i += BATCH) {
    const batch = catList.slice(i, i + BATCH);
    const fetched = await Promise.all(
      batch.map((cat) =>
        api(action, { category_id: cat.category_id })
          .then((data) =>
            (Array.isArray(data) ? data : [])
              .filter((x) => String(x.name || "").toLowerCase().includes(q))
              .map((x) => mapFn(x, isAdultName(cat.category_name)))
              .filter(Boolean)
          )
          .catch(() => [])
      )
    );
    for (const items of fetched) {
      for (const item of items) {
        if (results.length >= limit) break;
        results.push(item);
      }
    }
  }
  return results;
}

export async function search(query) {
  const q = String((query && query.q) || "").trim().toLowerCase();
  if (!q) return [];
  const type = String((query && query.type) || "any");

  const wantVod = type === "any" || type === "movie";
  const wantSeries = type === "any" || type === "series";

  const [vodCats, seriesCats] = await Promise.all([
    wantVod ? api("get_vod_categories").catch(() => []) : Promise.resolve([]),
    wantSeries ? api("get_series_categories").catch(() => []) : Promise.resolve([]),
  ]);

  const [vodResults, seriesResults] = await Promise.all([
    wantVod ? searchInCategories("get_vod_streams", Array.isArray(vodCats) ? vodCats : [], q, vodItem, 40) : Promise.resolve([]),
    wantSeries ? searchInCategories("get_series", Array.isArray(seriesCats) ? seriesCats : [], q, seriesItem, 20) : Promise.resolve([]),
  ]);

  return [...vodResults, ...seriesResults].slice(0, 60);
}

// ---- episodes -------------------------------------------------------------------

export async function episodes(ref) {
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

export async function liveCategories() {
  const cats = await api("get_live_categories");
  return (Array.isArray(cats) ? cats : [])
    .map((c) => {
      const title = String(c.category_name || "").trim();
      return { id: String(c.category_id || ""), title, ...(isAdultName(title) ? { adult: true } : {}) };
    })
    .filter((c) => c.id && c.title);
}

function liveItem(s, categoryId) {
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
  };
}

export async function liveChannels({ categoryId, cursor }) {
  const data = await api("get_live_streams", { category_id: String(categoryId || "") });
  const all = Array.isArray(data) ? data : [];
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  const items = all.slice(start, start + LIVE_PAGE).map((s) => liveItem(s, categoryId)).filter(Boolean);
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : undefined };
}

export async function liveSearch({ query }) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { items: [] };
  const cats = await liveCategories().catch(() => []);
  const LIMIT = 100;
  const BATCH = 8;
  const items = [];
  for (let i = 0; i < cats.length && items.length < LIMIT; i += BATCH) {
    const fetched = await Promise.all(cats.slice(i, i + BATCH).map((cat) =>
      api("get_live_streams", { category_id: cat.id })
        .then((data) => (Array.isArray(data) ? data : [])
          .filter((s) => String(s.name || "").toLowerCase().includes(q))
          .map((s) => liveItem(s, cat.id))
          .filter(Boolean)
          .map((it) => ({ ...it, adult: cat.adult === true })))
        .catch(() => [])
    ));
    for (const list of fetched) for (const it of list) if (items.length < LIMIT) items.push(it);
  }
  return { items };
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
  const s = String(ref || "");

  if (s.startsWith("live:")) {
    const id = s.slice(5);
    if (!/^\d+$/.test(id)) throw kino.error("not_found");
    return { url: `${url}/live/${username}/${password}/${id}.m3u8` };
  }

  if (s.startsWith("vod:")) {
    const parts = s.slice(4).split(":");
    const streamId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(streamId)) throw kino.error("not_found");
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
