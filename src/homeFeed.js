// Baja el Home pre-armado que el Action publica en home/<serverKey>.enc.json. Si existe y es reciente, el plugin pinta su
// Home al instante (sin recorrer el servidor IPTV); si falta, está viejo o el fetch falla, se usa la carga en vivo progresiva.
// Los feeds se publican SELLADOS (AES-256-GCM con el secreto feedKey, igual que Xuper): el plugin los abre con
// kino.secret("feedKey") — solo dentro de Kino; un fork con el código copiado no puede.
import { put } from "./store.js";

// Where the feeds live. The producers publish the feeds (home/<serverKey>[.<lang>].enc.json, live/<serverKey>.enc.json) to the
// orphan branch `data`, force-pushed every run with the complete current set and no history, and, while installs older than
// this reader exist, to `main` too. Feed v2 (this reader): beside each `data` file the producers publish a compressed copy at
// the same path ending in `.v2.enc.json` instead of `.enc.json`: the same envelope with "v": 2, whose AES-256-GCM plaintext
// is gzip (mtime 0) of the same UTF-8 JSON (a 223 KB feed is about a third of that). This reader asks `data`'s v2 copy first
// and `main`'s v1 file only for a feed `data` lacks; a Kino without kino.crypto.gunzip reads as 0.8.6 did (`data` v1, then
// `main` v1). v1 files are never changed: 0.8.5/0.4.0 read `main` v1, 0.8.6/0.4.1 `data` v1 then `main` v1.
const REPO = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd/";
const DATA_BRANCH = "data";
const MAIN_BRANCH = "main";
// `data` answered 404 for a file `main` serves fresh: the branch does not exist yet. Remembered (in memory and in storage, with
// its time) for 6 h, so a device does not pay two requests per feed meanwhile; then `data` is tried again.
const DATA_MISS_KEY = "feedData:v1";
const DATA_MISS_TTL_MS = 6 * 60 * 60 * 1000;
// With a deadline (the first run's tick), a request with less than this left is not started.
const MIN_REQUEST_MS = 1000;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo

let dataMissAt; // undefined until read from storage; 0 = not known missing

function dataMissing() {
  if (dataMissAt === undefined) {
    let o = null;
    try { o = JSON.parse(kino.storage.get(DATA_MISS_KEY) || "null"); } catch (_) { o = null; }
    dataMissAt = o && typeof o.at === "number" ? o.at : 0;
  }
  const age = Date.now() - dataMissAt;
  return dataMissAt > 0 && age >= 0 && age < DATA_MISS_TTL_MS;
}

function noteDataMissing() {
  dataMissAt = Date.now();
  put(DATA_MISS_KEY, JSON.stringify({ at: dataMissAt }));
}

const canGunzip = () => { try { return typeof kino.crypto.gunzip === "function"; } catch (_) { return false; } };

// Abre el sobre sellado { v:1, iv:b64, data:b64 } con el secreto feedKey (AES-256-GCM). null si no abre. Nunca lanza.
// { v:2, ... }: the plaintext is gzip, opened as bytes (base64) and inflated natively (kino.crypto.gunzip, apiVersion 13).
function openBox(text) {
  let box = null;
  try { box = JSON.parse(text); } catch (_) { return null; }
  if (!box || typeof box !== "object" || (box.v !== 1 && box.v !== 2) || typeof box.iv !== "string" || typeof box.data !== "string") return null;
  try {
    const opts = { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data };
    if (box.v === 1) return JSON.parse(kino.crypto.decrypt("aes-256-gcm", opts));
    if (!canGunzip()) return null;
    return JSON.parse(kino.crypto.gunzip(kino.crypto.decrypt("aes-256-gcm", { ...opts, outputEncoding: "base64" })));
  } catch (_) { return null; }
}

// The v2 copy's path beside a v1 file's.
const v2Path = (path) => path.replace(/\.enc\.json$/, ".v2.enc.json");

/**
 * One sealed feed file at [path] (its v1 path), `data` first: its v2 copy when Kino can inflate it, else its v1 file.
 * [accept] turns the opened content into the result, or null when it does not serve (stale, another server, empty). Only a
 * file `data` lacks (a non-2xx answer, or a body that does not open) is asked from `main` (v1); a network error is not (main
 * sits behind the same host), and content that opened but does not serve is not either (main's copy is never newer).
 * [until]: a deadline in ms since the epoch, or 0 for none. The result, or null. A network error throws.
 */
async function fetchSealed(path, v, accept, until) {
  const dataPath = canGunzip() ? v2Path(path) : path;
  const one = async (branch, file) => {
    const init = { headers: { Accept: "application/json" } };
    if (until) {
      const left = until - Date.now();
      if (left < MIN_REQUEST_MS) return { late: true };
      init.timeoutMs = left;
    }
    const r = await kino.fetch(`${REPO}${branch}/${file}?v=${v}`, init);
    if (!r.ok) { console.log("[dbg] feed: HTTP " + r.status + " " + branch + "/" + file.split("/")[0]); return { status: r.status }; }
    const text = r.text();
    const d = openBox(text);
    if (!d) { console.log("[dbg] feed: NO ABRE " + branch + "/" + file.split("/")[0]); return { status: r.status }; }
    return { d, kb: Math.round(text.length / 1024) };
  };
  if (!dataMissing()) {
    const a = await one(DATA_BRANCH, dataPath);
    if (a.d) return accept(a.d, a.kb);
    if (a.late) return null;
    const b = await one(MAIN_BRANCH, path);
    const out = b.d ? accept(b.d, b.kb) : null;
    if (out && a.status === 404) noteDataMissing();
    return out;
  }
  const b = await one(MAIN_BRANCH, path);
  return b.d ? accept(b.d, b.kb) : null;
}

// The published set's list on `data` (scripts/feed-set.mjs metaOf; no secret): { v: 1, at, maxAgeMs, files: { "<path>":
// { builtAt, carried? } } }, every feed of the set at its path ("home/<key>[.<lang>].enc.json", "live/<key>.enc.json", and
// their ".v2.enc.json" copies). Asked once per runtime: the first run's race tries the accounts with a feed first.
const META_FILE = "data-meta.json";
let metaRun = null; // { of: the kino of the runtime that asked, p: its answer }

/**
 * The feeds published now, as their v1 paths (a v2 copy counts as its v1 path), minus any the readers would drop for age;
 * null when the list could not be read (no `data` branch, a timeout, an answer that is not the list). Never throws.
 * opts.timeoutMs: the request's timeout. One request per runtime, whatever it gave.
 */
export function publishedFeeds(opts = {}) {
  if (!metaRun || metaRun.of !== kino) metaRun = { of: kino, p: readMeta(opts).catch(() => null) };
  return metaRun.p;
}

async function readMeta(opts) {
  const init = { headers: { Accept: "application/json" }, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) };
  const r = await kino.fetch(`${REPO}${DATA_BRANCH}/${META_FILE}?v=${Math.floor(Date.now() / 3600000)}`, init);
  if (!r.ok) return null;
  const m = r.json();
  if (!m || m.v !== 1 || !m.files || typeof m.files !== "object") return null;
  const maxAge = Math.min(Number(m.maxAgeMs) || MAX_AGE_MS, MAX_AGE_MS);
  const out = new Set();
  for (const [path, f] of Object.entries(m.files)) {
    const age = Date.now() - Number(f && f.builtAt);
    if (age >= 0 && age < maxAge) out.add(path.replace(/\.v2\.enc\.json$/, ".enc.json"));
  }
  return out;
}

/** Whether [paths] (publishedFeeds) hold a Home feed fetchHomeFeed would read for server [key] in language [lang]. */
export function hasHomeFeed(paths, key, lang) {
  if (!paths || !key) return false;
  if ((lang === "es-419" || lang === "es-ES") && paths.has(`home/${key}.${lang}.enc.json`)) return true;
  return paths.has(`home/${key}.enc.json`);
}

// Deja una pestaña `{slides, rows}` solo con filas válidas (id/title/items), o null si no sirve.
function tabOf(t) {
  if (!t || !Array.isArray(t.rows)) return null;
  const rows = t.rows.filter((r) => r && typeof r.id === "string" && typeof r.title === "string" && Array.isArray(r.items) && r.items.length);
  if (!rows.length) return null;
  return { slides: Array.isArray(t.slides) ? t.slides : [], rows, cats: Array.isArray(t.cats) ? t.cats : [] };
}

/**
 * El Home pre-armado del servidor, o null (sin feed, viejo, no coincide, o falló): `{ lang, langs, slides, rows, movies, series }`.
 * Esquema v1: `slides`/`rows` = Inicio (lo que leen los lectores viejos). `movies`/`series` son campos extra (cada uno
 * `{slides, rows, cats}` o null) que los lectores viejos ignoran; aquí se usan para pintar esas pestañas al instante.
 * opts.until: a deadline for its requests (ms since the epoch), for a caller inside a time-boxed call.
 */
export async function fetchHomeFeed(serverKey, lang, opts) {
  if (!serverKey) return null;
  const until = (opts && opts.until) || 0;
  // es-419 y es-ES tienen feed propio (<key>.<lang>.enc.json); el resto (y si ese archivo falta) usa el por defecto.
  if (lang === "es-419" || lang === "es-ES") {
    const own = await fetchFeedFile(serverKey, serverKey + "." + lang, until);
    if (own && own.lang === lang) return own;
  }
  return fetchFeedFile(serverKey, serverKey, until);
}

async function fetchFeedFile(serverKey, name, until) {
  try {
    // El `v` por hora evita una caché de CDN demasiado pegajosa sin pedir siempre de nuevo.
    return await fetchSealed(`home/${encodeURIComponent(name)}.enc.json`, Math.floor(Date.now() / 3600000), (d, kb) => {
      if (d.v !== 1 || d.serverKey !== serverKey || !Array.isArray(d.rows) || !d.rows.length) { console.log("[dbg] homefeed: contenido no valido v=" + d.v + " serverKey=" + d.serverKey + " esperado=" + serverKey + " rows=" + (Array.isArray(d.rows) ? d.rows.length : "n/a")); return null; }
      if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) { console.log("[dbg] homefeed: VIEJO " + Math.round((Date.now() - d.at) / 36e5) + " h"); return null; }
      const home = tabOf({ slides: d.slides, rows: d.rows }); // Inicio (compat v1: slides/rows están arriba)
      if (!home) { console.log("[dbg] homefeed: tabOf(home) vacio"); return null; }
      console.log("[dbg] homefeed: OK key=" + serverKey + " lang=" + d.lang + " home=" + home.rows.length + " movies=" + (d.movies && d.movies.rows ? d.movies.rows.length : 0) + " series=" + (d.series && d.series.rows ? d.series.rows.length : 0) + " " + kb + "KB");
      return {
        lang: typeof d.lang === "string" ? d.lang : null,
        langs: Array.isArray(d.langs) ? d.langs : [],
        slides: home.slides,
        rows: home.rows,
        movies: tabOf(d.movies), // null en feeds v1
        series: tabOf(d.series),
      };
    }, until);
  } catch (e) { console.log("[dbg] homefeed: EXCEPCION " + (e && e.message)); return null; }
}

/**
 * La primera pantalla de En vivo pre-armada del servidor (filas de canales por categoría), refrescada ~1x/día: `{ rails }`,
 * o null (sin feed, viejo, no coincide, o falló). Cambiar de categoría en la app sigue haciendo la consulta en vivo normal.
 * opts.until: as for fetchHomeFeed.
 */
export async function fetchLiveFeed(serverKey, opts) {
  if (!serverKey) return null;
  try {
    // Cache-bust por día (el feed de En vivo se regenera 1x/día): basta con refrescar la CDN una vez al día.
    return await fetchSealed(`live/${encodeURIComponent(serverKey)}.enc.json`, Math.floor(Date.now() / 86400000), (d) => {
      if (d.v !== 1 || d.serverKey !== serverKey || !Array.isArray(d.rails) || !d.rails.length) return null;
      if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
      const rails = d.rails.filter((r2) => r2 && typeof r2.id === "string" && typeof r2.title === "string" && Array.isArray(r2.items) && r2.items.length);
      return rails.length ? { rails } : null;
    }, (opts && opts.until) || 0);
  } catch (_) { return null; }
}
