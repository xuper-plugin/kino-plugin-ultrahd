// Builds, for each account of the service, a prebuilt Home (plan + rows + hero per tab, one feed per Spanish variant) and
// the first screen of En vivo, sealed with FEED_KEY. The Action (.github/workflows/home.yml) runs it 3 times a day; En vivo
// is rebuilt about once a day (LIVE_TTL_MS). It writes the COMPLETE current set into --out: what it built now plus the
// previous set's files carried forward (scripts/feed-set.mjs); the Action force-pushes that to the `data` branch and copies
// what --main still needs for installed versions that read only `main`. The plugin pulls its account's file and paints at once.
// Each feed also gets its v2 copy (<path>.v2.enc.json: gzip before sealing, only on `data`; contract in scripts/feed-set.mjs).
// Reuses EXACTLY the catalog's functions (same result as the live load), through the kit.
//   FEED_KEY=<64 hex> [KINO_TMDB_KEY=...] node scripts/gen-home.mjs --out <empty dir> [--prev <previous set>]
//     [--main <main checkout> --main-plan <file>] [--main-every-h 36] [--only <host>] [--servers N] [--max-panel-requests N]
// Nothing here touches git: a run with --out in a temp dir and a throwaway FEED_KEY is a dry run.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as feedSet from "./feed-set.mjs";

// Al re-crear el kino por servidor, un kino.sleep pendiente del servidor anterior (rate-limit de TMDB) puede rechazar tarde:
// es inofensivo (una espera de un servidor ya terminado), no debe tumbar el build.
process.on("unhandledRejection", () => {});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));

const arg = (name, def) => feedSet.argOf(process.argv, name, def);
const dirArg = (name) => { const v = arg(name, ""); return v ? resolve(process.cwd(), v) : null; };
const MAX_SERVERS = parseInt(arg("servers", "99"), 10);
const OUT = dirArg("out");
const PREV = dirArg("prev");
const MAIN = dirArg("main");
const MAIN_PLAN = dirArg("main-plan");
const ONLY = arg("only", "").trim().toLowerCase();
const MAIN_EVERY_MS = arg("main-every-h", "") !== "" ? Number(arg("main-every-h")) * 3600000 : feedSet.MAIN_EVERY_MS;
const SUBDIRS = ["home", "live"];
if (!OUT || !Number.isFinite(MAIN_EVERY_MS)) {
  console.error("usage: node scripts/gen-home.mjs --out <empty dir> [--prev <dir>] [--main <dir> --main-plan <file>] [--main-every-h H] [--only <host>] [--servers N] [--max-panel-requests N]");
  process.exit(2);
}
// --out holds exactly this run's set (the Action publishes it as is), so it must start with no feeds in it.
if (feedSet.feedPaths(OUT, SUBDIRS).length) { console.error("--out already holds feeds: give it an empty directory"); process.exit(2); }
const OUT_DIR = join(OUT, "home");
const LIVE_DIR = join(OUT, "live");
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
// Requests are counted (totals only, never URLs) so the log shows what each phase spends against the harness cap.
// --max-panel-requests N (local runs): past N, a panel request fails like a dead panel, so a test never hammers a panel.
const counter = { all: 0, panel: 0 };
const MAX_PANEL = parseInt(arg("max-panel-requests", "0"), 10) || 0;
const countingFetch = (url, init) => {
  const isPanel = String(url && url.href ? url.href : url).includes("/player_api.php");
  if (isPanel && MAX_PANEL && counter.panel >= MAX_PANEL) return Promise.reject(new Error("--max-panel-requests reached"));
  counter.all++;
  if (isPanel) counter.panel++;
  return fetch(url, init);
};
const kinoOpts = { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env, fetchImpl: countingFetch };
let harness = null;
const freshKino = () => { harness = createKino(checked.manifest, kinoOpts); globalThis.kino = harness.kino; };
freshKino();
// The harness allows 60 requests per "call" and counts them per instance: in Kino every plugin call gets its own 60, but
// one account's build here is several calls in a row (default feed, each Spanish variant, En vivo). Without a reset the
// later phases ran out (Ultra HD's En vivo died for 19 of 20 accounts once the Spanish variants came in, 2026-11-13).
// Each phase starts with a full budget; the returned function says what that phase spent.
const phase = () => {
  harness.resetBudget();
  const all = counter.all, panel = counter.panel;
  return () => `${counter.all - all} requests, ${counter.panel - panel} to the panel`;
};
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
// Sealing and opening (v1: { v:1, iv:b64(12B), data:b64(ciphertext+tag16) }, the format of seedBox.js; v2: the same with
// "v": 2 over the gzip of the JSON) live in scripts/feed-set.mjs, shared with SuperTV.

// What a feed's v2 copy carries: the same object. Ultra HD's screens draw a feed row as one titleRail node (its cards are
// not nodes), so its Home stays far under Kino's 600 nodes without a cap.
const v2Of = (_path, obj) => obj;

// The `at` sealed in [dir]/[path] when it opens with this key as the version its name says and belongs to the key its name
// says; else null.
const atIn = (dir) => (path) => feedSet.sealedAt(dir, path, KEY);

// En vivo is rebuilt only when the previous set's file is missing or >= 20 h old (about once a day at 3 runs a day); a
// fresh one is carried forward as it is.
function liveIsFresh(key) {
  if (!PREV) return false;
  const at = atIn(PREV)(`live/${key}.enc.json`);
  return at !== null && Date.now() - at < LIVE_TTL_MS;
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(LIVE_DIR, { recursive: true });
const list = await cat.serverList();
const items = list.items || [];
const hostIs = (h) => { const x = String(h || "").toLowerCase(); return x === ONLY || x.split(":")[0] === ONLY; };
// --only <host>: just that host's accounts (a local dry run against one server). Otherwise the first MAX_SERVERS, as always.
const order = ONLY
  ? items.filter((x) => hostIs(x.host)).map((x) => x.i).slice(0, MAX_SERVERS)
  : Array.from({ length: Math.min(items.length, MAX_SERVERS) }, (_, i) => i);
if (ONLY && !order.length) console.log(`--only ${ONLY}: no account on that host (hosts: ${[...new Set(items.map((x) => x.host))].join(", ")})`);
console.log(`servidores a procesar: ${order.length} de ${items.length}`);
let ok = 0, empty = 0, fail = 0;
const builtKeys = new Set();
const written = new Map(); // relative path -> the `at` sealed in it, for each feed this run wrote
const superseded = new Set(); // paths that no longer apply: a Spanish variant the account does not have (or that is its default)
// api() fails over to another account when one request fails, so a phase can end on another account than the one it began
// on: what it built then carries that account's serverKey, and the readers reject it under this key's name. Such a result is
// never published (the previous set's copy is carried forward instead) and the account's later phases are skipped, since
// they would build for the other account.
const moved = (key) => cat.serverKey() !== key;
const kb = (n) => Math.round(n / 1024);
// Writes the feed (v1) and its v2 copy, both of the same build. -> "<v1 KB> KB, v2 <KB> KB" for the log.
const put = (path, obj) => {
  if (!obj || obj.serverKey !== feedSet.keyOfPath(path)) throw new Error("not published: " + path + " was built for another account");
  const enc = feedSet.sealFeed(obj, KEY, 1);
  const enc2 = feedSet.sealFeed(v2Of(path, obj), KEY, 2);
  writeFileSync(join(OUT, path), enc);
  writeFileSync(join(OUT, feedSet.v2PathOf(path)), enc2);
  written.set(path, obj.at);
  written.set(feedSet.v2PathOf(path), obj.at);
  return `${kb(enc.length)} KB, v2 ${kb(enc2.length)} KB`;
};
for (const i of order) {
  const t0 = performance.now();
  try {
    freshKino(); // resetea los límites del shim para este servidor
    const sel = await cat.selectServer(i);
    if (!sel.ok) { console.log(`#${i + 1} (${ms(t0)} ms): servidor no responde, se salta`); fail++; continue; }
    if (ONLY && !hostIs(sel.host)) { console.log(`#${i + 1}: answered from another host (${sel.host}), skipped`); continue; }
    const key = cat.serverKey();
    if (builtKeys.has(key)) { console.log(`#${i + 1} ${key}: ya generado (mismo servidor), se salta`); continue; }
    builtKeys.add(key);
    let spent = phase();
    const home = await buildServer();
    if (!home) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): sin contenido (${spent()})`); empty++; continue; }
    if (moved(key) || home.serverKey !== key) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): the build moved to another account midway; not published, the previous copy stays (${spent()})`); fail++; continue; }
    const size = put(`home/${key}.enc.json`, home);
    const homeSpent = spent();
    let away = false; // a later phase moved to another account: the rest of this account is skipped
    // Un feed por variante de español: es-419 (Latino) y es-ES (España) tienen su propio catálogo; el feed por defecto es "es"
    // (unión de ambos). El plugin pide <key>.<lang>.enc.json según el idioma elegido y cae al por defecto si no existe.
    for (const L of PER_LANG) {
      const variant = `home/${key}.${L}.enc.json`;
      if (L === home.lang || !(home.langs || []).includes(L)) { superseded.add(variant); continue; }
      if (away) continue;
      spent = phase();
      try {
        const h = await buildServer(L);
        if (moved(key)) { away = true; console.log(`   ${L}: moved to another account midway; not published (${spent()})`); }
        else if (h && h.lang === L && h.rows.length) {
          const s = put(variant, h);
          console.log(`   ${L}: ${h.rows.length} filas, ${s} -> ${key}.${L}.enc.json (${spent()})`);
        } else console.log(`   ${L}: sin contenido propio (${spent()})`);
      } catch (e) { away = moved(key); console.log(`   ${L}: error ${feedSet.cleanError(e)} (${spent()})`); }
    }
    console.log(`#${i + 1} ${key} (${ms(t0)} ms): ${home.rows.length} filas, ${home.slides.length} slides, ${size} -> ${key}.enc.json (${homeSpent})`);
    ok++;
    // En vivo: ~1x/día. Si el archivo es reciente, se conserva (pasa tal cual al conjunto nuevo); si no, se rehornea.
    if (away) console.log(`   en vivo: skipped (the build moved to another account)`);
    else if (liveIsFresh(key)) { console.log(`   en vivo: reciente, se conserva`); }
    else {
      spent = phase();
      try {
        const live = await buildLive();
        if (moved(key)) console.log(`   en vivo: moved to another account midway; not published (${spent()})`);
        else if (live) { const s = put(`live/${key}.enc.json`, live); console.log(`   en vivo: ${live.rails.length} filas, ${s} -> live/${key}.enc.json (${spent()})`); }
        else console.log(`   en vivo: sin canales (${spent()})`);
      } catch (e) { console.log(`   en vivo: error ${feedSet.cleanError(e)} (${spent()})`); }
    }
  } catch (e) { console.log(`#${i + 1} (${ms(t0)} ms): error ${feedSet.cleanError(e)}`); fail++; }
}
console.log(`\nlisto: ${ok} ok, ${empty} vacíos, ${fail} fallos.`);
if (!ok) console.log("::warning::no account was built in this run; only the previous set's younger feeds are kept");

// The complete current set: what this run wrote plus the previous set's files carried forward (scripts/feed-set.mjs), and
// a v2 copy for each carried feed that lacks one of the same build.
const now = Date.now();
const prevPaths = PREV ? feedSet.feedPaths(PREV, SUBDIRS) : [];
const { carry, drop, derive } = feedSet.carryPlan({ prevPaths, written, superseded, atOf: PREV ? atIn(PREV) : () => null, now });
feedSet.copyFeeds(PREV, OUT, carry.map((c) => c.path));
const made = feedSet.deriveV2({ dir: OUT, derive, key: KEY, v2Of });
const set = new Map([...written, ...carry.map((c) => [c.path, c.at]), ...made]);
const carried = new Set([...carry.map((c) => c.path), ...derive.filter((d) => made.has(d.path) && !written.has(d.from)).map((d) => d.path)]);
const sizes = feedSet.sizesOf(OUT, set.keys());
writeFileSync(join(OUT, feedSet.META), JSON.stringify(feedSet.metaOf({ set, carried, derived: new Set(made.keys()), sizes, now }), null, 1) + "\n");
const why = (w) => drop.filter((d) => d.why === w).length;
console.log(`set: ${set.size} files (${written.size} built, ${carry.length} carried forward, ${made.size} v2 copies made from a carried feed); dropped ${drop.length} (${why("expired")} expired, ${why("superseded")} superseded, ${why("unreadable")} unreadable, ${why("mismatched")} v2 of another build)`);
const win = feedSet.sizeWin(set, sizes);
if (win.files) console.log(`v2: ${win.files} feeds, ${kb(win.v2)} KB against ${kb(win.v1)} KB in v1 (${Math.round((100 * win.v2) / win.v1)} %)`);

// What `main` still needs for the installed versions that read only `main`.
if (MAIN) {
  const plan = feedSet.mainPlan({ set, mainPaths: feedSet.feedPaths(MAIN, SUBDIRS), mainAtOf: atIn(MAIN), superseded, now, everyMs: MAIN_EVERY_MS });
  if (MAIN_PLAN) writeFileSync(MAIN_PLAN, feedSet.planLines(plan).map((l) => l + "\n").join(""));
  console.log(`main: ${plan.write.length} to rewrite, ${plan.remove.length} to remove (copies older than ${Math.round(MAIN_EVERY_MS / 3600000)} h are rewritten; v2 copies never go there)`);
}
