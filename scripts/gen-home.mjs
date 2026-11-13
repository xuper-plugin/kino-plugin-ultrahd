// Genera, por cada servidor, un Home pre-armado (plan + filas + hero) y lo escribe en home/<serverKey>.json.
// Lo corre un Action dos veces al día; el plugin baja el JSON de su servidor y pinta el Home al instante.
// Reusa EXACTAMENTE las funciones del catálogo (mismo resultado que la carga en vivo), a través del kit.
//   KINO_TMDB_KEY=... node scripts/gen-home.mjs [--servers N] [--out home]
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// Al re-crear el kino por servidor, un kino.sleep pendiente del servidor anterior (rate-limit de TMDB) puede rechazar tarde:
// es inofensivo (una espera de un servidor ya terminado), no debe tumbar el build.
process.on("unhandledRejection", () => {});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; };
const MAX_SERVERS = parseInt(arg("servers", "99"), 10);
const OUT_DIR = join(root, arg("out", "home"));
const LIVE_DIR = join(root, arg("live", "live"));
const LIVE_TTL_MS = 20 * 60 * 60 * 1000; // En vivo se rehornea ~1x/día: si el archivo tiene < 20 h, se conserva (menos carga a los servidores)
const LIVE_RAILS = 12;
const HOME_MOVIES = 7, HOME_SERIES = 4, RAIL_ITEMS = 20, FEATURED = 6;
const TAB_RAILS = 12; // filas por pestaña (Películas / Series)
// v:1 se mantiene (compatibilidad): los lectores viejos leen slides/rows (Inicio) e IGNORAN movies/series. Los nuevos (>=0.5.0)
// usan movies/series para pintar esas pestañas al instante. Agregar campos no rompe al lector v1 (rechaza por `v !== 1`).
const SCHEMA = 1;
const PER_LANG = ["es-419", "es-ES"]; // variantes de español con feed propio (además del por defecto)

const tmp = mkdtempSync(join(tmpdir(), "uhd-gen-"));
// Mismo storage para todas las instancias (comparte servidores/categorías, sin re-bootstrap); kino nuevo por servidor para
// RESETEAR los límites del shim (rate-limit de kino.tmdb, presupuestos), que si no se agotan tras un par de servidores.
const kinoOpts = { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env };
const freshKino = () => { globalThis.kino = createKino(checked.manifest, kinoOpts).kino; };
freshKino();
const cat = await import(pathToFileURL(join(root, "src", "catalog.js")).href);
const sv = await import(pathToFileURL(join(root, "src", "screenView.js")).href);
const { enrichTmdb } = await import(pathToFileURL(join(root, "src", "tmdbLazy.js")).href);

const ms = (t0) => Math.round(performance.now() - t0);

// Carga las filas de una pestaña (primeras `maxRails` categorías), con ítems completos (para hero) ya con póster de TMDB.
// `cats` es la lista COMPLETA de categorías del idioma (para el selector de categorías de la pestaña en el plugin).
async function buildTab(kind, maxRails, wantLang = null) {
  const plan = await cat.homeRailPlan(kind, 999, wantLang).catch(() => ({ cats: [], lang: null, langs: [] }));
  const lang = plan.lang;
  const rails = [];
  for (const c of plan.cats.slice(0, maxRails)) {
    const rail = await cat.oneRail(kind, c.id, RAIL_ITEMS, lang);
    if (!rail || !rail.items || !rail.items.length) continue;
    await enrichTmdb(rail.items, { max: 16, budgetMs: 8000 }).catch(() => {}); // pósters/ids de TMDB (sin prisa, es un build)
    rails.push({ ...rail, items: rail.items.map(cat.withFicha) });
  }
  // El selector de categorías del plugin muestra hasta 200: no vale la pena cargar el feed con más.
  return { lang, langs: plan.langs || [], rails, cats: (plan.cats || []).slice(0, 200) };
}

// Las tarjetas de las filas NO llevan sinopsis (solo los slides la necesitan): sin eso el archivo pesa mucho menos.
const toRows = (rails) => rails.map((r) => ({ id: r.id, title: r.title, ref: r.ref, items: r.items.map(sv.cardOf).map(({ overview, ...c }) => c) }));

// Hero de una pestaña: backdrop+sinopsis de la ficha IPTV de unos candidatos (uno por fila), luego se arman los slides.
async function heroFor(kind, rails) {
  const cands = rails.map((r) => r.items[0]).filter(Boolean);
  if (cands.length) await cat.enrichFeatured(kind, cands, 10).catch(() => {});
  const slides = [];
  for (const r of rails) {
    const refreshed = { ...r, items: r.items.map(cat.withFicha) };
    for (const s of sv.slidesOf([refreshed])) if (slides.length < FEATURED && !slides.some((x) => x.id === s.id)) slides.push(s);
  }
  return slides;
}

// Un servidor: arma las pestañas Películas y Series (12 filas c/u) y deriva Inicio (7 pelis + 4 series). null si nada cargó.
async function buildServer(wantLang = null) {
  const mv = await buildTab("vod", TAB_RAILS, wantLang);
  const sr = await buildTab("series", TAB_RAILS, wantLang);
  if (!mv.rails.length && !sr.rails.length) return null;
  const lang = mv.lang || sr.lang;
  const langs = (mv.langs && mv.langs.length ? mv.langs : sr.langs) || [];

  const movies = { slides: await heroFor("vod", mv.rails), rows: toRows(mv.rails), cats: mv.cats };
  const series = { slides: await heroFor("series", sr.rails), rows: toRows(sr.rails), cats: sr.cats };

  // Inicio = mezcla: primeras HOME_MOVIES pelis + primeras HOME_SERIES series (sus fichas ya vienen enriquecidas).
  const homeRails = [...mv.rails.slice(0, HOME_MOVIES), ...sr.rails.slice(0, HOME_SERIES)];
  const homeSlides = [];
  for (const r of homeRails) for (const s of sv.slidesOf([{ ...r, items: r.items.map(cat.withFicha) }])) if (homeSlides.length < FEATURED && !homeSlides.some((x) => x.id === s.id)) homeSlides.push(s);

  // `slides`/`rows` arriba = Inicio (compatibilidad con lectores v1); `movies`/`series` = las pestañas (v2).
  return { v: SCHEMA, at: Date.now(), serverKey: cat.serverKey(), lang, langs, slides: homeSlides, rows: toRows(homeRails), movies, series };
}

// La primera pantalla de En vivo: una fila de canales por categoría (hasta LIVE_RAILS). Devuelve el objeto a publicar o null.
const channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", ...(i.logo ? { poster: i.logo } : {}), ...(i.adult ? { adult: true } : {}) });

// Solo se pre-arman los canales ESTABLES (iguales todo el día). Los EVENTOS del día (partidos con hora, "X vs Y", PPV, agenda)
// cambian de un momento a otro: cachearlos 1x/día los dejaría desfasados, así que se excluyen; esos se cargan en vivo normal.
const EVENT_CAT = /event|ppv|pay.?per.?view|agenda|jornada|cartelera|fecha\b|partidos?\b|deporte.*(vivo|hoy|evento)|24.?7.*event/i;
const EVENT_TITLE = /(\b\d{1,2}:\d{2}\b)|(\bvs\.?\b)|(\b\d{1,2}[/-]\d{1,2}\b)|(\bppv\b)|(\bfinal\b.*\d)/i;
function isEventRail(name, items) {
  if (EVENT_CAT.test(String(name || ""))) return true;
  if (!items.length) return false;
  const hits = items.filter((it) => EVENT_TITLE.test(it.title || "")).length;
  return hits / items.length >= 0.3; // muchas filas con hora/fecha/"vs" = categoría de eventos
}

async function buildLive() {
  const cats = (await cat.liveCategories()).slice(0, LIVE_RAILS * 2); // de más, porque se descartan las de eventos
  const rails = [];
  for (let i = 0; i < cats.length && rails.length < LIVE_RAILS; i += 3) {
    const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try { return { c, page: await cat.liveChannels({ categoryId: c.id }) }; } catch (_) { return null; }
    }));
    for (const r of batch) {
      if (!r || rails.length >= LIVE_RAILS) continue;
      const items = r.page.items.slice(0, RAIL_ITEMS).map(channelCard);
      if (!items.length) continue;
      if (isEventRail(r.c.title, items)) continue; // eventos del día: no se cachean (se desfasan)
      rails.push({ id: "lcat-" + r.c.id, title: r.c.title, ref: "lcat:" + r.c.id, items });
    }
  }
  return rails.length ? { v: 1, at: Date.now(), serverKey: cat.serverKey(), rails } : null;
}

// Clave AES-256 (hex) para sellar los feeds como Xuper (el plugin los abre con kino.secret("feedKey"); un fork no puede).
// En el Action viene del secret FEED_KEY; si falta, se aborta (NO se publica nada en claro).
const FEED_KEY = (process.env.FEED_KEY || "").trim();
if (!/^[0-9a-fA-F]{64}$/.test(FEED_KEY)) { console.error("Falta FEED_KEY (64 hex). No se genera nada en claro."); process.exit(2); }
const KEY = Buffer.from(FEED_KEY, "hex");
// Sella un objeto -> sobre { v:1, iv:b64(12B), data:b64(ciphertext+tag16) } (mismo formato que seedBox.js).
function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), data: Buffer.concat([ct, c.getAuthTag()]).toString("base64") });
}
// Abre un .enc.json (para la compuerta de edad de En vivo). null si no abre.
function openEnc(text) {
  try {
    const box = JSON.parse(text);
    const iv = Buffer.from(box.iv, "base64"), data = Buffer.from(box.data, "base64");
    const d = createDecipheriv("aes-256-gcm", KEY, iv); d.setAuthTag(data.subarray(data.length - 16));
    return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString("utf8"));
  } catch (_) { return null; }
}

// Rehornea En vivo solo si el archivo falta o tiene >= 20 h (así, con el Action cada 4 h, En vivo se actualiza ~1x/día).
function liveIsFresh(key) {
  try {
    const p = openEnc(readFileSync(join(LIVE_DIR, key + ".enc.json"), "utf8"));
    return !!(p && p.serverKey === key && Date.now() - (p.at || 0) < LIVE_TTL_MS);
  } catch (_) { return false; }
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(LIVE_DIR, { recursive: true });
const list = await cat.serverList();
const total = Math.min((list.items || []).length, MAX_SERVERS);
console.log(`servidores a procesar: ${total} de ${(list.items || []).length}`);
let ok = 0, empty = 0, fail = 0;
const index = [];
const builtKeys = new Set();
for (let i = 0; i < total; i++) {
  const t0 = performance.now();
  try {
    freshKino(); // resetea los límites del shim para este servidor
    const sel = await cat.selectServer(i);
    if (!sel.ok) { console.log(`#${i + 1} (${ms(t0)} ms): servidor no responde, se salta`); fail++; continue; }
    const key = cat.serverKey();
    if (builtKeys.has(key)) { console.log(`#${i + 1} ${key}: ya generado (mismo servidor), se salta`); continue; }
    builtKeys.add(key);
    const home = await buildServer();
    if (!home) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): sin contenido`); empty++; continue; }
    const enc = seal(home);
    writeFileSync(join(OUT_DIR, key + ".enc.json"), enc);
    // Un feed por variante de español: es-419 (Latino) y es-ES (España) tienen su propio catálogo; el feed por defecto es "es"
    // (unión de ambos). El plugin pide <key>.<lang>.enc.json según el idioma elegido y cae al por defecto si no existe.
    for (const L of PER_LANG) {
      if (L === home.lang || !(home.langs || []).includes(L)) continue;
      try {
        const h = await buildServer(L);
        if (h && h.lang === L && h.rows.length) {
          const e = seal(h);
          writeFileSync(join(OUT_DIR, key + "." + L + ".enc.json"), e);
          console.log(`   ${L}: ${h.rows.length} filas, ${Math.round(e.length / 1024)} KB -> ${key}.${L}.enc.json`);
        } else console.log(`   ${L}: sin contenido propio`);
      } catch (e) { console.log(`   ${L}: error ${e && e.message}`); }
    }
    index.push({ serverKey: key, at: home.at, rows: home.rows.length, slides: home.slides.length, bytes: enc.length });
    console.log(`#${i + 1} ${key} (${ms(t0)} ms): ${home.rows.length} filas, ${home.slides.length} slides, ${Math.round(enc.length / 1024)} KB -> ${key}.enc.json`);
    ok++;
    // En vivo: ~1x/día. Si el archivo es reciente, se conserva (no se toca); si no, se rehornea.
    if (liveIsFresh(key)) { console.log(`   en vivo: reciente, se conserva`); }
    else {
      const live = await buildLive().catch(() => null);
      if (live) { writeFileSync(join(LIVE_DIR, key + ".enc.json"), seal(live)); console.log(`   en vivo: ${live.rails.length} filas -> live/${key}.enc.json`); }
      else console.log(`   en vivo: sin canales`);
    }
  } catch (e) { console.log(`#${i + 1} (${ms(t0)} ms): error ${e && e.message}`); fail++; }
}
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify({ v: SCHEMA, at: Date.now(), servers: index }));
console.log(`\nlisto: ${ok} ok, ${empty} vacíos, ${fail} fallos. Índice: ${index.length} servidores.`);
