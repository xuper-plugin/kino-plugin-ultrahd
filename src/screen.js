// La pantalla propia (apiVersion 14, vía enhancements) y la sección nativa. La vista es pura: lo cargado vive en memoria
// y, si el runtime se reinicia, el temporizador `tick` lo vuelve a traer; el estado solo guarda tab, lang, n y fallos.
// Todo lo que viene del catálogo se descarta si cambia el servidor activo (categorías e ids no coinciden entre servidores).
import * as cat from "./catalog.js";
import { recentEntries, rememberCard } from "./recent.js";
import { say } from "./i18n.js";
import { put } from "./store.js";
import { indexStep } from "./titleIndex.js";
import { LANG_ORDER } from "./names.js";
import { TAB_IDS, browseView, searchView, liveView, settingsView, cardOf, slidesOf } from "./screenView.js";

const PLUGIN_VERSION = "0.3.0";
const TAB_KEY = "browseTab";
const LANG_KEY = "browseLang";
const HIST_KEY = "searchHist:v1";
const HIST_MAX = 24;
const CHANNELS_CAP = 60;
const RAILS_PER_TAB = 8;
const RAIL_ITEMS = 20;
const FEATURED = 6;
const SCREEN_ROUTES = ["main", "search", "live", "settings"];

const memo = new Map();
const liveChans = new Map();
let countryCards = null;
let recentCards = null;
let liveCats = null;
let found = null;
let liveFound = null;
let cacheKey = null;

function resetCaches() {
  memo.clear();
  liveChans.clear();
  countryCards = null;
  recentCards = null;
  liveCats = null;
  found = null;
  liveFound = null;
}

function syncServer() {
  const key = cat.serverKey();
  if (cacheKey === null || cacheKey === "") { cacheKey = key; return; }
  if (key !== cacheKey) { resetCaches(); cacheKey = key; }
}

const langOf = (ev) => (ev && ev.lang === "en" ? "en" : "es");
const getStored = (k) => { try { return kino.storage.get(k) || null; } catch (_) { return null; } };
const setStored = (k, v) => { put(k, v); };
const storedTab = () => { const t = getStored(TAB_KEY); return TAB_IDS.includes(t) ? t : null; };
const wantedLang = (state) => (LANG_ORDER.includes(state.lang) ? state.lang : LANG_ORDER.includes(getStored(LANG_KEY)) ? getStored(LANG_KEY) : LANG_ORDER[0]);

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
async function loadVodTab(tab, lang, { home = false } = {}) {
  const kind = tab === "movies" ? "vod" : "series";
  const maxRails = home ? (tab === "movies" ? 3 : 2) : RAILS_PER_TAB;
  // El índice de títulos se puebla/actualiza mientras carga el Home de la pantalla (un paso acotado en tiempo; nunca lanza).
  const indexing = home ? indexStep({ budgetMs: 6000 }) : null;
  const info = await cat.loadRailsInfo(kind, maxRails, RAIL_ITEMS, { lang, home });
  if (indexing) await indexing;
  const wantFeatured = home && tab === "series" ? 0 : FEATURED;
  const featured = info.rails.flatMap((r) => r.items).filter((i) => i.overview).slice(0, wantFeatured);
  if (featured.length) await cat.enrichFeatured(kind, featured, wantFeatured);
  const rails = info.rails.map((r) => ({ ...r, items: r.items.map(cat.withFicha) }));
  memo.set(`${home ? "home-" : ""}${tab}:${lang}`, { slides: slidesOf(rails), rails: railCards(rails), langs: info.langs, lang: info.lang, partial: info.failed > 0 });
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
  let lookups = 0;
  for (const e of recentEntries(key)) {
    let card = e.card;
    if (!card && lookups < 6) {
      lookups++;
      try {
        const item = await cat.vodInfoItem(e.id);
        card = item ? cardOf(item) : null;
        if (card) rememberCard(key, e.id, card);
      } catch (_) { card = null; }
    }
    if (card && !(card.adult && !cat.showAdult())) out.push(card);
  }
  recentCards = out;
}

const countryOn = () => cat.homeCountry() !== "none";

function unitsFor(tab, lang) {
  if (tab === "home") return [`home:movies:${lang}`, `home:series:${lang}`, ...(countryOn() ? ["country"] : []), "recent"];
  return [tab === "live" ? "tab:live" : `tab:${tab}:${lang}`];
}

function memoKey(unit) {
  const [prefix, tab, lang] = unit.split(":");
  if (tab === "live") return "live";
  return prefix === "home" ? `home-${tab}:${lang}` : `${tab}:${lang}`;
}

function isDone(unit) {
  if (unit === "country") return countryCards !== null;
  if (unit === "recent") return recentCards !== null;
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
  else {
    const [prefix, tab, lang] = unit.split(":");
    if (tab === "live") await loadLiveTab();
    else await loadVodTab(tab, lang, { home: prefix === "home" });
  }
}

function tabData(tab, lang) {
  if (tab === "live") return memo.get("live") || null;
  if (tab !== "home") return memo.get(`${tab}:${lang}`) || null;
  const m = memo.get(`home-movies:${lang}`);
  const s = memo.get(`home-series:${lang}`);
  if (!m && !s) return null;
  const rails = [...(m ? m.rails : []), ...(s ? s.rails : [])];
  const src = m || s;
  return { slides: [...(m ? m.slides : []), ...(s ? s.slides : [])].slice(0, FEATURED), rails, langs: src.langs, lang: src.lang, partial: !!((m && m.partial) || (s && s.partial)) };
}

const tabOf = (state, route) => {
  const a = route && route.args && typeof route.args === "object" ? route.args : {};
  return TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS.includes(a.tab) ? a.tab : storedTab() || TAB_IDS[0];
};

function mainView(ctx) {
  const state = ctx.state || {};
  const tab = tabOf(state, ctx.route);
  const lang = wantedLang(state);
  const data = tabData(tab, lang);
  const failed = unitsFor(tab, lang).some((u) => state.failed && state.failed[u]);
  return browseView({
    tab, data, recent: recentCards || [], country: countryCards || [],
    loading: pendingUnit(state, tab, ctx.device) !== null, failed: !data && failed, device: ctx.device,
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
      return searchView({ query, status, items, partial: !!(found && found.q === query && found.partial), history: query === "" ? readHistory() : [], device: c.device });
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

const events = {
  open({ route, state }) {
    if (route && route.name && route.name !== "main") return null;
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
    if (!LANG_ORDER.includes(value)) return null;
    setStored(LANG_KEY, value);
    return { state: { lang: value, ...bump(state), failed: null } };
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
  async tick({ state, device }) {
    const tab = tabOf(state);
    const unit = pendingUnit(state, tab, device);
    if (!unit) return null;
    const failed = { ...(state.failed || {}) };
    try { await runUnit(unit); } catch (_) { failed[unit] = true; }
    cacheKey = cat.serverKey();
    return { state: { ...bump(state), failed } };
  },
  openSearch() { return { route: { push: "search" }, state: { sq: "", sstate: null } }; },
  search({ value, route }) {
    const q = value && typeof value.q === "string" ? value.q.trim().slice(0, 100) : "";
    if (q === "") return null;
    const state = { sq: q, sstate: "loading" };
    return route && route.name === "search" ? { state } : { route: { push: "search" }, state };
  },
  async stick({ state }) {
    const q = typeof state.sq === "string" ? state.sq : "";
    if (q === "") return null;
    if (found && found.q === q) return { state: { sstate: "done" } };
    try {
      const out = await cat.searchDetailed({ q }, { budgetMs: 14000 });
      found = { q, items: out.items.slice(0, 60).map(cardOf), partial: out.partial };
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
    const q = value && typeof value.lq === "string" ? value.lq.trim().slice(0, 100) : "";
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
