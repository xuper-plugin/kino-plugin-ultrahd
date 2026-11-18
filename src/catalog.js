// Ultra Hd — catálogo (películas, series, en vivo).
// Las credenciales se obtienen automáticamente del servidor bootstrap,
// igual que la app original. El usuario no configura nada.

import { fetchHomeFeed } from "./homeFeed.js";
import { noteRecent } from "./recent.js";
import { put, jsonSize } from "./store.js";
import { indexFitsServer, indexSource, indexCategoryNames, indexSearch, indexStep, indexReady, indexStale, resolveIdxRef, indexLabel, cleanTitle, findKey, parseIdxRef } from "./titleIndex.js";
import { enrichTmdb } from "./tmdbLazy.js";
import { LANG_ORDER, langLabel, displayTitle, titleCase, countryMatch, COUNTRY_PHRASES, cleanCategoryName } from "./names.js";
import { mergeVod, mergeLive, searchOrder, homeOrder } from "./categories.js";
import { normKey } from "./categoryRules.js";
import { say } from "./i18n.js";
import { keyOf, pairHashes, groupPanels, readPanels, writePanels, panelOf, noteDead, noteBlocked, noteAlive, usable, accountVerdict } from "./panels.js";
import { categoryTok, channelTok } from "./channelMatch.js";
import { createLiveFailover, liveRef } from "./liveFailover.js";
import { channelTitles, cleanChannelTitle, categoryKey, normName } from "./channelTitle.js";

export { keyOf };

const BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
const VEGETA_VERSION_CODE = "21"; // versionCode de la app (VegetaTV 11.1): el bootstrap rechaza menos de 21 con 426
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const SRVS_V = 2; // versión de la caché de servidores: subir para invalidar listas viejas (p. ej. sin el país del servidor)

// Ultra HD checks a server with its VOD categories everywhere: the title index and the panels are VOD-based (measured:
// accounts of one panel share VOD category ids and names), and the probe's answer is that server's VOD category cache.
const PROBE = "get_vod_categories";
const PROBE_KIND = "vod";
const SRVCHOSEN_KEY = "srvChosen:v1"; // written by the screen when the person (or the first-run auto-pick) chose a server

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
    // Tras la URL, la línea puede traer un nombre: "http://host/player_api.php?... [Mi Servidor]".
    const name = line.slice(url.length).trim().replace(/^\[|\]$/g, "").trim().slice(0, 40);
    return { url: base, username, password, ...(name ? { name } : {}) };
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
    return /^\d+$/.test(v) && Number(v) >= Number(VEGETA_VERSION_CODE) ? v : VEGETA_VERSION_CODE;
  } catch (_) {
    return VEGETA_VERSION_CODE;
  }
}

const MAX_SERVERS = 30;

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
async function fetchServerList(opts) {
  const t = opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {};
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" }, ...t });
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
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" }, ...t });
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

// Clave corta del servidor activo (keyOf, sin usuario ni contraseña a la vista): separa las cachés de catálogo entre servidores.
export function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  return keyOf(srv);
}

// El servidor de la lista cuya clave es [k] (para resolver una fuente alternativa contra ese servidor).
function serverByKey(k) {
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return null;
  return st.list.find((s) => keyOf(s) === k) || null;
}

function readSrvs() {
  try { return JSON.parse(kino.storage.get("srvs") || "null"); } catch (_) { return null; }
}

function writeSrvs(st) {
  put("srvs", JSON.stringify(st));
}

// Before 0.8.6 a choice was only `pin` (also set by the health check's jump) plus the screen's flag, which the 2 KB "misc"
// storage class could evict. Once: the server active then becomes the person's `chosen` server, and `pin` goes away.
function migrate(st) {
  if (!st || !Array.isArray(st.list) || st.mig === 1) return st;
  let flag = null;
  try { flag = kino.storage.get(SRVCHOSEN_KEY); } catch (_) { flag = null; }
  if (st.chosen === undefined && (st.pin || flag === "1") && st.list[st.idx]) st.chosen = keyOf(st.list[st.idx]);
  delete st.pin;
  st.mig = 1;
  writeSrvs(st);
  return st;
}

// A new list keeps the person's choice: the chosen server (when it is still listed and not dead), else the one active
// before, else home. Without this every 6-hour refresh went back to the index's server and lost the choice.
function carryOver(prev, st) {
  if (!prev) { st.idx = homeIdx(st); return st; }
  const keys = st.list.map(keyOf);
  const at = (k) => (k ? keys.indexOf(k) : -1);
  if (prev.chosen) st.chosen = prev.chosen;
  if (prev.mig) st.mig = prev.mig;
  const c = at(prev.chosen);
  const a = at(keyOf(prev.list[prev.idx]));
  st.idx = c >= 0 && usable(st.list[c]) ? c : a >= 0 ? a : homeIdx(st);
  if (st.idx === a) { st.ok = !!prev.ok; st.okAt = prev.okAt; st.homeAt = prev.homeAt; }
  return st;
}

// Estado en storage: { ts, list, idx (servidor activo), ok (idx ya comprobado), chosen (clave del elegido por la persona) }.
async function loadServers(force, opts) {
  const cached = migrate(readSrvs());
  const usableList = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usableList && cached.ts && cached.v === SRVS_V && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList(opts);
    const st = carryOver(usableList ? cached : null, { ts: Date.now(), list, idx: 0, ok: false, v: SRVS_V });
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usableList) return cached; // bootstrap caído: seguimos con la lista vieja
    throw e;
  }
}

/** The person (or the first-run auto-pick) chose a server: a key in `srvs`, never evicted. */
export function hasChosenServer() {
  const st = migrate(readSrvs());
  return !!(st && st.chosen);
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

const hostnameOf = (srv) => { try { return new URL(srv.url).hostname; } catch (_) { return ""; } };

// When each account last answered well in this runtime (key -> ms): the screen loads from the active server without a
// health check first while it answered lately (activeConfirmed).
const aliveAt = new Map();

// One Xtream call. Remembers the account: dead (auth 0 / expired) for a day, blocked (Kino refuses this server's own host)
// until the next version. A refusal of ANOTHER host (an ISP block that redirects to a government page over http) is a plain
// failure: it depends on the network, not on the account. opts.timeoutMs: the health check and the failover keep it short.
// [action] null: the account's login answer (player_api.php with no action: user_info and server_info, a few hundred
// bytes), the cheap liveness probe.
async function callServer(srv, action, extra, opts) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, ...(action ? { action } : {}), ...extra });
  let r;
  try {
    r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
      },
      ...(opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (e) {
    if (e && e.code === "host_not_allowed" && e.host && e.host === hostnameOf(srv)) noteBlocked(srv);
    throw e;
  }
  if (!r.ok) throw new Error("API " + r.status);
  let data;
  try { data = r.json(); } catch (_) { throw new Error("respuesta inválida"); }
  if (accountVerdict(data) === "dead") {
    noteDead(srv);
    throw Object.assign(new Error("cuenta no válida"), { dead: true });
  }
  if (action ? badAnswer(action, data) : !(data && typeof data === "object" && !Array.isArray(data) && data.user_info)) throw new Error("respuesta inválida");
  noteAlive(srv);
  aliveAt.set(keyOf(srv), Date.now());
  return data;
}

// The VOD categories a probe just brought, kept as that server's category cache (no second request when it becomes active).
function rememberProbeCats(srv, data) {
  const k = keyOf(srv);
  if (!k || !Array.isArray(data) || !data.length) return;
  const list = data.map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  if (serverKey() === k) catMemo[PROBE_KIND] = { key: k, ts: Date.now(), list };
  putCats(PROBE_KIND, k, list);
}

// [list] kept as server [k]'s categories of [kind]. The same list stored less than CATS_REWRITE_MS ago is not written again
// (each write rewrites the whole store): a check or a probe brings the same list many times a day.
const CATS_REWRITE_MS = 60 * 60 * 1000;
function putCats(kind, k, list) {
  const l = list.map((c) => [c.category_id, c.category_name]);
  try {
    const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + k) || "null");
    if (o && Array.isArray(o.l) && Date.now() - o.ts < CATS_REWRITE_MS && JSON.stringify(o.l) === JSON.stringify(l)) return;
  } catch (_) { /* written below */ }
  put("cats:" + kind + ":" + k, JSON.stringify({ ts: Date.now(), l }));
}

// El servidor "de casa" es el que generó el índice de títulos (sus ids y categorías son los del índice); si no se sabe, el primero.
// Only the start of a fresh list and backHome without a choice use it: the index's fallback (indexHomeIdx) never pulls anyone.
function homeIdx(st) {
  const i = st.list.findIndex((s) => indexFitsServer(s.url));
  return i >= 0 ? i : 0;
}

// Where backHome returns: the person's chosen server, else home.
function backTarget(st) {
  if (st.chosen) {
    const i = st.list.findIndex((s) => keyOf(s) === st.chosen);
    if (i >= 0) return i;
  }
  return homeIdx(st);
}

// Tras un fallo (o el salto del chequeo de salud) se pasó a otro servidor: se vuelve al elegido por la persona (o al de casa)
// en cuanto responde. Se mira cada 5 min; nunca a uno muerto o bloqueado (cero peticiones). Not skipped when the last check
// saw it down: that check is good for 6 h, and the person's server comes back as soon as it answers. One at a time: the
// api() calls a call runs together (a pool of rails) share it, so a call sends one probe at most (each used to send its
// own), with a short timeout.
const BACK_HOME_TIMEOUT_MS = 4000;
let backHomeRun = null;
function backHome() {
  if (!backHomeRun) backHomeRun = goBackHome().finally(() => { backHomeRun = null; });
  return backHomeRun;
}
async function goBackHome() {
  const st = await loadServers(false);
  const target = backTarget(st);
  if (st.idx === target || Date.now() - (st.homeAt || 0) < 300000 || !usable(st.list[target])) return;
  st.homeAt = Date.now();
  try {
    const data = await callServer(st.list[target], PROBE, {}, { timeoutMs: BACK_HOME_TIMEOUT_MS });
    st.idx = target; st.ok = true; st.okAt = Date.now();
    rememberProbeCats(st.list[target], data);
  } catch (_) { /* sigue en el actual */ }
  writeSrvs(st);
}

// The failover walk: the active server, then the other accounts of its panel (same ids, same lists), then the rest in
// list order. Dead and blocked accounts cost no request.
function walkOrder(st) {
  const n = st.list.length;
  const map = readPanels();
  const p = panelOf(keyOf(st.list[st.idx]), map);
  const ring = Array.from({ length: n }, (_, j) => (st.idx + j) % n);
  const same = p ? ring.filter((i) => i !== st.idx && panelOf(keyOf(st.list[i]), map) === p) : [];
  return [st.idx, ...same, ...ring.filter((i) => i !== st.idx && !same.includes(i))].filter((i) => usable(st.list[i]));
}

// opts.until: a deadline (ms since the epoch) for a caller that must answer by then (Kino's Home row): each request gets the
// time left as its timeout, the walk stops when less than a second is left, and there is no backHome probe nor a second
// pass with a fresh server list.
const OK_WRITE_MS = 10 * 60 * 1000;
async function api(action, extra = {}, opts = {}) {
  const until = opts.until || 0;
  let last = "";
  for (let pass = 0; pass < (until ? 1 : 2); pass++) {
    const st = await loadServers(pass === 1);
    if (pass === 0 && !until) await backHome();
    const st2 = readSrvs();
    if (st2 && pass === 0) { st.idx = st2.idx; st.ok = st2.ok; st.okAt = st2.okAt; st.homeAt = st2.homeAt; }
    for (const i of walkOrder(st)) {
      const left = until ? until - Date.now() : 0;
      if (until && left < 1000) break;
      try {
        const data = await callServer(st.list[i], action, extra, until ? { timeoutMs: left } : undefined);
        // srvs is rewritten (with the whole store) only when the active server changes, or to refresh okAt every 10 min;
        // when it last answered is kept in memory meanwhile (aliveAt, read by serverStatus).
        if (i !== st.idx || !st.ok || Date.now() - (st.okAt || 0) > OK_WRITE_MS) {
          st.idx = i;
          st.ok = true;
          st.okAt = Date.now();
          writeSrvs(st);
        }
        return data;
      } catch (e) {
        if (e && e.code === "rate_limited") throw e;
        last = String((e && e.message) || e).slice(0, 80);
        lastErr = last;
      }
    }
  }
  throw kino.error("unavailable", "ningún servidor respondió (" + action + "): " + last, { userMessage: "Error al contactar el servidor." });
}

async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api(PROBE);
    st = readSrvs();
  }
  return st.list[st.idx];
}

// ---- estado y cambio de servidor (ajustes) ---------------------------------------

let lastErr = "";
const errText = (e) => String((e && (e.message || e.code)) || e).slice(0, 90);
// Kino solo carga imágenes por HTTPS: un logo http se pide por https (si ese host no lo sirve, sale sin imagen como antes).
const img = (u) => {
  const s = typeof u === "string" ? u.trim() : "";
  if (!s) return undefined;
  return /^http:\/\//i.test(s) ? "https://" + s.slice(7).replace(/^([^/:]+):80(?=\/|$)/, "$1") : s;
};
const hostOf = (srv) => {
  try { return new URL(srv.url).host; } catch (_) { return ""; }
};
const labelOf = (srv) => (srv && srv.name ? srv.name : hostOf(srv));

// En Android TV no se dibujan los emojis de bandera: decodifica la bandera a nombre de país (texto) para que se lea igual.
const FLAG_NAMES = { AR: "Argentina", BO: "Bolivia", BR: "Brasil", CA: "Canadá", CL: "Chile", CO: "Colombia", CR: "Costa Rica", CU: "Cuba", DE: "Alemania", DO: "Rep. Dominicana", EC: "Ecuador", ES: "España", FR: "Francia", GB: "Reino Unido", GT: "Guatemala", HN: "Honduras", IT: "Italia", MX: "México", NI: "Nicaragua", PA: "Panamá", PE: "Perú", PR: "Puerto Rico", PT: "Portugal", PY: "Paraguay", SV: "El Salvador", US: "EE. UU.", UY: "Uruguay", VE: "Venezuela" };
// { code (ISO2 minúsculas, para la imagen de bandera), name } o null. 🌐 => Global sin código.
function flagInfo(s) {
  const cp = [...String(s || "")];
  if (cp.length >= 2) {
    const a = cp[0].codePointAt(0), b = cp[1].codePointAt(0);
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code = String.fromCharCode(a - 0x1f1e6 + 65) + String.fromCharCode(b - 0x1f1e6 + 65);
      return { code: code.toLowerCase(), name: FLAG_NAMES[code] || code };
    }
  }
  return String(s || "").includes("🌐") ? { code: "", name: "Global" } : null;
}
// Etiqueta legible en todas partes: la bandera (si la hay) + el nombre del país; en un TV solo se ve el nombre.
const niceLabel = (srv) => { const fi = flagInfo(labelOf(srv)); return fi ? (fi.code ? `${fi.code.toUpperCase()} · ${fi.name}` : fi.name) : labelOf(srv); };

// Nunca expone usuario ni contraseña: solo el host y la posición en la lista.
// When the active server of [st] last answered: stored okAt, or later in this runtime (api() writes okAt every 10 min only).
const okAtOf = (st) => Math.max(Number(st && st.okAt) || 0, (st && st.list && aliveAt.get(keyOf(st.list[st.idx]))) || 0);

export async function serverStatus() {
  const cached = readSrvs();
  // Si ya hubo una respuesta buena de este servidor, se informa sin otra petición (el servicio puede tardar y el estado caducaba).
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - okAtOf(cached) < 20000) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: okAtOf(cached) };
  try {
    await api(PROBE);
    const st = readSrvs();
    return { ok: true, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: st.list.length, at: okAtOf(st) };
  } catch (e) {
    lastErr = errText(e);
    const st = readSrvs();
    return { ok: false, host: st && st.list[st.idx] ? hostOf(st.list[st.idx]) : "", index: st ? st.idx + 1 : 0, total: st ? st.list.length : 0 };
  }
}

export async function switchServer() {
  const st = await loadServers(false);
  const n = st.list.length;
  const https = st.list.filter((s) => String(s.url).startsWith("https://")).length;
  for (let k = 1; k < n; k++) {
    const i = (st.idx + k) % n;
    if (!usable(st.list[i])) continue;
    try {
      const data = await callServer(st.list[i], PROBE, {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.chosen = keyOf(st.list[i]); // elegido a mano: es adonde se vuelve
      writeSrvs(st);
      rememberProbeCats(st.list[i], data);
      return { changed: true, host: hostOf(st.list[i]), index: i + 1, total: n };
    } catch (e) { lastErr = errText(e); }
  }
  return { changed: false, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: n, https };
}

// La lista completa para el selector de Ajustes/header: solo nombre/host y posición (nunca usuario ni contraseña).
export async function serverList() {
  const st = await loadServers(false);
  return {
    current: st.idx,
    items: itemsWithHealth(st),
  };
}

// Público hispanohablante: España, México y "Latino" primero, luego el resto de Latinoamérica, luego Global, luego otros países.
const LATAM = new Set(["ar", "bo", "cl", "co", "cr", "cu", "do", "ec", "gt", "hn", "ni", "pa", "pe", "pr", "py", "sv", "uy", "ve"]);
function srvPriority(x) {
  const code = (x.flag || "").toLowerCase();
  if (code === "es" || code === "mx" || /latino|latam/.test(String(x.label || "").toLowerCase())) return 0;
  if (LATAM.has(code)) return 1;
  if (!code) return 2; // Global / sin país
  return 3;
}
const flagOf = (srv) => { const fi = flagInfo(labelOf(srv)); return fi ? fi.code : ""; };
const priorityOf = (srv) => srvPriority({ flag: flagOf(srv), label: niceLabel(srv) });

// Items del selector con bandera y estado online; con un chequeo fresco, solo los que responden. Hispanohablantes primero.
// Dead (auth 0) and blocked accounts are never offered: the first-run auto-pick and the picker skip them.
function itemsWithHealth(st) {
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  let items = (st.list || []).map((s, i) => ({ s, i })).filter(({ s }) => usable(s)).map(({ s, i }) => {
    const fi = flagInfo(labelOf(s));
    const flag = fi ? fi.code : "";
    const label = niceLabel(s);
    // es = servidor hispanohablante (ES/MX/Latino o país de LATAM): para preferirlo al elegir automáticamente.
    return { i, label, host: hostOf(s), https: String(s.url).startsWith("https://"), flag, es: srvPriority({ flag, label }) <= 1, online: online ? online.has(s.url) : true };
  });
  if (online && online.size > 0) items = items.filter((x) => x.online);
  items.sort((a, b) => srvPriority(a) - srvPriority(b) || a.i - b.i); // estable por índice
  return items;
}

// Fija un servidor elegido a mano: es adonde se vuelve tras un fallo. Lo prueba antes con una petición ligera.
// Prueba el elegido; si no responde, otros del mismo país (misma bandera) hasta dar con uno vivo (muchos están caídos). Tope de intentos.
export async function selectServer(i) {
  const st = await loadServers(false);
  const n = st.list.length;
  const start = parseInt(i, 10);
  if (!(start >= 0 && start < n)) return { ok: false };
  const wantLabel = labelOf(st.list[start]);
  const all = Array.from({ length: n }, (_, k) => k);
  // The tapped one is always tried once; its same-country fallbacks skip dead and blocked accounts.
  const order = [start, ...all.filter((k) => k !== start && labelOf(st.list[k]) === wantLabel && usable(st.list[k]))].slice(0, 5);
  for (const idx of order) {
    try {
      const data = await callServer(st.list[idx], PROBE, {});
      st.idx = idx; st.ok = true; st.okAt = Date.now(); st.chosen = keyOf(st.list[idx]);
      writeSrvs(st);
      rememberProbeCats(st.list[idx], data);
      return { ok: true, host: hostOf(st.list[idx]), label: labelOf(st.list[idx]), index: idx + 1, total: n, exact: idx === start };
    } catch (e) { lastErr = errText(e); }
  }
  return { ok: false, host: hostOf(st.list[start]), label: labelOf(st.list[start]), index: start + 1, total: n };
}

// ---- first run: the server picked by a race -------------------------------------------------------------------------
// A rolling race: RACE_PARALLEL probes in flight, at most one per host, and a failed one is replaced at once by the next
// account in the order, until one answers well or the race's deadline.
const RACE_PARALLEL = 3;
// Measured on a Redmi (2026-11-17): working accounts answered the probe in 0.5-0.8 s and dead ones in 0.8-1.0 s, while one
// silent host held the first tick (Kino holds a call until every request it started settles) up to this timeout after the
// winner had answered. 2.5 s keeps three times the slowest good answer.
const RACE_TIMEOUT_MS = 2500;
// The race's deadline, from its start. Every probe's timeout is clipped to it, so no request of the race outlives it (Kino
// holds a call until every request it started settles). Why 9 s: the first run's tick has 16 s of Kino's 20 s screen call;
// the bootstrap takes 1-2.5 s and the feed that follows the pick in the same tick keeps RACE_RESERVE_MS, so 2.5 + 9 + 4 =
// 15.5 s. 9 s is three full waves of 3 hanging accounts (3 x 2.5 s) plus a margin: more than the published one-by-one
// pick's 6 tries even when every one hangs, and many more when they fail fast (a dead account answers auth 0 in about 1 s).
const RACE_WINDOW_MS = 9000;
// The race leaves this much of the caller's deadline to the feed that follows it in the same call.
const RACE_RESERVE_MS = 4000;
// No probe starts with less than this left before the race's deadline (a good account answers in about 1-2 s).
const RACE_MIN_MS = 1500;
// Kino allows 60 requests per call: the race (20) with the bootstrap (4), a health check chained after it (MAX_SERVERS),
// the index's names (1) and the feed (4) stays under it.
const RACE_MAX_PROBES = 20;
// How long the answers of a health check stay good for the first run's automatic pick (the same tick, or the next one).
const PICK_ANSWERS_MS = 2 * 60 * 1000;
// Kino's answers that mean no answer from the host at all (its other accounts are skipped for the rest of that race), and
// those that mean no more requests in this call.
const HOST_SILENT = new Set(["timeout", "network", "host_not_allowed"]);
const CALL_SPENT = new Set(["rate_limited", "invalid_request"]);

// The picker's order spread over hosts (one account per host first, then the rest in order): one host down cannot sink a
// whole race.
function spreadHosts(items) {
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const x of items) {
    if (seen.has(x.host)) rest.push(x);
    else { seen.add(x.host); first.push(x); }
  }
  return [...first, ...rest];
}

// The first run's pick: [it] (an item of itemsWithHealth) becomes the active and chosen server, with the categories its probe
// brought. Never throws (storage refused: the pick still answers).
function takePick(st, it, data) {
  const srv = st.list[it.i];
  try {
    st.idx = it.i; st.ok = true; st.okAt = Date.now(); st.chosen = keyOf(srv);
    writeSrvs(st);
    rememberProbeCats(srv, data);
  } catch (_) { /* storage refused */ }
  return { ok: true, host: hostOf(srv), label: labelOf(srv), index: it.i + 1, total: st.list.length };
}

// A server already chosen (by the person, or an earlier pick): kept as it is, no request.
function keptPick(st) {
  const srv = st.list[st.idx];
  return { ok: true, kept: true, host: hostOf(srv), label: labelOf(srv), index: st.idx + 1, total: st.list.length };
}

/**
 * The first run's pick, without a health check first. The candidates are the picker's order (Spanish first; dead and
 * blocked accounts, and after a fresh check the offline ones, are never in it), spread over hosts within each language
 * group. Up to RACE_PARALLEL probes run at once, at most one per host, each with a 4 s timeout clipped to the race's
 * deadline (RACE_WINDOW_MS from its start, keeping RACE_RESERVE_MS of opts.until for the feed); as soon as one fails the next
 * candidate starts. A host that gave no answer at all is skipped for the rest of the race.
 * The first good answer wins, except that an account in another language never wins while a Spanish one is in flight or
 * can still start (Spanish accounts on fewer hosts than RACE_PARALLEL leave a free slot to the next language): those race on,
 * each within its timeout and the race's deadline. A dead account cannot win: its answer throws in callServer, which remembers it
 * dead for a day, exactly as everywhere else. Once the race is over a late answer only records what it learned; it never
 * moves the pick. A chosen server is never raced: it is kept, with no request. Never throws.
 * `{ ok: true, host, label, index, total }`, `{ ok: false }`, or `{ ok: false, late: true }` when opts.until left no time
 * to race (nothing was sent).
 */
export async function raceFirstServer(opts = {}) {
  const until = opts.until || Date.now() + HEALTH_DEADLINE_MS;
  let st;
  try { st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS }); } catch (e) { lastErr = errText(e); return { ok: false }; }
  if (st.chosen) return keptPick(st);
  const end = Math.min(Date.now() + RACE_WINDOW_MS, until - RACE_RESERVE_MS);
  if (end - Date.now() < RACE_MIN_MS) return { ok: false, late: true };
  const items = itemsWithHealth(st);
  const queue = [...spreadHosts(items.filter((x) => x.es)), ...spreadHosts(items.filter((x) => !x.es))];
  if (!queue.length) return { ok: false };
  const hostname = (it) => hostnameOf(st.list[it.i]) || it.host;
  return new Promise((done) => {
    const flying = new Map(); // hostname -> the candidate whose probe is in flight there (one per host)
    const silent = new Set(); // hosts that gave no answer at all in this race
    let sent = 0;
    let best = null; // the best good answer so far: { it, data }
    let over = false;
    let spent = false; // Kino refused more requests in this call
    const finish = (out) => { over = true; done(out); };
    const esFlying = () => [...flying.values()].some((x) => x.es);
    const step = () => {
      if (over) return;
      if (best && best.it.es) return finish(takePick(st, best.it, best.data));
      // Once only an account in another language answered well, just the Spanish accounts left still start (a free slot takes
      // one in another language only while every Spanish one left waits for its host): it wins when none of them is in flight
      // any more, or the race's time or requests ran out.
      while (!spent && flying.size < RACE_PARALLEL && sent < RACE_MAX_PROBES && end - Date.now() >= RACE_MIN_MS) {
        const k = queue.findIndex((x) => (!best || x.es) && !flying.has(hostname(x)) && !silent.has(hostname(x)));
        if (k < 0) break;
        start(queue.splice(k, 1)[0]);
      }
      if (best && !esFlying()) return finish(takePick(st, best.it, best.data));
      if (!flying.size) finish({ ok: false });
    };
    const start = (it) => {
      const h = hostname(it);
      flying.set(h, it);
      sent++;
      // After the race a late answer only records (in callServer) the account alive or dead.
      callServer(st.list[it.i], PROBE, {}, { timeoutMs: Math.min(RACE_TIMEOUT_MS, end - Date.now()) }).then((data) => {
        flying.delete(h);
        if (over) return;
        if (!best || (it.es && !best.it.es)) best = { it, data };
        step();
      }, (e) => {
        flying.delete(h);
        if (over) return;
        lastErr = errText(e);
        const code = e && e.code;
        if (CALL_SPENT.has(code)) spent = true;
        else if (HOST_SILENT.has(code)) silent.add(h);
        step();
      });
    };
    step();
  });
}

// The answers of the last health check of this runtime, kept only while no server is chosen (the first run's automatic pick
// reads them): { at, answers: Map(key -> VOD categories) }.
let pickAnswers = null;

/**
 * The first run's automatic pick when the race found no account (a slow network, or every account it reached was dead or
 * silent): the best account of the picker's order (Spanish first) that answered the health check just run in this
 * runtime, with no new request (its answer is seconds old, and it may have taken longer than the race's 4 s). Without that
 * check's answers (the check is from before this runtime), a race over the check's online list. A chosen server is never
 * changed. Never throws. As raceFirstServer.
 */
export async function autoPickServer(opts = {}) {
  const memo = pickAnswers && Date.now() - pickAnswers.at < PICK_ANSWERS_MS ? pickAnswers : null;
  pickAnswers = null;
  // The check just ran and nothing answered it (or it could not even get the list): nothing to pick, and no request.
  if (memo && !memo.answers.size) return { ok: false };
  let st;
  try { st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS }); } catch (e) { lastErr = errText(e); return { ok: false }; }
  if (st.chosen) return keptPick(st);
  if (memo) {
    const it = itemsWithHealth(st).find((x) => memo.answers.has(keyOf(st.list[x.i])));
    return it ? takePick(st, it, memo.answers.get(keyOf(st.list[it.i]))) : { ok: false };
  }
  return raceFirstServer(opts);
}

/** The server list is cached and fresh: the picker's list needs no request. */
export function serverListFresh() {
  const st = readSrvs();
  return !!(st && Array.isArray(st.list) && st.list.length && st.ts && st.v === SRVS_V && Date.now() - st.ts < CACHE_TTL_MS);
}

// ---- chequeo de salud: para que el selector muestre solo los servidores que responden ----------------
const HEALTH_KEY = "health:v1";
// Which accounts answer is checked again after this. It was 30 min: up to 30 full category lists on the screen's path every
// half hour (and on every En vivo visit), for a list of online accounts that changes over hours.
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 10000;
// The check runs inside one screen call (Kino gives it 20 s, ScreenLimits.CALL_TIMEOUT_MS): it stops starting probes at
// this deadline and writes what answered. Kino runs 6 of a plugin's requests at once, so a probe started here starts there
// and its timeout is the time it really has.
const HEALTH_DEADLINE_MS = 15000;
const HEALTH_PARALLEL = 6;
const LIST_TIMEOUT_MS = 4000;
const PANELS_STALE_MS = 20 * 60 * 60 * 1000; // the screen refreshes the panel map once a day (the live failover trusts 24 h)
let healthRunning = false;

function readHealth() {
  try { const o = JSON.parse(kino.storage.get(HEALTH_KEY) || "null"); return o && Array.isArray(o.online) && typeof o.ts === "number" ? o : null; } catch (_) { return null; }
}
// A check that nothing answered (no network) is good for 30 min only: an empty online list would hide every other server's
// sources in the player for the whole HEALTH_TTL_MS.
const HEALTH_EMPTY_TTL_MS = 30 * 60 * 1000;
const healthFresh = () => { const h = readHealth(); return h && Date.now() - h.ts < (h.online.length ? HEALTH_TTL_MS : HEALTH_EMPTY_TTL_MS) ? h : null; };
export const healthReady = () => !!healthFresh();
// A full check that no account answered (no network, every panel unreachable) leaves the panel map as it was: written, it
// would count as fresh for PANELS_STALE_MS with no account confirmed, and the live failover only moves a channel to accounts
// its map confirmed within 24 h (the full check runs once a day now, so no later check would fix it that day). The screen
// tries again after PANELS_RETRY_MS (kept in memory: a new runtime tries at once).
const PANELS_RETRY_MS = 30 * 60 * 1000;
let panelsRetryAt = 0;
/** The panel map is missing or older than 20 h: the screen runs one more health check after painting from the feed. */
export const panelsStale = () => {
  if (Date.now() < panelsRetryAt) return false;
  const m = readPanels();
  return !m || Date.now() - (Number(m.at) || 0) > PANELS_STALE_MS;
};
// The active server answered something (a probe, a listing) this long ago at most: the screen loads from it without a check.
const ACTIVE_FRESH_MS = 5 * 60 * 1000;
/** The active server answered lately in this runtime, or the fresh check found it online (else it would have moved). */
export function activeConfirmed() {
  const k = serverKey();
  if (!k) return false;
  const at = aliveAt.get(k);
  return (typeof at === "number" && Date.now() - at < ACTIVE_FRESH_MS) || healthReady();
}

// ---- the title index's server --------------------------------------------------------------------------------------
// The index's category ids and stream ids are those of the panel it was generated from. Its own server is "home" (as before);
// when it is dead or not answering, another account of the SAME panel can resolve index results just as fast. The health
// check finds those accounts from the VOD categories it already downloads: the ones that carry the index's categories under
// the same ids and names (fit, as mergeVod compares them). Measured: nexotvplus.com 72/72 while capitanhero.com is dead.
// Stored in panels:v1 as `ix: { src, fits: [keys], home: key }`. Never a place to return to (backHome, a fresh list): only
// where index results are looked up.
const FIT_MIN = 0.8;
const INDEX_NAMES_TIMEOUT_MS = 4000;

// A server's category [name] is the index's category entry [e] ([title, lang]), as mergeVod compares them.
const sameIndexName = (name, e) => !!name && Array.isArray(e) && normKey(cleanCategoryName(name).title) === normKey(e[0]);

// [until]: the health check's deadline; the index's names are not waited for past it (the last check's result stays).
async function indexFitsFrom(answers, list, prevIx, until) {
  const src = indexSource();
  if (!src) return null;
  const left = until - Date.now();
  const names = left >= 1000 ? await indexCategoryNames({ timeoutMs: Math.min(INDEX_NAMES_TIMEOUT_MS, left), cacheMiss: false }).catch(() => null) : null;
  const entries = Object.entries((names && names.vod) || {});
  if (!entries.length) return prevIx && prevIx.src === src ? prevIx : null; // not known now: keep what the last check found
  const idxKey = keyOf(list.find((s) => indexFitsServer(s.url)));
  const scored = [];
  list.forEach((s, i) => {
    const data = answers.get(keyOf(s));
    if (!Array.isArray(data)) return;
    const byId = new Map(data.map((c) => [String(c.category_id || ""), String(c.category_name || "")]));
    let n = 0;
    for (const [id, e] of entries) if (sameIndexName(byId.get(id), e)) n++;
    if (n / entries.length >= FIT_MIN) scored.push({ k: keyOf(s), fit: n / entries.length, full: n === entries.length, i });
  });
  const seed = installSeed();
  const tie = (k) => { let h = 0x811c9dc5; const t = seed + k; for (let j = 0; j < t.length; j++) { h ^= t.charCodeAt(j); h = Math.imul(h, 16777619); } return h >>> 0; };
  const others = scored.filter((x) => x.k !== idxKey).sort((a, b) => b.fit - a.fit || tie(a.k) - tie(b.k));
  return { src, fits: scored.map((x) => x.k), full: scored.filter((x) => x.full).map((x) => x.k), ...(others.length ? { home: others[0].k } : {}) };
}

const ixOf = (map) => (map && map.ix && map.ix.src && map.ix.src === indexSource() ? map.ix : null);

// Whether [srv]'s VOD ids are the index's: the index's own server, or an account the health check found carrying at least
// FIT_MIN of the index's categories (an account of its panel; its bouquet can still lack some: see carriesIndexCats).
function fitsIndex(srv, map) {
  if (!srv) return false;
  if (indexFitsServer(srv.url)) return true;
  const ix = ixOf(map);
  return !!ix && Array.isArray(ix.fits) && ix.fits.includes(keyOf(srv));
}
// ...with every one of the index's categories (fit 1).
function fullyFitsIndex(srv, map) {
  const ix = ixOf(map);
  return !!srv && !!ix && Array.isArray(ix.full) && ix.full.includes(keyOf(srv));
}

// [srv]'s cached category list of [kind] (memory or storage, any age), or null: no request.
function storedCats(kind, srv) {
  const k = keyOf(srv);
  const m = catMemo[kind];
  if (k && m && m.key === k && Array.isArray(m.list)) return m.list;
  try {
    const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + k) || "null");
    return o && Array.isArray(o.l) ? o.l.map(([category_id, category_name]) => ({ category_id: String(category_id), category_name: String(category_name) })) : null;
  } catch (_) { return null; }
}

// Whether [srv] carries the index title [p]'s own categories: each of its index category ids is in [srv]'s cached categories
// under the index's name. null when it cannot tell (no cached categories, no index names, a ref without categories).
async function carriesIndexCats(srv, p) {
  if (!p || !p.cats.length) return null;
  const kind = p.kind === "movies" ? "vod" : "series";
  const names = await indexCategoryNames({ timeoutMs: INDEX_NAMES_TIMEOUT_MS }).catch(() => null);
  const idx = (names && names[kind]) || {};
  const cats = storedCats(kind, srv);
  const ids = p.cats.map(String).filter((id) => idx[id]);
  if (!cats || !ids.length) return null;
  const byId = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
  return ids.every((id) => sameIndexName(byId.get(id), idx[id]));
}

// Where index results are looked up: the index's server while it answers, else the account of its panel found by the health
// check, else the index's server when it is not known dead or blocked, else none (-1: the active server resolves by title).
function indexHomeIdx(st, map) {
  const i = st.list.findIndex((s) => indexFitsServer(s.url));
  if (!indexSource()) return i; // an index without its server's tag: as before
  const h = healthFresh();
  const up = (s) => usable(s) && (!h || h.online.includes(s.url));
  if (i >= 0 && up(st.list[i])) return i;
  const ix = ixOf(map);
  if (ix && ix.home) {
    const j = st.list.findIndex((s) => keyOf(s) === ix.home);
    if (j >= 0 && up(st.list[j])) return j;
  }
  return i >= 0 && usable(st.list[i]) ? i : -1;
}

// Probes the servers 6 at a time (never a dead or blocked account: zero requests), the active and the chosen one first, within
// HEALTH_DEADLINE_MS, and stores the URLs of those that answer; a server the deadline left unprobed is stored with them (not
// known down: the picker keeps offering it), never as down. With the same answers it groups the servers into panels and finds
// the accounts of the index's panel (0 extra requests to the servers). When the active server is down it jumps to one that
// answered: same panel, then same country, then by priority. The jump never touches `chosen` (backHome returns there). One
// run at a time; never throws (without even a list, it stores an empty check so the "Verificando" screen cannot hang).
// opts.until: an earlier deadline (ms since the epoch), for the first run's tick that picks a server and loads its feed after
// the check. While no server is chosen, the answers stay in memory for that pick (autoPickServer).
// The first run's rescue (one call); the screen's other checks run in short steps (healthStep).
export async function healthCheck(opts = {}) {
  if (healthRunning) return 0;
  healthRunning = true;
  const until = Math.min(Date.now() + HEALTH_DEADLINE_MS, opts.until || Infinity);
  try {
    const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
    const list = st.list || [];
    const sets = new Map();
    const answers = new Map();
    const answered = new Set();
    const unprobed = new Set();
    await pool(checkOrder(st), HEALTH_PARALLEL, async (s) => {
      if (!usable(s)) return;
      const left = until - Date.now();
      if (left < 1500) { unprobed.add(s.url); return; }
      try {
        const data = await callServer(s, PROBE, {}, { timeoutMs: Math.min(HEALTH_TIMEOUT_MS, left - 500) });
        sets.set(keyOf(s), pairHashes(data));
        answers.set(keyOf(s), data);
        answered.add(s.url);
      } catch (_) { /* down */ }
    });
    pickAnswers = st.chosen ? null : { at: Date.now(), answers };
    return await afterCheck(st, list, { sets, answers, answered, unprobed, until });
  } catch (_) {
    try { put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online: [] })); } catch (__) { /* nada */ }
    const prev = readSrvs();
    pickAnswers = prev && prev.chosen ? null : { at: Date.now(), answers: new Map() };
    return 0;
  } finally { healthRunning = false; }
}

// The order a check probes in: the active and the chosen server first, then the list's order.
function checkOrder(st) {
  const list = st.list || [];
  const first = new Set([keyOf(list[st.idx]), st.chosen].filter(Boolean));
  return [...list.filter((s) => first.has(keyOf(s))), ...list.filter((s) => !first.has(keyOf(s)))];
}

// What a check stores once its probes are over: the online list, and with category answers (`sets`, a full check) the panel
// map and the index's accounts; then the jump off a dead active server. Returns how many answered.
async function afterCheck(st, list, { sets, answers, answered, unprobed, until }) {
  const online = list.filter((s) => answered.has(s.url)).map((s) => s.url);
  const now = Date.now();
  put(HEALTH_KEY, JSON.stringify({ ts: now, online: list.filter((s) => answered.has(s.url) || unprobed.has(s.url)).map((s) => s.url) }));
  let map = readPanels();
  if (sets && !sets.size) panelsRetryAt = now + PANELS_RETRY_MS;
  else if (sets) {
    const prev = map;
    map = groupPanels(sets, prev, now);
    const ix = await indexFitsFrom(answers, list, prev && prev.ix, until);
    if (ix) map.ix = ix;
    writePanels(map);
    // The index panel's account answers index results: its categories now, so that lookup needs no request for 6 h.
    const ixHome = ix && ix.home ? list.find((s) => keyOf(s) === ix.home) : null;
    if (ixHome && answers.has(ix.home)) rememberProbeCats(ixHome, answers.get(ix.home));
  }
  const fresh = readSrvs() || st;
  const cur = fresh.list && fresh.list[fresh.idx];
  if (cur && online.length && !online.includes(cur.url)) {
    const p = panelOf(keyOf(cur), map);
    const flag = flagOf(cur);
    const score = (s) => [p && panelOf(keyOf(s), map) === p ? 0 : 1, flagOf(s) === flag ? 0 : 1, priorityOf(s)];
    const cands = fresh.list.map((s, i) => ({ s, i, sc: score(s) })).filter((x) => online.includes(x.s.url))
      .sort((a, b) => a.sc[0] - b.sc[0] || a.sc[1] - b.sc[1] || a.sc[2] - b.sc[2] || a.i - b.i);
    if (cands.length) { fresh.idx = cands[0].i; fresh.ok = true; fresh.okAt = now; writeSrvs(fresh); }
  }
  return online.length;
}

// ---- the screen's checks, in short steps ----------------------------------------------------------------------------------
// Calls to a plugin run one at a time, so a check that holds one screen tick for seconds also holds a channel the person
// taps meanwhile. The screen's checks therefore run as rounds of short steps, one per tick: a step starts no probe after
// STEP_START_MS and each probe has a short timeout, so a step lasts about a second (its slowest probe's timeout at worst).
// Two kinds of round:
// - "live": the account's login answer only (player_api.php with no action, a few hundred bytes, LIVE_PROBE_TIMEOUT_MS):
//   which accounts answer, for the picker, the player's sources and the live failover's ranking. Every HEALTH_TTL_MS.
// - "full": the VOD category lists (FULL_PROBE_TIMEOUT_MS), which also regroup the accounts into panels and find the index's
//   accounts. Once a day: the live failover only moves a channel to accounts its panel map confirmed within 24 h.
// A round's first step probes only the active and the chosen server (the screen waits for nothing else before it loads).
const LIVE_PROBE_TIMEOUT_MS = 3000;
const FULL_PROBE_TIMEOUT_MS = 4000;
const STEP_START_MS = 700;
const ROUND_MAX_MS = 10 * 60 * 1000; // a round left unfinished longer than this (the screen closed) starts over
let round = null;

/**
 * One step of the screen's check of [kind] ("live" or "full"; a full round in progress serves a live one too). Never throws.
 * "done" when the round finished (stored like healthCheck, with the jump off a dead active server), "more" when it goes on in
 * the next step, "failed" when there is no server list to check (nothing stored: the next screen visit tries again).
 */
export async function healthStep({ kind = "live" } = {}) {
  if (healthRunning) return "more";
  healthRunning = true;
  try {
    if (!round || Date.now() - round.ts > ROUND_MAX_MS || (round.kind !== kind && round.kind !== "full")) {
      const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
      const order = checkOrder(st).filter((s) => usable(s));
      const head = new Set([keyOf(st.list[st.idx]), st.chosen].filter(Boolean));
      round = { kind, ts: Date.now(), st, order, next: 0, head: order.filter((s) => head.has(keyOf(s))).length, sets: new Map(), answers: new Map(), answered: new Set() };
    }
    const r = round;
    const full = r.kind === "full";
    const stop = r.next === 0 && r.head > 0 ? r.head : r.order.length;
    const startUntil = Date.now() + STEP_START_MS;
    await Promise.all(Array.from({ length: HEALTH_PARALLEL }, async () => {
      while (r.next < stop && Date.now() < startUntil) {
        const s = r.order[r.next++];
        try {
          const data = full
            ? await callServer(s, PROBE, {}, { timeoutMs: FULL_PROBE_TIMEOUT_MS })
            : await callServer(s, null, {}, { timeoutMs: LIVE_PROBE_TIMEOUT_MS });
          r.answered.add(s.url);
          if (full) { r.sets.set(keyOf(s), pairHashes(data)); r.answers.set(keyOf(s), data); }
        } catch (_) { /* down */ }
      }
    }));
    if (r.next < r.order.length) return "more";
    round = null;
    const list = r.st.list || [];
    await afterCheck(r.st, list, { sets: full ? r.sets : null, answers: r.answers, answered: r.answered, unprobed: new Set(), until: Date.now() + INDEX_NAMES_TIMEOUT_MS });
    return "done";
  } catch (_) {
    round = null;
    return "failed";
  } finally { healthRunning = false; }
}

export async function refreshServers() {
  const before = readSrvs();
  const st = await loadServers(true);
  const fresh = !before || st.ts !== before.ts; // la lista se pidió de nuevo (si el arranque falla, loadServers devuelve la vieja)
  let ok = fresh;
  if (fresh) { try { await api(PROBE); } catch (_) { /* la lista nueva ya está; el servidor se prueba al usarlo */ } }
  const now = readSrvs() || st;
  return { ok, total: now.list.length, host: hostOf(now.list[now.idx]) };
}

export async function settingsStatus() {
  const s = await serverStatus();
  const idx = await indexLabel((() => { try { const st = readSrvs(); return st.list[st.idx].url; } catch (_) { return ""; } })());
  if (!s.ok) return { status: (s.host ? `Sin respuesta de ${s.host}` : "Sin conexión con el servicio") + (lastErr ? ` · ${lastErr}` : ""), indexStatus: idx };
  return { status: `Conectado a ${s.host} (${s.index} de ${s.total}) · comprobado ${s.at ? "hace " + Math.max(0, Math.round((Date.now() - s.at) / 1000)) + " s" : "ahora"}`, indexStatus: idx };
}

export async function action(key) {
  if (key === "switchServer") {
    const r = await switchServer();
    return { message: r.changed ? `Servidor cambiado a ${r.host}` : "No hay otro servidor que responda ahora" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  if (key === "refreshServers") {
    const r = await refreshServers();
    return { message: r.ok ? `Lista actualizada: ${r.total} servidores` : "No se pudo actualizar la lista" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
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
  infoCache()[itemId] = ficha;
}

function writeFichas() {
  const map = infoCache();
  const ids = Object.keys(map);
  if (ids.length > INFO_MAX) for (const old of ids.slice(0, ids.length - INFO_MAX)) delete map[old];
  // Presupuesto de las fichas: se recortan las más antiguas hasta caber (as Kino counts the store: jsonSize).
  let text = JSON.stringify(map);
  while (jsonSize(text) > 26 * 1024 && Object.keys(map).length > 1) {
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
  if (f.overview) out.overview = f.overview; // la sinopsis de la ficha (para el hero)
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

// Token del título (findKey) para reconocer la MISMA película al abrirla en otro servidor y descartar una colisión de id
// contra otra película. Sin año (las listas no lo traen) ni prefijos quitados: los servidores espejo devuelven el mismo nombre.
function movieNameTok(m) {
  const { name } = cleanTitle(m.name || m.title, "");
  return findKey(name) || "";
}

function vodItem(m, adult) {
  const id = String(m.stream_id || "");
  if (!id) return null;
  const title = displayTitle(m.name || m.title);
  if (!title) return null;
  const ext = String(m.container_extension || "mp4");
  const tok = movieNameTok(m); // se añade al ref para armar las fuentes por servidor (retrocompatible: los ref viejos no lo llevan)
  return {
    id: "vod-" + id,
    ref: "vod:" + id + ":" + ext + (tok ? "~" + tok : ""),
    title,
    kind: "movie",
    poster: img(m.stream_icon || m.cover),
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
  const title = displayTitle(s.name || s.title);
  if (!title) return null;
  return {
    id: "series-" + id,
    ref: "series:" + id,
    title,
    kind: "series",
    poster: img(s.cover || s.poster),
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
  if (info.plot) ficha.overview = String(info.plot).slice(0, 500); // sinopsis para el hero (el listado no siempre la trae)
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
  if (saved) writeFichas(); // one write for all of them (it was one per ficha, each rewriting the whole store)
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

// ---- the category lists of the last minutes, in memory ----
// One category's whole list is downloaded for every page Kino asks of it (browse, liveChannels), and again by the Home's
// country row, a search, the section, the live failover: the same list within minutes. Kept LIST_MEMO_MS per account,
// action and category (an account, not a panel: a panel's accounts carry different subsets of its channels, and the
// failover must see what that very account lists), at most LIST_MEMO_ITEMS items over every list, the oldest dropped first.
// The lists are shared, never changed by their readers.
const LIST_MEMO_MS = 3 * 60 * 1000;
const LIST_MEMO_ITEMS = 8000;
const listMemo = new Map(); // "<account key>|<action>|<category id>" -> { ts, data }
function memoList(k, action, categoryId) {
  const id = k + "|" + action + "|" + categoryId;
  const m = listMemo.get(id);
  if (!m) return null;
  if (Date.now() - m.ts >= LIST_MEMO_MS) { listMemo.delete(id); return null; }
  return m.data;
}
function keepList(k, action, categoryId, data) {
  if (!k || !Array.isArray(data) || data.length > LIST_MEMO_ITEMS) return;
  const id = k + "|" + action + "|" + categoryId;
  listMemo.delete(id);
  listMemo.set(id, { ts: Date.now(), data });
  let n = 0;
  for (const m of listMemo.values()) n += m.data.length;
  for (const [key, m] of listMemo) {
    if (n <= LIST_MEMO_ITEMS) break;
    n -= m.data.length;
    listMemo.delete(key);
  }
}

// Una categoría: vacía ([]) es válida; fallar lanza (se reintenta una vez, con respaldo de servidor dentro de api()).
// [srv]: ask that server only (index results on the index's server), without the walk and without touching srvs: once, with
// a short timeout (opts.timeoutMs, else EXPLICIT_TIMEOUT_MS), so resolve keeps time for the active server.
// A list fetched in the last minutes from that account (the active one without [srv]) is served from memory.
const EXPLICIT_TIMEOUT_MS = 4000;
async function fetchCategory(action, categoryId, srv, opts) {
  const extra = { category_id: String(categoryId) };
  const cached = memoList(srv ? keyOf(srv) : serverKey(), action, String(categoryId));
  if (cached) return cached;
  if (srv) {
    const data = await callServer(srv, action, extra, { timeoutMs: (opts && opts.timeoutMs) || EXPLICIT_TIMEOUT_MS });
    if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
    keepList(keyOf(srv), action, String(categoryId), data);
    return data;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action, extra, opts);
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      keepList(serverKey(), action, String(categoryId), data); // the account that answered (api() made it the active one)
      return data;
    } catch (e) {
      if (attempt >= 1 || (opts && opts.until) || (e && (e.code === "rate_limited" || e.dead))) throw e;
    }
  }
}

const byAddedDesc = (a, b) => num(b.added) - num(a.added);

// ---- categorías y filas ---------------------------------------------------------

// Lista real de categorías (pequeña): en memoria y en storage, con la clave del servidor activo y vigencia de 6 h.
const CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
const catMemo = {};

// [srv]: that server's list (index results on the index's server): storage cache only, the memo stays the active server's;
// asked with a short timeout (opts.timeoutMs, else EXPLICIT_TIMEOUT_MS).
async function categoryList(kind, srv, opts) {
  const key = srv ? keyOf(srv) : serverKey();
  const m = catMemo[kind];
  if (!srv && key && m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return m.list;
  if (key) {
    try {
      const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
      if (o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS) {
        const list = o.l.map(([category_id, category_name]) => ({ category_id, category_name }));
        if (!srv) catMemo[kind] = { key, ts: o.ts, list };
        return list;
      }
    } catch (_) { /* se vuelve a pedir */ }
  }
  const data = srv ? await callServer(srv, CAT_ACTIONS[kind], {}, { timeoutMs: (opts && opts.timeoutMs) || EXPLICIT_TIMEOUT_MS }) : await api(CAT_ACTIONS[kind], {}, opts);
  const list = (Array.isArray(data) ? data : []).map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  const now = srv ? key : serverKey();
  if (!srv) catMemo[kind] = { key: now, ts: Date.now(), list };
  putCats(kind, now, list);
  return list;
}

/** The active server's [kind] category list is cached and fresh: listing it needs no request. */
export function categoriesCached(kind) {
  const key = serverKey();
  const m = catMemo[kind];
  if (!key) return false;
  if (m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return true;
  try {
    const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
    return !!(o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS);
  } catch (_) { return false; }
}

const mergedVod = async (kind, srv, opts) => mergeVod(kind, await categoryList(kind, srv, opts), { showAdult: showAdult() });

const itemOf = (kind, x, adult) => (kind === "vod" ? vodItem(x, adult) : seriesItem(x, adult));

// { rails, langs (los que existen), lang (el elegido), failed (categorías que no cargaron) }.
// opts: { lang, home } — home excluye las grabaciones de cámara.
export async function loadRailsInfo(kind, maxRails, perRail, opts = {}) {
  const vod = kind === "vod";
  let cats = await mergedVod(kind);
  const hasEs = cats.some((c) => c.lang === "es-419" || c.lang === "es-ES");
  const extra = [...new Set(cats.map((c) => c.lang).filter((l) => /^x-/.test(l)))].sort((a, b) => langLabel(a)[0].localeCompare(langLabel(b)[0]));
  const langs = [...LANG_ORDER.filter((l) => (l === "es" ? hasEs : cats.some((c) => c.lang === l))), ...extra];
  const lang = opts.lang && langs.includes(opts.lang) ? opts.lang : langs[0] || null;
  let inLang = cats;
  if (lang === "es") {
    // Latino y España mezclados: una fila por título de categoría (si están en los dos, la de Latino).
    const seenTitle = new Set();
    inLang = cats.filter((c) => (c.lang === "es-419" || c.lang === "es-ES") && !seenTitle.has(c.title.toLowerCase()) && seenTitle.add(c.title.toLowerCase()));
  } else if (lang) inLang = cats.filter((c) => c.lang === lang);
  // Con el 18+ encendido, una fila adulta (marcada) se suma al final aunque pase del tope.
  const ordered = opts.home ? homeOrder(inLang) : inLang.filter((c) => !c.adult);
  const offset = Math.max(0, opts.offset || 0);
  const only = opts.only ? String(opts.only) : "";
  const plain = only ? inLang.filter((c) => c.id === only && !c.adult).slice(0, 1) : ordered.slice(offset, offset + maxRails);
  const hasMore = !only && ordered.length > offset + maxRails;
  const catsList = inLang.filter((c) => !c.adult).map((c) => ({ id: c.id, title: c.title }));
  const chosen = opts.home || offset > 0 ? plain : [...plain, ...inLang.filter((c) => c.adult).slice(0, 1)];

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
  // `noEnrich` lo salta por completo (la carga fila por fila del Home enriquece aparte, para que la fila aparezca ya).
  if (!opts.noEnrich) await enrichTmdb(rails.slice(0, vod ? 2 : 1).flatMap((r) => r.items.slice(0, 8)), { max: vod ? 16 : 8, budgetMs: 2500 });
  return { rails, langs, lang, failed, hasMore, next: offset + maxRails, cats: catsList };
}

export async function loadRails(kind, maxRails, perRail, opts) {
  return (await loadRailsInfo(kind, maxRails, perRail, opts)).rails;
}

// El plan del Home: la lista ORDENADA de categorías a mostrar (sin pedir sus streams todavía), para cargarlas
// una por una. Barato: solo la lista de categorías (cacheada). Misma lógica de idioma y orden que loadRailsInfo.
export async function homeRailPlan(kind, max, wantLang) {
  const cats = await mergedVod(kind);
  const hasEs = cats.some((c) => c.lang === "es-419" || c.lang === "es-ES");
  const extra = [...new Set(cats.map((c) => c.lang).filter((l) => /^x-/.test(l)))].sort((a, b) => langLabel(a)[0].localeCompare(langLabel(b)[0]));
  const langs = [...LANG_ORDER.filter((l) => (l === "es" ? hasEs : cats.some((c) => c.lang === l))), ...extra];
  const lang = wantLang && langs.includes(wantLang) ? wantLang : langs[0] || null;
  let inLang = cats;
  if (lang === "es") {
    const seen = new Set();
    inLang = cats.filter((c) => (c.lang === "es-419" || c.lang === "es-ES") && !seen.has(c.title.toLowerCase()) && seen.add(c.title.toLowerCase()));
  } else if (lang) inLang = cats.filter((c) => c.lang === lang);
  const ordered = homeOrder(inLang);
  return { lang, langs, cats: ordered.slice(0, max).map((c) => ({ id: c.id, title: c.title })) };
}

// Una sola fila (categoría) del Home, sin bloquear con TMDB: la fila aparece de inmediato y los logos se rellenan después.
// Una categoría vacía o que falla devuelve null (no lanza): esa fila simplemente no se muestra, las demás siguen.
export async function oneRail(kind, catId, perRail, lang) {
  try {
    const info = await loadRailsInfo(kind, 1, perRail, { lang, only: catId, noEnrich: true });
    return info.rails[0] || null;
  } catch (_) { return null; }
}

// ---- home -----------------------------------------------------------------------

const COUNTRY_ROW_MS = 3000;
export async function home() {
  const dbgT = Date.now();
  console.log("[dbg] home() de Kino: inicio server=" + serverKey());
  // Feed pre-armado (el mismo del Inicio de la pantalla): la fila de inicio sale sin recorrer el IPTV. Si falta, está viejo o no
  // abre, se cae a la carga en vivo de abajo. La fila de TV del país se intenta en vivo, con tope, para que nunca frene la carga.
  // The row's cap is each request's own timeout (COUNTRY_ROW_MS in all), never a race with kino.sleep: Kino holds a call
  // until every pending binding settles, a sleep included, so that race held every home() 3 s, even with no country set
  // (the default), and the queued calls behind it.
  try {
    const feed = await fetchHomeFeed(serverKey(), null);
    if (feed && feed.rows.length) {
      const rows = feed.rows.map((r) => ({ id: r.id, title: r.title, ref: r.ref, items: r.items }));
      const live = isCountryCode(homeCountry()) ? await countryRow(20, { until: Date.now() + COUNTRY_ROW_MS }).catch(() => null) : null;
      if (live) rows.push({ id: live.id, title: live.title, genre: "tv", items: live.items });
      indexStep({ budgetMs: 1500 }).catch(() => {}); // el índice sigue poblándose en segundo plano, sin esperarlo
      console.log("[dbg] home() de Kino: DESDE EL FEED rows=" + rows.length + " " + (Date.now() - dbgT) + "ms");
      return rows;
    }
  } catch (_) { /* cae a la carga en vivo */ }
  console.log("[dbg] home() de Kino: sin feed, carga EN VIVO del IPTV");
  // El índice de títulos se puebla/actualiza mientras carga el Home (un paso acotado en tiempo; nunca lanza).
  const indexing = indexStep({ budgetMs: 1500 }); // paso corto: el poblado sigue en los siguientes Homes (nunca frena la carga)
  const vod = await loadRailsInfo("vod", 7, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const series = await loadRailsInfo("series", 4, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const live = await countryRow().catch(() => null);
  await indexing;
  const rows = [...vod.rails, ...series.rails].map(({ lang, ...r }) => r);
  if (!rows.length) throw kino.error("unavailable", "sin contenido", { userMessage: "Sin contenido disponible por ahora." });
  if (live) rows.push({ id: live.id, title: live.title, genre: "tv", items: live.items });
  console.log("[dbg] home() de Kino: fin rows=" + rows.length + " " + (Date.now() - dbgT) + "ms");
  return rows;
}

// ---- browse ---------------------------------------------------------------------

export async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const [kindPrefix, catId, flag] = String(ref || "").split(":");
  if (kindPrefix === "lcat" && /^\d+$/.test(catId || "")) {
    // The whole category, page by page (it stopped at liveChannels' first page): the list itself comes from memory.
    const out = await liveChannels({ categoryId: catId, cursor: String(start) });
    const all = out.items.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...(i.adult ? { adult: true } : {}) }));
    return { items: all.slice(0, PER_PAGE), next: all.length > PER_PAGE || out.next ? String(page + 1) : undefined };
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
// El índice sirve en CUALQUIER servidor: sus refs `idx:` se resuelven por título en el servidor activo (resolveIdxRef), igual que
// las fuentes por servidor del reproductor. Antes se limitaba al servidor de casa, cuando esos refs solo se abrían ahí; ahora no.
async function viaIndex(q, type) {
  await backHome().catch(() => {});
  const ready = indexReady();
  const [found] = await Promise.all([ready ? indexSearch(q, type) : null, !ready || indexStale() ? indexStep({ budgetMs: 1500 }) : null]);
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

// Categorías de este servidor (los ids del índice son de otro servidor): primero géneros y estrenos, que es donde más se repite.
// [wanted]: [título, idioma] de las categorías del índice; las de este servidor que se llaman igual van primero.
const serverCats = async (kind, wanted = [], srv, opts) => {
  const all = searchOrder(await mergedVod(kind === "movies" ? "vod" : "series", srv, opts));
  const key = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hit = (c) => wanted.some(([t, l]) => key(t) === key(c.title) && (l === c.lang || !l));
  const same = all.filter(hit);
  const out = [...same, ...all.filter((c) => !hit(c))].map((c) => c.id);
  out.matched = same.length;
  return out;
};

export async function episodes(ref) {
  if (String(ref || "").startsWith("idx:s:")) ref = await resolveIdxRef(ref, fetchCategory, serverCats);
  const id = String(ref || "").replace(/^series:/, "");
  if (!/^\d+$/.test(id)) throw kino.error("not_found");

  const data = await api("get_series_info", { series_id: id });
  if (!data || typeof data !== "object") throw kino.error("not_found");

  const info = data.info || {};
  const seriesInfo = {
    title: info.name ? String(info.name) : undefined,
    poster: img(info.cover || info.movie_image),
    overview: info.plot ? String(info.plot).slice(0, 500) : undefined,
    year: info.year ? String(info.year) : undefined,
    rating: info.rating ? parseFloat(info.rating) || undefined : undefined,
    genres: info.genre ? String(info.genre).split(/[,/]/).map((g) => g.trim()).filter(Boolean) : undefined,
  };

  const tok = findKey(cleanTitle(info.name || "", "").name); // nombre de la serie: para armar y confirmar las fuentes por servidor
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
        ref: "ep:" + epId + ":" + ext + (tok ? "~" + id + "~" + tok : ""),
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

// Kino asks liveChannels for pages of up to 500 channels (10 at first): 200 meant 2.5 times the pages for a big category.
const LIVE_PAGE = 500;
const LIVE_CATS_TTL_MS = 10 * 60 * 1000;
let liveCatsMemo = null;

// Las categorías cambian de un servidor a otro: la caché lleva la clave del servidor activo.
// opts.until: as api()'s.
async function liveCats(opts) {
  const key = serverKey();
  if (liveCatsMemo && key && liveCatsMemo.key === key && Date.now() - liveCatsMemo.ts < LIVE_CATS_TTL_MS) return liveCatsMemo.list;
  const merged = mergeLive(await categoryList("live", null, opts), { showAdult: true });
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

// The category's name by id, from the live categories in memory (the listing's own server).
let catNames = { list: null, map: null };
function catNameOf(catId) {
  const m = catMemo.live;
  if (!m || !Array.isArray(m.list)) return "";
  if (catNames.list !== m.list) catNames = { list: m.list, map: new Map(m.list.map((c) => [String(c.category_id), c.category_name])) };
  return catNames.map.get(String(catId)) || "";
}

// A live item. Its ref carries the category (id and name) and the channel's name, identical for every account of a
// panel: resolve() can then tell whether the id belongs to the active server's panel and find the channel by name on
// another panel when every account of its own refuses it. The ref always reads the panel's RAW name; [shown] (the name
// without its decorations, channelTitles) is only what the person sees.
function liveItem(s, categoryId, adult, shown) {
  const id = String(s.stream_id || "");
  const raw = String(s.name || "").trim();
  if (!id || !raw) return null;
  const catId = String(categoryId || s.category_id || "");
  return {
    id: "live-" + id,
    title: shown || raw,
    ref: liveRef(id, catId, categoryTok(catNameOf(catId)), channelTok(raw)),
    logo: img(s.stream_icon),
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
  // Shown titles over the whole category (not the page): a channel looks the same on every page. Worked out once per list
  // (the next pages get the same list from memory).
  const catKey = categoryKey(catNameOf(categoryId));
  const seen = shownMemo.get(all);
  const shown = seen && seen.cat === catKey && seen.lang === langNow() ? seen.shown : shownTitles(all, catKey);
  if (!seen || seen.shown !== shown) shownMemo.set(all, { cat: catKey, lang: langNow(), shown });
  const items = [];
  for (let i = start; i < Math.min(all.length, start + LIVE_PAGE); i++) { const it = liveItem(all[i], categoryId, adult, shown[i]); if (it) items.push(it); }
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : undefined };
}

const shownMemo = new WeakMap(); // a category list -> its shown titles { cat, lang, shown }

// The shown titles of one list of panel streams (`[{ name }]`) whose category's country or region is [catKey].
const shownTitles = (streams, catKey) => channelTitles(streams.map((s) => (s && s.name) || ""), { cat: catKey, lang: langNow() });

// Whether a stream's name holds [q] (lowercase): as the panel writes it, or as the person sees it. The shown title only adds
// text the raw name lacks when it gained a " · " or a quality moved to its end, so only such a query cleans each name.
const SHOWN_ONLY = /·|\b(?:4k|8k|uhd|fhd|hd|sd|hevc)\b/;
const nameHas = (s, q) => {
  const raw = String((s && s.name) || "");
  return raw.toLowerCase().replace(/\s+/g, " ").includes(q) || (SHOWN_ONLY.test(q) && cleanChannelTitle(raw).title.toLowerCase().includes(q));
};

export async function liveSearchDetailed({ query }, { budgetMs = 11000 } = {}) {
  const q = String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
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
        return data.filter((s) => nameHas(s, q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean)
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
  // The hits are one mixed list: their shown titles are worked out together. A query that IS a hit's raw name (Kino looks a
  // channel saved under its old, decorated name up this way) gets that hit under its raw name, so Kino recognises it.
  const shown = shownTitles(items.map((it) => ({ name: it.title })), "");
  const asked = normName(query);
  items.forEach((it, i) => { if (normName(it.title) !== asked) it.title = shown[i]; });
  return { items, partial: failed > 0 || capped };
}

export async function liveSearch(args) {
  const { items } = await liveSearchDetailed(args);
  return { items };
}

// ---- canales de tu país ---------------------------------------------------------

export const isCountryCode = (cc) => COUNTRY_PHRASES.some(([, code]) => code === cc);

// El país va en el nombre de la categoría ("COLOMBIA", "DEPORTES PERU", "VIX - MEXICO"): las que SON el país primero.
// opts.until: a deadline for its requests (Kino's Home answers by then, with or without this row).
export async function countryRow(limit = 20, opts = {}) {
  const cc = homeCountry();
  if (!isCountryCode(cc)) return null;
  const ranked = visibleLive(await liveCats(opts))
    .filter((c) => c.country === cc)
    .map((c) => ({ c, m: countryMatch(c.title) }))
    .sort((a, b) => (a.m && a.m.exact ? 0 : a.m && a.m.starts ? 1 : 2) - (b.m && b.m.exact ? 0 : b.m && b.m.starts ? 1 : 2) || a.c.order - b.c.order)
    .slice(0, 3);
  const items = [];
  const seen = new Set();
  for (const { c } of ranked) {
    if (items.length >= limit) break;
    if (opts.until && opts.until - Date.now() < 1000) break;
    const data = await fetchCategory("get_live_streams", c.id, null, opts).catch(() => []);
    for (const s of data) {
      const it = liveItem(s, c.id, c.adult);
      if (!it || items.length >= limit || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...(c.adult ? { adult: true } : {}) });
    }
  }
  const shown = shownTitles(items.map((it) => ({ name: it.title })), cc.toLowerCase());
  items.forEach((it, i) => { it.title = shown[i]; });
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

// Kino asks the guide for up to 50 channels per call (the first 40 of a category, as it lists them) and calls to a plugin
// run one at a time: a guide call that sent 50 programme requests at once, each through api() (its own backHome probe, and
// the walk to other accounts, whose stream ids are another panel's channels), held native En vivo's categories behind it
// for 2.4-4.4 s (measured on a Redmi: 25-51 panel requests). Now the first GUIDE_MAX channels (the ones on screen first),
// on the active server only, at most GUIDE_PARALLEL at once (Kino's requests per host), each with GUIDE_TIMEOUT_MS: one
// call holds the queue about a second. Kino keeps what it got for 30 min.
const GUIDE_MAX = 12;
const GUIDE_PARALLEL = 4;
const GUIDE_TIMEOUT_MS = 3000;
export async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).slice(0, GUIDE_MAX);
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv || !usable(srv)) return [];
  const lists = await pool(ids, GUIDE_PARALLEL, async (cid) => {
    const streamId = String(cid).replace(/^live-/, "");
    if (!/^\d+$/.test(streamId)) return [];
    try {
      const data = await callServer(srv, "get_short_epg", { stream_id: streamId, limit: "20" }, { timeoutMs: GUIDE_TIMEOUT_MS });
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
  });
  return lists.flat();
}

// ---- resolve --------------------------------------------------------------------

// ---- fuentes por servidor (el menú "Servidor" del reproductor) -----------------------------------------
// Muchos servidores comparten el MISMO id de stream para una película (son espejos del catálogo). Así que una fuente
// alternativa es "la misma película (mismo id) en otro servidor": instantáneo, sin emparejar por título (que aquí es frágil,
// porque las listas no traen año y los nombres llevan prefijos "XX ▎"). Al elegirla se confirma con get_vod_info —un servidor
// que no tenga ese id, o lo tenga apuntando a otra película, lo rechaza— y se aprende para pintar la lista exacta la próxima vez.

const AVAIL_KEY = "avail:v1";
const AVAIL_TTL_MS = 36 * 60 * 60 * 1000; // el catálogo cambia lento; se vuelve a comprobar pasado esto
const AVAIL_MAX_BYTES = 15 * 1024; // its storage class holds 16 KB: the oldest titles go first, so a write always fits

function readAvail() { try { const o = JSON.parse(kino.storage.get(AVAIL_KEY) || "{}"); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; } }
// Apunta si el servidor [k] tiene (ext = su extensión) o no (ext = null) la película [id].
// A fact learnt less than AVAIL_SAME_MS ago (same server, same answer) is not written again: every play of a title wrote it.
const AVAIL_SAME_MS = 60 * 60 * 1000;
function recordAvail(id, k, ext) {
  if (!id || !k) return;
  const all = readAvail();
  const t = all[id] && typeof all[id] === "object" ? all[id] : {};
  const was = t[k];
  if (was && Date.now() - (was.ts || 0) < AVAIL_SAME_MS && (ext ? was.has === 1 && was.ext === ext : was.has === 0)) return;
  t[k] = ext ? { has: 1, ext, ts: Date.now() } : { has: 0, ts: Date.now() };
  t._ts = Date.now();
  all[id] = t;
  // Se olvidan las películas vistas hace más tiempo hasta caber en AVAIL_MAX_BYTES (unos 150 títulos).
  const keys = Object.keys(all).sort((a, b) => (all[a]._ts || 0) - (all[b]._ts || 0));
  let drop = 0;
  let text = JSON.stringify(all);
  while (jsonSize(text) > AVAIL_MAX_BYTES && drop < keys.length - 1) {
    const cut = Math.max(1, Math.ceil((keys.length - drop) / 10));
    for (const old of keys.slice(drop, drop + cut)) delete all[old];
    drop += cut;
    text = JSON.stringify(all);
  }
  try { put(AVAIL_KEY, text); } catch (_) { /* storage lleno: se pierde el aprendizaje, no pasa nada */ }
}
// Lo que sabemos del servidor [k] para la película [id]: { has, ext? } fresco, o null si no se sabe / caducó.
function availFor(id, k) {
  const t = readAvail()[id];
  const e = t && t[k];
  if (!e || Date.now() - (e.ts || 0) > AVAIL_TTL_MS) return null;
  return e;
}

// Fuentes alternativas de un título: un servidor online por fila (menos el activo), etiquetado por país. Perezosas: solo
// se resuelven al elegirlas. Se omiten los que ya sabemos que no la tienen; los conocidos van primero. [availId] es la clave
// de la caché "aprende" ("m:<id>" película, "e:<epId>" episodio); [makeRef] arma el `at:` ref de cada servidor.
function buildAlternatives(availId, activeKey, makeRef) {
  if (!availId) return [];
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return [];
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  const known = [], unknown = [];
  const countBy = {}; // cuántos servidores por país: para desambiguar los repetidos con el host
  for (const srv of st.list) {
    const k = keyOf(srv);
    if (!k || k === activeKey) continue;
    if (!usable(srv)) continue; // dead (auth 0) or blocked: never offered
    if (online && !online.has(srv.url)) continue; // solo online, si hay chequeo fresco
    const av = availFor(availId, k);
    if (av && !av.has) continue; // ya sabemos que no lo tiene: se omite
    const base = niceLabel(srv);
    countBy[base] = (countBy[base] || 0) + 1;
    (av && av.has ? known : unknown).push({ base, host: hostOf(srv), ref: makeRef(k) });
  }
  const label = (e) => (countBy[e.base] > 1 && e.host ? `${e.base} · ${e.host}` : e.base);
  return [...known, ...unknown].slice(0, 12).map((e) => ({ label: label(e), ref: e.ref }));
}

// Busca la extensión del episodio [epId] en la respuesta de get_series_info; "" si no está en este servidor.
function episodeExtIn(data, epId, hintExt) {
  for (const list of Object.values((data && data.episodes) || {})) {
    for (const e of Array.isArray(list) ? list : []) {
      if (String(e.id) === epId) return String((e.info && e.info.container_extension) || e.container_extension || hintExt || "mp4");
    }
  }
  return "";
}

// Resuelve una fuente alternativa contra el servidor [K], sin tocar el servidor activo:
//   película: `at:<K>~m~<id>~<ext>~<tok>`        episodio: `at:<K>~e~<epId>~<ext>~<seriesId>~<tok>`
// Se confirma con get_vod_info / get_series_info —un servidor sin ese id, o con otro contenido en él, lo rechaza— y se aprende.
async function resolveAlt(s) {
  const segs = s.slice(3).split("~");
  const k = segs[0];
  const kind = segs[1];
  const srv = serverByKey(k);
  if (!srv) throw kino.error("not_found", "servidor desconocido");

  if (kind === "m") {
    const id = segs[2] || "";
    const hintExt = segs[3] || "mp4";
    const tok = segs.slice(4).join("~"); // findKey del título (descarta una colisión de id)
    if (!/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    const availId = "m:" + id;
    const cached = availFor(availId, k);
    if (cached && cached.has && cached.ext) return { url: `${srv.url}/movie/${srv.username}/${srv.password}/${id}.${cached.ext}` };
    let data;
    try { data = await callServer(srv, "get_vod_info", { vod_id: id }); } catch (_) { recordAvail(availId, k, null); throw kino.error("not_found", "fuente no disponible"); }
    const md = (data && data.movie_data) || {};
    const name = md.name || (data && data.info && data.info.name) || "";
    if (!name || (tok && findKey(cleanTitle(name, "").name) !== tok)) { recordAvail(availId, k, null); throw kino.error("not_found", "el servidor no tiene esta película"); }
    const ext = String(md.container_extension || hintExt || "mp4");
    recordAvail(availId, k, ext);
    return { url: `${srv.url}/movie/${srv.username}/${srv.password}/${id}.${ext}` };
  }

  if (kind === "l") {
    const id = segs[2] || "";
    if (!/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    // El canal en el servidor [K] elegido por la persona: el menú solo ofrece cuentas del mismo panel (mismo id) o el id que
    // la búsqueda por nombre verificó en otro panel (ver liveFailover.js).
    return { url: `${srv.url}/live/${srv.username}/${srv.password}/${id}.${liveFormat()}` };
  }

  if (kind === "e") {
    const epId = segs[2] || "";
    const hintExt = segs[3] || "mp4";
    const seriesId = segs[4] || "";
    const tok = segs.slice(5).join("~"); // findKey del nombre de la serie (descarta una colisión)
    if (!/^\d+$/.test(epId) || !/^\d+$/.test(seriesId)) throw kino.error("not_found", "fuente desconocida");
    const availId = "e:" + epId;
    const cached = availFor(availId, k);
    if (cached && cached.has && cached.ext) return { url: `${srv.url}/series/${srv.username}/${srv.password}/${epId}.${cached.ext}` };
    let data;
    try { data = await callServer(srv, "get_series_info", { series_id: seriesId }); } catch (_) { recordAvail(availId, k, null); throw kino.error("not_found", "fuente no disponible"); }
    const name = (data && data.info && (data.info.name || data.info.title)) || "";
    if (tok && name && findKey(cleanTitle(name, "").name) !== tok) { recordAvail(availId, k, null); throw kino.error("not_found", "el servidor no tiene esta serie"); }
    const ext = episodeExtIn(data, epId, hintExt);
    if (!ext) { recordAvail(availId, k, null); throw kino.error("not_found", "el episodio no está en este servidor"); }
    recordAvail(availId, k, ext);
    return { url: `${srv.url}/series/${srv.username}/${srv.password}/${epId}.${ext}` };
  }

  throw kino.error("not_found", "fuente desconocida");
}

// ---- live failover ---------------------------------------------------------------------------------------------------

// The cached live categories of [srv] (memory or storage, any age) and when they were fetched: no request.
function cachedLive(srv) {
  const k = keyOf(srv);
  if (!k) return null;
  const m = catMemo.live;
  if (m && m.key === k && Array.isArray(m.list)) return { ts: m.ts, list: m.list };
  try {
    const o = JSON.parse(kino.storage.get("cats:live:" + k) || "null");
    if (o && Array.isArray(o.l)) return { ts: o.ts, list: o.l.map(([category_id, category_name]) => ({ category_id: String(category_id), category_name: String(category_name) })) };
  } catch (_) { /* not cached */ }
  return null;
}
const cachedCats = (srv) => { const c = cachedLive(srv); return c ? c.list : null; };
const cachedCatsAt = (srv) => { const c = cachedLive(srv); return c && typeof c.ts === "number" ? c.ts : null; };

// Live categories the failover asked again, kept as that server's live category cache (the active one's memo too).
function rememberLiveCats(srv, data) {
  const k = keyOf(srv);
  if (!k || !Array.isArray(data) || !data.length) return;
  const list = data.map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  if (serverKey() === k) catMemo.live = { key: k, ts: Date.now(), list };
  putCats("live", k, list);
}

// The server list for a live resolve: the cached one (even past its 6 h), never a failover walk; the bootstrap only on a
// fresh install, with short timeouts (resolve has 20 s).
async function liveServers() {
  const st = readSrvs();
  if (st && Array.isArray(st.list) && st.list.length) return st;
  return loadServers(false, { timeoutMs: 4000 });
}

// A per-install number: equally ranked accounts are not all picked in the same order by every device (the accounts are
// shared and allow 1-3 connections).
let seedMemo = "";
function installSeed() {
  if (seedMemo) return seedMemo;
  let v = null;
  try { v = kino.storage.get("seed:v1"); } catch (_) { v = null; }
  if (!v || !/^\d+$/.test(v)) { v = String(Math.floor(Math.random() * 1e9)); put("seed:v1", v); }
  seedMemo = v;
  return v;
}

export const langNow = () => { try { return /^en/i.test(String(kino.lang || "")) ? "en" : "es"; } catch (_) { return "es"; } };

const failover = createLiveFailover({
  servers: liveServers,
  cachedCats,
  catsAt: cachedCatsAt,
  storeCats: rememberLiveCats,
  // The category lists of the last minutes (listMemo), shared with the screen's and Kino's listings.
  cachedList: (srv, catId) => memoList(keyOf(srv), "get_live_streams", String(catId)),
  keepList: (srv, catId, data) => keepList(keyOf(srv), "get_live_streams", String(catId), data),
  callServer,
  playUrl: (srv, id, format) => `${srv.url}/live/${srv.username}/${srv.password}/${id}.${format || liveFormat()}`,
  label: niceLabel,
  host: hostOf,
  online: () => { const h = healthFresh(); return h ? new Set(h.online) : null; },
  flag: flagOf,
  priority: priorityOf,
  seed: installSeed,
  now: () => Date.now(),
  unavailable: () => kino.error("unavailable", "no account plays this channel now", { userMessage: say("liveNoServer", langNow()) }),
  notFound: () => kino.error("not_found", "channel not found"),
});

// An index result on the index's HOME (its category ids are the index's, so resolveIdxRef + serverCats there is FAST), without
// changing the person's server: requests go to that server explicitly and srvs is never written (a Kino timeout can no longer
// leave the person pinned at home). When the active server is an account of the index's panel that carries the title's own
// categories (or, when that is unknown, every category of the index), the normal path resolves it: { skipped: true }.
// Every request to home has a short timeout and no retry; the first one it does not answer (timeout, network, refused host,
// dead account) or IDX_HOME_DEADLINE_MS ends the attempt (Kino gives resolve 20 s: the rest is the active server's). [force]: without the
// active server's shortcut (it lacked the title). Returns { srv (the one that resolved it), direct }, { skipped: true } or null.
const IDX_HOME_DEADLINE_MS = 10000;
const IDX_RESOLVE_BUDGET_MS = 19000; // Kino's RESOLVE_TIMEOUT_MS is 20 s
async function resolveIdxOnHome(idxRef, { force = false, until = Date.now() + IDX_HOME_DEADLINE_MS } = {}) {
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return null;
  const map = readPanels();
  const active = st.list[st.idx];
  if (!force && indexSource() && usable(active) && fitsIndex(active, map)) {
    if (indexFitsServer(active.url)) return { skipped: true };
    const carries = await carriesIndexCats(active, parseIdxRef(idxRef));
    if (carries === true || (carries === null && fullyFitsIndex(active, map))) return { skipped: true };
  }
  const homeI = indexHomeIdx(st, map);
  if (homeI < 0 || homeI === st.idx) return null; // the active server is home: the normal path resolves it
  const home = st.list[homeI];
  let down = false;
  // One request to home, in the time the attempt has left; refused (thrown) once home is down or the deadline is near, which
  // resolveIdxRef counts as a failed category.
  const onHome = async (ask) => {
    const left = until - Date.now();
    if (down || left < 1000) throw new Error("index server not answering");
    try { return await ask({ timeoutMs: Math.min(EXPLICIT_TIMEOUT_MS, left) }); } catch (e) {
      if (e && (e.code === "timeout" || e.code === "network" || e.code === "host_not_allowed" || e.dead)) down = true;
      throw e;
    }
  };
  try {
    const direct = await resolveIdxRef(idxRef,
      (action, cat) => onHome((o) => fetchCategory(action, cat, home, o)),
      (kind, wanted) => onHome((o) => serverCats(kind, wanted, home, o)));
    return direct ? { srv: home, direct } : null;
  } catch (_) { return null; }
}

export async function resolve(ref) {
  let s = String(ref || "");

  // Fuente alternativa: la misma película en otro servidor (no el activo, y sin cambiarlo).
  if (s.startsWith("at:")) return await resolveAlt(s);

  // En vivo: la cuenta que reproduce el canal y, con evidencia (un rechazo o la cadena de reaperturas de Kino), otra cuenta del
  // mismo panel o el mismo canal por nombre en otro panel. Nunca cambia el servidor activo ni hace el recorrido de respaldo.
  if (s.startsWith("live:")) return failover.resolve(s);

  const t0 = Date.now();
  const active = await activeServer();
  const { url, username, password } = active;

  // An index result (idx:m:) resolves on the index's home (fast, and with every title of the index); when the active server
  // carries the title's categories it takes the normal path below, and when the title is not there, home gets one try. It
  // carries the find token for the per-server sources.
  if (s.startsWith("idx:m:")) {
    const p = parseIdxRef(s);
    const tok = (p && p.find) || "";
    await indexCategoryNames({ timeoutMs: INDEX_NAMES_TIMEOUT_MS }).catch(() => null); // once per session, never Kino's 15 s
    let onHome = await resolveIdxOnHome(s);
    if (!onHome || !onHome.direct) {
      // The active server carries the index's ids (or home did not answer): resolved there, then played as a normal movie.
      try {
        s = (await resolveIdxRef(s, fetchCategory, serverCats)) + (tok ? "~" + tok : ""); // "vod:<id>:<ext>" on the active server
        onHome = null;
      } catch (e) {
        // The active account fit the index but lacked this title: once on the index's server, in the time resolve has left.
        const until = Math.min(Date.now() + IDX_HOME_DEADLINE_MS, t0 + IDX_RESOLVE_BUDGET_MS);
        if (!onHome || !onHome.skipped || !e || e.code !== "not_found" || until - Date.now() < 3000) throw e;
        onHome = await resolveIdxOnHome(s, { force: true, until });
        if (!onHome || !onHome.direct) throw e;
      }
    }
    const mv = onHome && /^vod:(\d+):(.+)$/.exec(onHome.direct);
    if (mv) {
      const [, id, ext] = mv, srv = onHome.srv, key = keyOf(srv);
      noteRecent(id, ext, key);
      recordAvail("m:" + id, key, ext);
      const out = { url: `${srv.url}/movie/${srv.username}/${srv.password}/${id}.${ext}` };
      const alts = buildAlternatives("m:" + id, key, (k) => `at:${k}~m~${id}~${ext}~${tok}`);
      if (alts.length) { out.alternatives = alts; out.label = niceLabel(srv); }
      return out;
    }
  }

  if (s.startsWith("vod:")) {
    const [core, ...rest] = s.slice(4).split("~");
    const tok = rest.join("~"); // findKey del título, si el ítem lo trae (retrocompatible: los ref viejos no lo llevan)
    const parts = core.split(":");
    const streamId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(streamId)) throw kino.error("not_found");
    const aKey = serverKey();
    noteRecent(streamId, ext, aKey);
    recordAvail("m:" + streamId, aKey, ext); // el servidor activo la tiene
    const out = { url: `${url}/movie/${username}/${password}/${streamId}.${ext}` };
    const alts = buildAlternatives("m:" + streamId, aKey, (k) => `at:${k}~m~${streamId}~${ext}~${tok}`);
    if (alts.length) { out.alternatives = alts; out.label = niceLabel(active); } // etiqueta del servidor activo en el menú "Servidor"
    return out;
  }

  if (s.startsWith("ep:")) {
    const [core, ...rest] = s.slice(3).split("~");
    const seriesId = rest[0] || ""; // la serie (para confirmar el episodio en otro servidor); los ref viejos no lo llevan
    const tok = rest.slice(1).join("~");
    const parts = core.split(":");
    const epId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(epId)) throw kino.error("not_found");
    const aKey = serverKey();
    recordAvail("e:" + epId, aKey, ext); // el servidor activo lo tiene
    const out = { url: `${url}/series/${username}/${password}/${epId}.${ext}` };
    const alts = /^\d+$/.test(seriesId) ? buildAlternatives("e:" + epId, aKey, (k) => `at:${k}~e~${epId}~${ext}~${seriesId}~${tok}`) : [];
    if (alts.length) { out.alternatives = alts; out.label = niceLabel(active); } // etiqueta del servidor activo en el menú "Servidor"
    return out;
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
  if (!out.overview && e.overview) out.overview = e.overview;
  if (!out.ids && e.ids) out.ids = e.ids;
  if (!out.runtimeMinutes && e.runtimeMinutes) out.runtimeMinutes = e.runtimeMinutes;
  if (!out.genres && e.genres) out.genres = e.genres;
  return out;
}

export { api, vodItem, seriesItem, genreOf, liveItem };
