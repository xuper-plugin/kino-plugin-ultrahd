// La pantalla propia (apiVersion 14, vía enhancements) y la sección nativa. La vista es pura: lo cargado vive en memoria
// y, si el runtime se reinicia, el temporizador `tick` lo vuelve a traer; el estado solo guarda tab, lang, n y fallos.
// Todo lo que viene del catálogo se descarta si cambia el servidor activo (categorías e ids no coinciden entre servidores).
import * as cat from "./catalog.js";
import { recentEntriesAll, rememberCard } from "./recent.js";
import { say, twin } from "./i18n.js";
import { put } from "./store.js";
import { indexStep, indexNeeded, idxRefFor, findKey } from "./titleIndex.js";
import { enrichTmdb, tmdbAvailable } from "./tmdbLazy.js";
import { LANG_ORDER, isLang } from "./names.js";
import { fetchHomeFeed, fetchLiveFeed } from "./homeFeed.js";
import { TAB_IDS, browseView, searchView, liveView, settingsView, verifyingView, firstPickView, cardOf, slidesOf } from "./screenView.js";

const PLUGIN_VERSION = "0.8.0";
const TAB_KEY = "browseTab";
const LANG_KEY = "browseLang";
const HIST_KEY = "searchHist:v1";
const HIST_MAX = 24;
const CHANNELS_CAP = 60;
const RAILS_PER_TAB = 12;
const RAIL_ITEMS = 20;
const FEATURED = 6;
const SCREEN_ROUTES = ["main", "search", "live", "settings"];

const memo = new Map();
const liveChans = new Map();
// Home fila por fila: el plan (categorías ordenadas) y las filas que van llegando, por idioma. Cada fila es una unidad del
// `tick`, así que aparece apenas carga en vez de esperar al bloque entero. Snapshot en kino.storage pinta al instante al reabrir.
const homePlan = new Map();  // lang -> [{ kind:'movies'|'series', id, title }]
const homeRails = new Map(); // lang -> Map(`${kind}:${id}` -> { rail, card } | null (cargada, sin resultados))
const homeSlides = new Map(); // lang -> [slide,...] acumulados (tope FEATURED)
const homeHeroDone = new Set(); // idiomas cuyo hero (slides enriquecidos) ya se armó
const homeFeedData = new Map(); // lang -> { slides, rows, langs, movies, series } del feed pre-armado (si se bajó): Home al instante
const homeFeedTried = new Set(); // idiomas en los que ya se intentó el feed (haya salido o no)
let liveFeedData = null; // { slides, rails, ... } de la primera pantalla de En vivo pre-armada (1x/día); null = sin bajar
let liveFeedTried = false; // ya se intentó el feed de En vivo (haya salido o no)
let homeLangsList = null; // idiomas disponibles (para los chips Español/Latino/España/English); se llena con el plan
let countryCards = null;
let recentCards = null;
let liveCats = null;
let found = null;
let liveFound = null;
let pickServers = null; // lista para el selector de servidor (respaldo si el auto-elegido no responde)
let cacheKey = null;
let autoPickTried = false; // primera instalación: ya se intentó elegir servidor automáticamente (en español, sin que la persona elija)

// La persona ya eligió servidor al menos una vez: se recuerda para no volver a mostrar el selector inicial (se cambia con 🌐).
const SRVCHOSEN_KEY = "srvChosen:v1";
const serverChosen = () => { try { return kino.storage.get(SRVCHOSEN_KEY) === "1"; } catch (_) { return false; } };
const markServerChosen = () => { try { put(SRVCHOSEN_KEY, "1"); } catch (_) { /* da igual */ } };

function resetCaches() {
  memo.clear();
  liveChans.clear();
  homePlan.clear();
  homeRails.clear();
  homeSlides.clear();
  homeHeroDone.clear();
  homeFeedData.clear();
  homeFeedTried.clear();
  liveFeedData = null;
  liveFeedTried = false;
  homeLangsList = null;
  countryCards = null;
  recentCards = null;
  liveCats = null;
  found = null;
  liveFound = null;
}

// ---- snapshot del Home (pintado instantáneo al reabrir) ----
// Guarda las filas ya cargadas del Home en kino.storage, por servidor + idioma. Al abrir, si todavía no hay filas frescas en
// memoria, se pintan las del snapshot (marcadas como viejas); el `tick` recarga por detrás y las reemplaza por las frescas.
const HOME_SNAP_PREFIX = "homeSnap:";
const SNAP_V = 3;
const SNAP_MAX = 10 * 1024; // por pestaña; 4 pestañas caben en el presupuesto de la clase homeSnap (40 KB)
const slimCard = (c) => ({ id: c.id, ref: c.ref, title: c.title, ...(c.kind ? { kind: c.kind } : {}), ...(c.poster ? { poster: c.poster } : {}) });
const snapKey = (tab, lang) => HOME_SNAP_PREFIX + "v" + SNAP_V + ":" + cat.serverKey() + ":" + tab + ":" + (lang || "-");
const slimRail = (r, per) => ({ id: r.id, title: r.title, ref: r.ref, items: (r.items || []).slice(0, per).map(slimCard) });
// Snapshot compacto de una pestaña (filas ya en forma de tarjeta) para pintar al instante al reabrir, aun antes de bajar el feed.
function writeTabSnap(tab, lang, slides, rails) {
  try {
    if (!rails || !rails.length) return;
    // Se recorta hasta caber: menos ítems por fila y, si hace falta, menos filas. Tarjetas slim (lo que una fila necesita).
    for (const maxRails of [rails.length, 10, 8, 6]) {
      for (let per = 10; per >= 5; per -= 2) {
        const slim = { v: SNAP_V, at: Date.now(), slides: (slides || []).slice(0, FEATURED).map(slimCard), rails: rails.slice(0, maxRails).map((r) => slimRail(r, per)) };
        const text = JSON.stringify(slim);
        if (text.length <= SNAP_MAX) { put(snapKey(tab, lang), text); return; }
      }
    }
  } catch (_) { /* almacenamiento lleno: sin snapshot */ }
}
function readSnap(tab, lang) {
  try {
    const o = JSON.parse(kino.storage.get(snapKey(tab, lang)) || "null");
    return o && o.v === SNAP_V && Array.isArray(o.rails) && o.rails.length ? o : null;
  } catch (_) { return null; }
}
// Snapshot del Home en vivo progresivo: arma las filas desde lo ya cargado en memoria y lo guarda.
function writeHomeSnap(lang) {
  const m = homeRails.get(lang);
  if (!m) return;
  const plan = homePlan.get(lang) || [];
  const rails = plan.map((p) => m.get(`${p.kind}:${p.id}`)).filter((e) => e && e.card).map((e) => e.card);
  writeTabSnap("home", lang, homeSlides.get(lang) || [], rails);
}
const readHomeSnap = (lang) => readSnap("home", lang);

function syncServer() {
  const key = cat.serverKey();
  if (cacheKey === null || cacheKey === "") { cacheKey = key; return; }
  if (key !== cacheKey) { resetCaches(); cacheKey = key; }
}

const langOf = (ev) => (ev && ev.lang === "en" ? "en" : "es");
const getStored = (k) => { try { return kino.storage.get(k) || null; } catch (_) { return null; } };
const setStored = (k, v) => { put(k, v); };
const storedTab = () => { const t = getStored(TAB_KEY); return TAB_IDS.includes(t) ? t : null; };
const wantedLang = (state) => (isLang(state.lang) ? state.lang : isLang(getStored(LANG_KEY)) ? getStored(LANG_KEY) : LANG_ORDER[0]);

const histKey = () => HIST_KEY + ":" + cat.serverKey();

function readHistory() {
  try {
    const o = JSON.parse(kino.storage.get(histKey()) || "null");
    return o && o.v === 1 && Array.isArray(o.e) ? o.e.filter((c) => c && typeof c.id === "string" && typeof c.ref === "string").slice(0, HIST_MAX) : [];
  } catch (_) { return []; }
}

function rememberFound(cards) {
  try {
    const slimmed = cards.filter((c) => c.adult !== true).slice(0, 12).map(({ id, ref, title, kind, poster }) => ({ id, ref, title, kind, ...(poster ? { poster } : {}) }));
    const ids = new Set(slimmed.map((c) => c.id));
    put(histKey(), JSON.stringify({ v: 1, e: [...slimmed, ...readHistory().filter((c) => !ids.has(c.id))].slice(0, HIST_MAX) }));
  } catch (_) { /* sin historial */ }
}

const railCards = (rails) => rails.map((r) => ({ id: r.id, title: r.title, ref: r.ref, items: r.items.map(cardOf) }));
const channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...(i.adult ? { adult: true } : {}) });

// Cada fila es una petición y el servidor IPTV admite 60 por minuto: el Home pide pocas filas y solo fichas de películas.
async function loadVodTab(tab, lang, { home = false, offset = 0 } = {}) {
  const kind = tab === "movies" ? "vod" : "series";
  const maxRails = home ? (tab === "movies" ? 7 : 4) : RAILS_PER_TAB;
  // El índice de títulos se puebla/actualiza mientras carga el Home de la pantalla (un paso acotado en tiempo; nunca lanza).
  const info = await cat.loadRailsInfo(kind, maxRails, RAIL_ITEMS, { lang, home, offset });
  const wantFeatured = home && tab === "series" ? 0 : FEATURED;
  const featured = info.rails.flatMap((r) => r.items).filter((i) => i.overview).slice(0, wantFeatured);
  if (featured.length) await cat.enrichFeatured(kind, featured, wantFeatured);
  const rails = info.rails.map((r) => ({ ...r, items: r.items.map(cat.withFicha) }));
  const key = `${home ? "home-" : ""}${tab}:${lang}`;
  const prev = offset > 0 ? memo.get(key) : null;
  const have = new Set(prev ? prev.rails.map((r) => r.id) : []);
  const fresh = railCards(rails).filter((r) => !have.has(r.id));
  memo.set(key, { slides: prev ? prev.slides : slidesOf(rails), rails: prev ? [...prev.rails, ...fresh] : fresh, langs: info.langs, lang: info.lang, partial: info.failed > 0, hasMore: !home && !!info.hasMore, next: info.next, cats: prev ? prev.cats : info.cats });
}

// ---- Home fila por fila ----
const HOME_MOVIES = 7;
const HOME_SERIES = 4;

// Intenta el feed pre-armado del servidor. Si llega, el Home queda listo para pintar al instante (sin tocar el IPTV) y se
// guarda el snapshot local; si no, se marca intentado y unitsFor deja correr la carga en vivo. Nunca lanza.
async function loadHomeFeed(lang) {
  homeFeedTried.add(lang);
  let feed = null;
  try { feed = await fetchHomeFeed(cat.serverKey()); } catch (_) { feed = null; }
  if (!feed || !feed.rows.length) return;
  // El feed trae el idioma por defecto del servidor; se usa para ese idioma (los demás caen a vivo).
  const key = feed.lang && isLang(feed.lang) ? feed.lang : lang;
  homeFeedData.set(key, { slides: feed.slides || [], rows: feed.rows, langs: feed.langs || [], movies: feed.movies || null, series: feed.series || null });
  if (Array.isArray(feed.langs) && feed.langs.length) homeLangsList = feed.langs;
  // Snapshot local de cada pestaña, para que la próxima apertura pinte al instante aun antes de bajar el feed.
  writeTabSnap("home", key, feed.slides, feed.rows);
  if (feed.movies) writeTabSnap("movies", key, feed.movies.slides, feed.movies.rows);
  if (feed.series) writeTabSnap("series", key, feed.series.slides, feed.series.rows);
}

// Intenta el feed pre-armado de En vivo (la primera pantalla: filas de canales por categoría, refrescado ~1x/día en el Action).
// Si llega, la pestaña En vivo se pinta al instante (sin recorrer el IPTV) y se guarda snapshot local. Nunca lanza.
async function loadLiveFeed() {
  liveFeedTried = true;
  let f = null;
  try { f = await fetchLiveFeed(cat.serverKey()); } catch (_) { f = null; }
  if (!f || !f.rails || !f.rails.length) return;
  liveFeedData = { slides: [], rails: f.rails, langs: [], lang: null, partial: false };
  writeTabSnap("live", "-", [], f.rails);
}

// El plan del Home: la lista ordenada de categorías (películas y series) a mostrar como filas, barato (solo listas cacheadas).
async function loadHomePlan(lang) {
  const [mv, sr] = await Promise.all([
    cat.homeRailPlan("vod", HOME_MOVIES, lang).catch(() => ({ cats: [] })),
    cat.homeRailPlan("series", HOME_SERIES, lang).catch(() => ({ cats: [] })),
  ]);
  const plan = [
    ...mv.cats.map((c) => ({ kind: "movies", id: c.id, title: c.title })),
    ...sr.cats.map((c) => ({ kind: "series", id: c.id, title: c.title })),
  ];
  homePlan.set(lang, plan);
  if (Array.isArray(mv.langs) && mv.langs.length) homeLangsList = mv.langs;
  if (!homeRails.has(lang)) homeRails.set(lang, new Map());
}

// Carga UNA fila (categoría) del Home y la deja lista para pintar; no bloquea con TMDB (Kino completa los logos después).
async function loadHomeRail(kindTab, lang, catId) {
  const kind = kindTab === "movies" ? "vod" : "series";
  const rail = await cat.oneRail(kind, catId, RAIL_ITEMS, lang);
  if (!homeRails.has(lang)) homeRails.set(lang, new Map());
  const slot = `${kindTab}:${catId}`;
  if (!rail || !rail.items || !rail.items.length) { homeRails.get(lang).set(slot, null); return; }
  const full = { ...rail, items: rail.items.map(cat.withFicha) };
  homeRails.get(lang).set(slot, { rail: full, card: railCards([full])[0] });
  writeHomeSnap(lang);
}

// El hero (slider): necesita portada ancha (backdrop, de la ficha) + sinopsis (del listado). Corre tras las primeras filas:
// enriquece unos candidatos con TMDB y arma los slides. Así las filas salen primero y el banner se llena enseguida.
async function loadHomeHero(lang) {
  const m = homeRails.get(lang);
  if (!m) return;
  const plan = homePlan.get(lang) || [];
  const loaded = plan.map((p) => m.get(`${p.kind}:${p.id}`)).filter((e) => e && e.rail);
  // Candidatos: los primeros ítems de las filas cargadas (el enrich les trae backdrop Y sinopsis desde la ficha).
  // Un ítem por fila (variedad) para el pool del hero; se enriquecen varios porque no todos traen backdrop.
  const oneEachVod = loaded.filter((e) => e.rail.id.startsWith("vod-")).map((e) => e.rail.items[0]).filter(Boolean);
  const oneEachSr = loaded.filter((e) => e.rail.id.startsWith("series-")).map((e) => e.rail.items[0]).filter(Boolean);
  if (oneEachVod.length) await cat.enrichFeatured("vod", oneEachVod, 10).catch(() => {});
  if (oneEachSr.length) await cat.enrichFeatured("series", oneEachSr, 6).catch(() => {});
  const slides = [];
  for (const p of plan) {
    const e = m.get(`${p.kind}:${p.id}`);
    if (!e || !e.rail) continue;
    const refreshed = { ...e.rail, items: e.rail.items.map(cat.withFicha) };
    for (const s of slidesOf([refreshed])) if (slides.length < FEATURED && !slides.some((x) => x.id === s.id)) slides.push(s);
  }
  if (slides.length) { homeSlides.set(lang, slides); writeHomeSnap(lang); }
}

async function loadLiveTab() {
  const cats = (await cat.liveCategories()).slice(0, RAILS_PER_TAB);
  let failed = 0;
  const rails = [];
  const results = [];
  for (let i = 0; i < cats.length; i += 3) {
    results.push(...await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try { return { c, page: await cat.liveChannels({ categoryId: c.id }) }; } catch (_) { failed++; return null; }
    })));
  }
  for (const r of results) {
    if (!r) continue;
    const items = r.page.items.slice(0, RAIL_ITEMS).map(channelCard);
    if (items.length) rails.push({ id: "lcat-" + r.c.id, title: r.c.title, ref: "lcat:" + r.c.id, items });
  }
  if (!rails.length && failed) throw new Error("live");
  memo.set("live", { slides: [], rails: railCards(rails), langs: [], lang: null, partial: failed > 0 });
}

async function loadRecent() {
  const key = cat.serverKey();
  const out = [];
  const seen = new Set();
  let lookups = 0;
  // Se leen los recientes de TODOS los servidores. Los del servidor activo usan su ref directo (rápido); los de otro servidor
  // se resuelven por título con el índice (idxRefFor), para que "Continuar viendo" no se pierda al cambiar de servidor.
  for (const e of recentEntriesAll()) {
    let card = e.card;
    if (!card && e.srv === key && lookups < 6) {
      lookups++;
      try {
        const item = await cat.vodInfoItem(e.id);
        card = item ? cardOf(item) : null;
        if (card) rememberCard(key, e.id, card);
      } catch (_) { card = null; }
    }
    if (!card || (card.adult && !cat.showAdult())) continue;
    const dk = findKey(card.title);
    if (!dk || seen.has(dk)) continue;
    let ref = card.ref;
    if (e.srv !== key) {
      const ix = idxRefFor(card.kind, card.title, card.year);
      if (!ix) continue; // sin año no se puede resolver en otro servidor
      ref = ix;
    }
    seen.add(dk);
    out.push(ref === card.ref ? card : { ...card, ref });
    if (out.length >= 12) break;
  }
  recentCards = out;
}

const countryOn = () => cat.homeCountry() !== "none";

// La pestaña (movies/series) pre-armada del feed para este idioma, o null si el feed no la trae (p. ej. feed v1 o sin cargar).
function feedTabFor(tab, lang) {
  const f = homeFeedData.get(lang);
  if (!f) return null;
  const t = tab === "movies" ? f.movies : tab === "series" ? f.series : null;
  return t && Array.isArray(t.rows) && t.rows.length ? t : null;
}

// Primera instalación: elige el servidor automáticamente, PREFIRIENDO los de habla hispana (la mayoría del público), sin que la
// persona elija ni ver el selector. selectServer prueba el servidor (y alterna dentro del mismo país), así el elegido responde.
// Si ninguno responde (p. ej. sin internet), queda sin elegir y mainView muestra el selector como respaldo. El 🌐 lo cambia luego.
async function autoPick() {
  autoPickTried = true;
  try {
    const list = await cat.serverList();
    const items = list.items || [];
    const order = [...items.filter((x) => x.es), ...items.filter((x) => !x.es)].slice(0, 6);
    for (const it of order) {
      const r = await cat.selectServer(String(it.i)).catch(() => ({ ok: false }));
      if (r && r.ok) { markServerChosen(); cacheKey = cat.serverKey(); return; }
    }
  } catch (_) { /* sin internet: queda el selector de respaldo */ }
}

function unitsFor(tab, lang) {
  // Primera instalación: se elige servidor automáticamente (autopick, en español). Si no logró ninguno, se cae al selector manual.
  if (!serverChosen()) return autoPickTried ? ["health", "pick"] : ["autopick"];
  if (tab === "home") {
    // El Home carga fila por fila: primero el plan (categorías ordenadas), luego UNA unidad por fila (`hrail:...`), que aparece
    // apenas carga; país, recientes e índice van al final. Hasta tener el plan, solo health + plan.
    // Primero el feed pre-armado (una sola descarga): si está, el Home se pinta entero al instante y NO se recorre el IPTV.
    // Si el feed falta/está viejo/falló, se cae a la carga en vivo progresiva (plan + una unidad por fila + hero).
    if (homeFeedData.has(lang)) return [`hfeed:${lang}`, "health", ...(countryOn() ? ["country"] : []), "recent", "index"];
    const plan = homePlan.get(lang) || [];
    const railUnits = plan.map((p) => `hrail:${p.kind}:${lang}:${p.id}`);
    const heroUnit = railUnits.length ? [`hhero:${lang}`] : [];
    // hfeed va primero (no necesita el chequeo): si está el feed, el Home sale sin esperar los ~3s de "Verificando…".
    return [`hfeed:${lang}`, "health", `hplan:${lang}`, ...railUnits, ...heroUnit, ...(countryOn() ? ["country"] : []), "recent", "index"];
  }
  // Películas/Series: el feed (v2) también trae estas pestañas pre-armadas. Si la de este idioma ya está, se pinta al instante
  // y no se recorre el IPTV; si falta, se intenta el feed una vez (hfeed) y, si no llega o es v1, cae a la carga en vivo.
  if (tab === "movies" || tab === "series") {
    if (feedTabFor(tab, lang)) return [`hfeed:${lang}`, "health"];
    if (!homeFeedTried.has(lang)) return [`hfeed:${lang}`, "health", `tab:${tab}:${lang}`];
    return ["health", `tab:${tab}:${lang}`];
  }
  // En vivo: primero el feed pre-armado (1x/día); si está, la primera pantalla sale al instante. Cambiar de categoría es en vivo.
  if (tab === "live") {
    if (liveFeedData) return ["lfeed", "health"];
    if (!liveFeedTried) return ["lfeed", "health", "tab:live"];
    return ["health", "tab:live"];
  }
  return ["health", `tab:${tab}:${lang}`];
}

function memoKey(unit) {
  const [prefix, tab, lang] = unit.split(":");
  if (tab === "live") return "live";
  return prefix === "home" ? `home-${tab}:${lang}` : `${tab}:${lang}`;
}

function isDone(unit) {
  if (unit === "country") return countryCards !== null;
  if (unit === "recent") return recentCards !== null;
  if (unit === "index") return !indexNeeded();
  if (unit === "health") return cat.healthReady();
  if (unit === "autopick") return autoPickTried;
  if (unit === "pick") return pickServers !== null;
  if (unit === "lfeed") return liveFeedTried;
  if (unit.startsWith("hfeed:")) return homeFeedTried.has(unit.slice("hfeed:".length));
  if (unit.startsWith("hplan:")) return homePlan.has(unit.slice("hplan:".length));
  if (unit.startsWith("hhero:")) return homeHeroDone.has(unit.slice("hhero:".length));
  if (unit.startsWith("hrail:")) {
    const [, kind, lang, id] = unit.split(":");
    const m = homeRails.get(lang);
    return !!m && m.has(`${kind}:${id}`); // cargada (o vacía) = hecha
  }
  return memo.has(memoKey(unit));
}

function pendingUnit(state, tab, device) {
  const failed = state.failed || {};
  const lang = wantedLang(state);
  return unitsFor(tab, lang).find((u) => !isDone(u) && !failed[u]) || null;
}

async function runUnit(unit) {
  if (unit === "country") {
    const row = await cat.countryRow(20);
    countryCards = row ? row.items.map(cardOf) : [];
  } else if (unit === "recent") await loadRecent();
  else if (unit === "index") {
    // Un paso corto por tick: el índice se llena a ratos sin frenar el Home. "paused" = sigue en el próximo tick.
    const out = await indexStep({ budgetMs: 2500 });
    if (out === "error" || out === "wait") throw new Error("índice: " + out);
  }
  else if (unit === "health") await cat.healthCheck();
  else if (unit === "autopick") await autoPick();
  else if (unit === "pick") pickServers = await cat.serverList();
  else if (unit === "lfeed") await loadLiveFeed();
  else if (unit.startsWith("hfeed:")) await loadHomeFeed(unit.slice("hfeed:".length));
  else if (unit.startsWith("hplan:")) await loadHomePlan(unit.slice("hplan:".length));
  else if (unit.startsWith("hhero:")) { await loadHomeHero(unit.slice("hhero:".length)); homeHeroDone.add(unit.slice("hhero:".length)); }
  else if (unit.startsWith("hrail:")) {
    const [, kind, lang, id] = unit.split(":");
    await loadHomeRail(kind, lang, id);
  }
  else {
    const [prefix, tab, lang] = unit.split(":");
    if (tab === "live") await loadLiveTab();
    else await loadVodTab(tab, lang, { home: prefix === "home" });
  }
}

function tabData(tab, lang, state = {}) {
  if (tab === "live") {
    // Feed pre-armado (1x/día) o, si todavía no llegó, el snapshot local (reapertura instantánea); si no, la carga en vivo.
    if (liveFeedData) return liveFeedData;
    const m = memo.get("live");
    if (m) return m;
    const snap = readSnap("live", "-");
    return snap ? { slides: [], rails: snap.rails, langs: [], lang: null, partial: false, stale: true } : null;
  }
  if (tab !== "home") {
    // Feed: la pestaña ya viene pre-armada → se pinta al instante, con su selector de categorías (cats) y sin paginación.
    const feedTab = feedTabFor(tab, lang);
    const fromFeed = feedTab ? { slides: (feedTab.slides || []).slice(0, FEATURED), rails: feedTab.rows, cats: feedTab.cats || [], langs: homeLangsList, lang, partial: false, hasMore: false } : null;
    // Sin feed todavía: el snapshot local pinta al instante (marcado stale) hasta que baje el feed o la carga en vivo.
    const snap = !memo.get(`${tab}:${lang}`) && !fromFeed ? readSnap(tab, lang) : null;
    const fromSnap = snap ? { slides: (snap.slides || []).slice(0, FEATURED), rails: snap.rails, cats: [], langs: homeLangsList, lang, partial: false, hasMore: false, stale: true } : null;
    const base = memo.get(`${tab}:${lang}`) || fromFeed || fromSnap;
    const one = base && state.cat ? onlyCat.get(`${tab}:${lang}:${state.cat}`) : null;
    return one ? { ...base, rails: one.rails, hasMore: false, catSel: state.cat } : base ? { ...base, catSel: "" } : null;
  }
  // El Home se muestra en orden randómico (filas y tarjetas), renovado en cada entrada, para que no se vea igual cada vez.
  const rnd = (rows) => randomizeHome(rows, homeSeed);
  // Feed pre-armado: si se bajó para este idioma, es la fuente (Home entero al instante, sin recorrer el IPTV).
  const feed = homeFeedData.get(lang);
  if (feed) return { slides: (feed.slides || []).slice(0, FEATURED), rails: rnd(feed.rows), langs: homeLangsList || feed.langs, lang, partial: false };
  // Home fila por fila: las filas frescas ya cargadas, en el orden del plan.
  const plan = homePlan.get(lang) || [];
  const m = homeRails.get(lang);
  const freshRails = m ? plan.map((p) => m.get(`${p.kind}:${p.id}`)).filter((e) => e && e.card).map((e) => e.card) : [];
  const allDone = homePlan.has(lang) && plan.length > 0 && m && m.size >= plan.length;
  // Randómico solo cuando el Home está completo (feed/snapshot/allDone). Mientras carga fila por fila se deja el orden natural,
  // así las filas no saltan de sitio en cada tick mientras van apareciendo.
  const fresh = () => ({ slides: (homeSlides.get(lang) || []).slice(0, FEATURED), rails: allDone ? rnd(freshRails) : freshRails, langs: homeLangsList, lang, partial: false });
  const snap = readHomeSnap(lang);
  // Con snapshot (reapertura): se pinta al instante y se mantiene mientras recarga por detrás, hasta terminar TODAS las filas;
  // así no parpadea (no encoge a 1 fila para volver a crecer). Sin snapshot (primera vez): las filas van apareciendo una a una.
  if (snap && !allDone) return { slides: (snap.slides || []).slice(0, FEATURED), rails: rnd(snap.rails), langs: homeLangsList, lang, partial: false, stale: true };
  if (freshRails.length) return fresh();
  if (snap) return { slides: (snap.slides || []).slice(0, FEATURED), rails: rnd(snap.rails), langs: homeLangsList, lang, partial: false, stale: true };
  return null;
}

const tabOf = (state, route) => {
  const a = route && route.args && typeof route.args === "object" ? route.args : {};
  return TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS.includes(a.tab) ? a.tab : storedTab() || TAB_IDS[0];
};

function mainView(ctx) {
  const state = ctx.state || {};
  // Primera instalación: mientras se auto-elige el servidor (en español), un breve "Verificando…". Si no encontró ninguno, se
  // muestra el selector manual como respaldo. El 🌐 del header permite cambiar de servidor cuando se quiera.
  if (!serverChosen()) {
    if (!autoPickTried) return verifyingView({ device: ctx.device });
    if (!cat.healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
    return firstPickView({ servers: pickServers, failed: !!(state.failed && state.failed.pick), device: ctx.device });
  }
  const tab = tabOf(state, ctx.route);
  const lang = wantedLang(state);
  const data = tabData(tab, lang, state);
  // Arranque rápido: con un servidor ya elegido, si hay Home que mostrar (feed pre-armado o snapshot de la última sesión),
  // se pinta YA, sin esperar a "Verificando servidores…". El chequeo sigue corriendo por detrás (unitsFor) y la verificación
  // real del servidor ocurre antes de reproducir (resolve). Solo se muestra "Verificando…" cuando no hay nada que pintar.
  if (!data && !cat.healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
  const failed = unitsFor(tab, lang).some((u) => state.failed && state.failed[u]);
  return browseView({
    tab, data, recent: recentCards || [], country: countryCards || [],
    loading: pendingUnit(state, tab, ctx.device) !== null, failed: !data && failed,
    // Con una pestaña del feed a la vista (Inicio/Películas/Series), se re-baja cada 30 min por si el Action publicó uno nuevo.
    refresh: tab !== "live" && homeFeedData.has(lang),
    device: ctx.device,
  });
}

export async function screen(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const state = c.state && typeof c.state === "object" ? c.state : {};
  const name = c.route && SCREEN_ROUTES.includes(c.route.name) ? c.route.name : "main";
  try {
    syncServer();
    if (name === "search") {
      const query = typeof state.sq === "string" ? state.sq : "";
      const items = found && found.q === query ? found.items : null;
      const status = query === "" ? "idle" : state.sstate === "fail" ? "fail" : items ? "done" : "loading";
      const enriching = !!(found && found.q === query && items && tmdbAvailable() && found.enr < found.raw.length);
      return searchView({ query, status, items, enriching, partial: !!(found && found.q === query && found.partial), history: query === "" ? readHistory() : [], device: c.device });
    }
    if (name === "live") {
      const cur = typeof state.lcat === "string" ? state.lcat : liveCats && liveCats[0] ? liveCats[0].id : null;
      const lq = typeof state.lq === "string" ? state.lq : "";
      const failed = state.lfail === true;
      if (lq !== "") {
        const done = liveFound && liveFound.q === lq;
        return liveView({ cats: liveCats, cat: cur, items: done ? liveFound.items : null, query: lq, searching: !done, partial: !!(done && liveFound.partial), failed, device: c.device });
      }
      return liveView({ cats: liveCats, cat: cur, items: cur !== null && liveChans.has(cur) ? liveChans.get(cur) : null, failed, device: c.device });
    }
    if (name === "settings") {
      let appVersion = "";
      try { appVersion = typeof kino.appVersion === "string" ? kino.appVersion : ""; } catch (_) { appVersion = ""; }
      return settingsView({ srv: state.srv || null, busy: state.busy === true, pluginVersion: PLUGIN_VERSION, appVersion, device: c.device });
    }
    return mainView({ ...c, state });
  } catch (_) {
    return { type: "Column", padding: 16, children: [{ type: "settings", key: "classicForm" }] };
  }
}

const cardsOf = (items) => (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === "string" && typeof i.ref === "string").slice(0, CHANNELS_CAP).map(cardOf);
const bump = (state) => ({ n: (state.n || 0) + 1 });

// Home randómico: cada vez que la persona entra (evento `open`) se renueva esta semilla, así el orden de las filas (y de las
// tarjetas dentro de cada fila) cambia entre sesiones; dentro de una misma sesión es estable (no salta mientras navega).
let homeSeed = (Math.random() * 2147483647) | 0;
const newHomeSeed = () => { homeSeed = (Math.random() * 2147483647) | 0; };
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffleSeeded(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
// Reordena las filas y, dentro de cada una, sus tarjetas (sub-semilla por fila para que no permuten todas igual).
function randomizeHome(rows, seed) {
  return shuffleSeeded(rows, seed).map((r, i) => (r && Array.isArray(r.items) ? { ...r, items: shuffleSeeded(r.items, (seed + (i + 1) * 0x3c6ef35f) | 0) } : r));
}

const onlyCat = new Map(); // `${tab}:${lang}:${categoría}` -> { rails } (una categoría entera, hasta 60 títulos)

// El sheet del selector de servidor: un ✓ y resalte en el servidor activo.
function serverSheet(servers) {
  const cur = servers.current;
  const rows = (servers.items || []).slice(0, 60).map((s) => {
    const sel = s.i === cur;
    const hasCountry = s.label !== s.host;
    const title = hasCountry ? s.label : s.host; // "MX · México" (país) o el host
    const sub = hasCountry ? (s.https ? s.host : `${s.host} · http`) : (s.https ? "" : "http"); // la URL
    const leading = s.flag
      ? { type: "Image", key: "flag-" + s.i, url: `https://flagcdn.com/w40/${s.flag}.png`, w: 32, h: 24 }
      : { type: "Icon", name: "language" };
    return {
      type: "ListTile", key: "srvrow-" + s.i, title, titleEn: title, selected: sel, leading,
      ...(sub ? { subtitle: sub, subtitleEn: sub } : {}),
      ...(sel ? { trailing: { type: "Icon", name: "check" } } : {}),
      onTap: { event: "srv.pick", arg: String(s.i) },
    };
  });
  const body = rows.length ? rows : [{ type: "Text", key: "srvEmpty", ...twin("liveEmpty", "text") }];
  return { ...twin("setPick", "title"), body };
}

const events = {
  open({ route, state }) {
    if (route && route.name && route.name !== "main") return null;
    newHomeSeed(); // cada entrada reordena el Home, para que no se vea igual que la vez anterior
    return { state: { tab: tabOf(state, route), lang: wantedLang(state), ...bump(state), failed: null } };
  },
  tab({ value, arg, state }) {
    const tab = TAB_IDS.includes(value) ? value : TAB_IDS.includes(arg) ? arg : null;
    if (!tab) return null;
    setStored(TAB_KEY, tab);
    const failed = { ...(state.failed || {}) };
    for (const u of unitsFor(tab, wantedLang(state))) delete failed[u];
    return { state: { tab, ...bump(state), failed } };
  },
  lang({ value, state }) {
    if (!isLang(value)) return null;
    setStored(LANG_KEY, value);
    return { state: { lang: value, cat: null, ...bump(state), failed: null } };
  },
  retry({ state }) {
    const tab = tabOf(state);
    const lang = wantedLang(state);
    for (const u of unitsFor(tab, lang)) {
      const key = memoKey(u);
      if (memo.has(key) && memo.get(key).partial) memo.delete(key);
    }
    return { state: { failed: null, ...bump(state) } };
  },
  async vcat({ value, state }) {
    const tab = tabOf(state);
    if (tab === "live" || tab === "home") return null;
    const id = typeof value === "string" ? value : "";
    if (id === "") return { state: { cat: null, ...bump(state) } };
    const lang = wantedLang(state);
    const key = `${tab}:${lang}:${id}`;
    if (!onlyCat.has(key)) {
      const info = await cat.loadRailsInfo(tab === "movies" ? "vod" : "series", 1, 60, { lang, only: id });
      onlyCat.set(key, { rails: railCards(info.rails.map((r) => ({ ...r, items: r.items.map(cat.withFicha) }))) });
    }
    cacheKey = cat.serverKey();
    return { state: { cat: id, ...bump(state) } };
  },
  async more({ state }) {
    const tab = tabOf(state);
    if (tab === "live" || tab === "home") return null;
    const lang = wantedLang(state);
    const m = memo.get(`${tab}:${lang}`);
    if (!m || !m.hasMore) return null;
    await loadVodTab(tab, lang, { offset: m.next });
    cacheKey = cat.serverKey();
    return { state: { ...bump(state) } };
  },
  async tick({ state, device }) {
    const tab = tabOf(state);
    const unit = pendingUnit(state, tab, device);
    if (!unit) return null;
    const failed = { ...(state.failed || {}) };
    try { await runUnit(unit); } catch (_) { failed[unit] = true; }
    cacheKey = cat.serverKey();
    return { state: { ...bump(state), failed } };
  },
  // Sesión larga: cada 30 min (browseView) vuelve a bajar el feed del Home por si el Action publicó uno nuevo. Nunca falla
  // la vista: si no hay feed nuevo o el servidor cambió, se queda con lo que ya mostraba.
  async hrefresh({ state }) {
    const lang = wantedLang(state);
    if (!homeFeedData.has(lang)) return null;
    let feed = null;
    try { feed = await fetchHomeFeed(cat.serverKey()); } catch (_) { feed = null; }
    if (!feed || !feed.rows.length) return null;
    const key = feed.lang && isLang(feed.lang) ? feed.lang : lang;
    const cur = homeFeedData.get(key);
    if (cur && cur.rows.length === feed.rows.length && JSON.stringify(cur.rows[0]) === JSON.stringify(feed.rows[0])) return null; // igual: sin re-render
    homeFeedData.set(key, { slides: feed.slides || [], rows: feed.rows, langs: feed.langs || [], movies: feed.movies || null, series: feed.series || null });
    if (Array.isArray(feed.langs) && feed.langs.length) homeLangsList = feed.langs;
    writeTabSnap("home", key, feed.slides, feed.rows);
    if (feed.movies) writeTabSnap("movies", key, feed.movies.slides, feed.movies.rows);
    if (feed.series) writeTabSnap("series", key, feed.series.slides, feed.series.rows);
    return { state: { ...bump(state) } };
  },
  openSearch() { return { route: { push: "search" }, state: { sq: "", sstate: null } }; },
  search({ value, route }) {
    const raw = typeof value === "string" ? value : value && typeof value.q === "string" ? value.q : "";
    const q = raw.trim().slice(0, 100);
    if (q === "") return null;
    const state = { sq: q, sstate: "loading" };
    return route && route.name === "search" ? { state } : { route: { push: "search" }, state };
  },
  // Pósters del resto de los resultados: 20 por tick (límite de TMDB de Kino), mientras el usuario mira los primeros.
  async senrich({ state }) {
    if (!found || !found.raw) return null;
    const slice = found.raw.slice(found.enr, found.enr + 20);
    found.enr += 20;
    if (slice.length) await enrichTmdb(slice, { max: 20, budgetMs: 2500 });
    found.items = found.raw.map(cardOf);
    return { state: { senr: (state.senr || 0) + 1 } };
  },
  async stick({ state }) {
    const q = typeof state.sq === "string" ? state.sq : "";
    if (q === "") return null;
    if (found && found.q === q) return { state: { sstate: "done" } };
    try {
      const out = await cat.searchDetailed({ q }, { budgetMs: 14000 });
      const raw = out.items.slice(0, 60);
      found = { q, raw, enr: 20, items: raw.map(cardOf), partial: out.partial }; // los 20 primeros ya pasaron por TMDB; el resto va por tandas (senrich)
      rememberFound(found.items);
      cacheKey = cat.serverKey();
      return { state: { sstate: "done" } };
    } catch (_) {
      return { state: { sstate: "fail" } };
    }
  },
  sretry({ state }) {
    if (typeof state.sq !== "string" || state.sq === "") return null;
    found = null;
    return { state: { sstate: "loading" } };
  },
  back() { return { route: { pop: true }, state: { sq: null, sstate: null } }; },
  async ltick({ state }) {
    const lq = typeof state.lq === "string" ? state.lq : "";
    if (lq !== "") {
      if (!(liveFound && liveFound.q === lq)) {
        let out;
        try { out = await cat.liveSearchDetailed({ query: lq }, { budgetMs: 14000 }); } catch (_) { return { state: { lfail: true } }; }
        liveFound = { q: lq, items: cardsOf(out.items.map(channelCard)), partial: out.partial };
      }
      return { state: { lq } };
    }
    if (!liveCats) {
      try { liveCats = await cat.liveCategories(); } catch (_) { return { state: { lfail: true } }; }
      cacheKey = cat.serverKey();
      return { state: { lcat: typeof state.lcat === "string" ? state.lcat : null } };
    }
    const cur = typeof state.lcat === "string" ? state.lcat : liveCats[0] ? liveCats[0].id : null;
    if (cur === null) return { state: { lcat: null } };
    if (!liveChans.has(cur)) {
      let page;
      try { page = await cat.liveChannels({ categoryId: cur }); } catch (_) { return { state: { lfail: true } }; }
      liveChans.set(cur, cardsOf(page.items.map(channelCard)));
    }
    return { state: { lcat: cur } };
  },
  lsearch({ value }) {
    const raw = typeof value === "string" ? value : value && typeof value.lq === "string" ? value.lq : "";
    const q = raw.trim().slice(0, 100);
    return { state: { lq: q === "" ? null : q } };
  },
  lcat({ value }) { return typeof value === "string" && value !== "" ? { state: { lcat: value, lfail: null } } : null; },
  lretry() { liveFound = null; return { state: { lfail: null } }; },
  go({ arg }) {
    if (arg === "live") return { route: { push: "live" }, state: { lcat: null, lq: null, lfail: null } };
    if (arg === "settings") return { route: { push: "settings" }, state: { srv: null, busy: false } };
    return null;
  },
  async sstatus() { return { state: { srv: await cat.serverStatus() } }; },
  async "srv.check"() { return { state: { srv: await cat.serverStatus(), busy: false } }; },
  async "srv.switch"({ lang }) {
    const r = await cat.switchServer();
    const srv = await cat.serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.changed ? "switched" : "noOther", lang, { host: r.host }), role: r.changed ? "success" : "warning" } };
  },
  async "srv.refresh"({ lang }) {
    const r = await cat.refreshServers();
    const srv = await cat.serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.ok ? "refreshed" : "refreshFail", lang, { n: r.total }), role: r.ok ? "success" : "error" } };
  },
  // Modal (sheet) del selector de servidor, abierto desde el botón del header.
  async openServers() {
    let servers;
    try { servers = await cat.serverList(); } catch (_) { servers = { current: -1, items: [] }; }
    return { state: { servers }, sheet: serverSheet(servers) };
  },
  // Elegido un servidor: fijar, recargar por debajo y re-dibujar el sheet con el ✓ en el elegido (NO cerrar el plugin).
  async "srv.pick"({ arg, state, lang }) {
    const r = await cat.selectServer(arg);
    if (r.ok) { resetCaches(); cacheKey = cat.serverKey(); }
    let servers;
    try { servers = await cat.serverList(); } catch (_) { servers = { current: -1, items: [] }; }
    return { state: { ...bump(state), failed: null, servers }, sheet: serverSheet(servers), toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  // Elegido un servidor en el selector de la primera vez: lo fija, lo recuerda y manda al Home (que ya carga con ese servidor).
  // Si no respondió, se queda en el selector (con el aviso) para elegir otro.
  async "srv.first"({ arg, state, lang }) {
    const r = await cat.selectServer(arg);
    if (r.ok) { resetCaches(); cacheKey = cat.serverKey(); markServerChosen(); }
    return { state: { ...bump(state), failed: null }, toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  saved({ state }) { return { state: bump(state) }; },
};

export async function screenEvent(ev) {
  const e = ev && typeof ev === "object" ? ev : {};
  const handler = Object.hasOwn(events, e.name) ? events[e.name] : null;
  if (!handler) return null;
  try {
    syncServer();
    return (await handler({ ...e, state: e.state || {}, lang: langOf(e) })) ?? null;
  } catch (_) {
    return { toast: { text: say("failed", langOf(e)), role: "error" } };
  }
}

// ---- sección nativa (apiVersion 6) ----------------------------------------------

const SECTION_TABS = [
  { id: "movies", label: "Películas", en: "Movies" },
  { id: "series", label: "Series", en: "Series" },
  { id: "live", label: "En vivo", en: "Live" },
];

function heroOf(rows) {
  for (const row of rows) {
    for (const item of row.items) {
      const text = typeof item.overview === "string" ? item.overview.trim() : "";
      if (item.adult === true || !item.backdrop || !/^https:\/\//.test(item.backdrop) || text === "") continue;
      return { title: item.title, text: text.length <= 300 ? text : `${text.slice(0, 299).trimEnd()}…`, image: item.backdrop };
    }
  }
  return null;
}

export async function section(arg) {
  const asked = arg && typeof arg === "object" ? arg.tab : null;
  const tab = asked || SECTION_TABS[0].id;
  if (!SECTION_TABS.some((t) => t.id === tab)) throw kino.error("not_found", "No se encontró esa pestaña");
  const english = /^en/i.test(String(kino.lang || ""));
  let rows = [];
  if (tab === "live") {
    const cats = (await cat.liveCategories()).slice(0, RAILS_PER_TAB);
    for (let i = 0; i < cats.length; i += 3) {
      const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
        try {
          const page = await cat.liveChannels({ categoryId: c.id });
          const items = page.items.slice(0, RAIL_ITEMS).map(channelCard);
          return items.length ? { id: "lcat-" + c.id, title: c.title, ref: "lcat:" + c.id, items } : null;
        } catch (_) { return null; }
      }));
      rows.push(...batch.filter(Boolean));
    }
  } else {
    const kind = tab === "movies" ? "vod" : "series";
    const info = await cat.loadRailsInfo(kind, RAILS_PER_TAB, RAIL_ITEMS, {});
    await cat.enrichFeatured(kind, info.rails.flatMap((r) => r.items).filter((i) => i.overview).slice(0, FEATURED), FEATURED);
    rows = info.rails.map(({ genre, lang, ...r }) => ({ ...r, items: r.items.map(cat.withFicha) }));
  }
  const hero = heroOf(rows);
  return { tabs: SECTION_TABS.map((t) => ({ id: t.id, label: english ? t.en : t.label })), tab, ...(hero ? { hero } : {}), rows };
}
