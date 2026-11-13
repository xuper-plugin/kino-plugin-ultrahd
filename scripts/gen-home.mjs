// Genera, por cada servidor, un Home pre-armado (plan + filas + hero) y lo escribe en home/<serverKey>.json.
// Lo corre un Action dos veces al día; el plugin baja el JSON de su servidor y pinta el Home al instante.
// Reusa EXACTAMENTE las funciones del catálogo (mismo resultado que la carga en vivo), a través del kit.
//   KINO_TMDB_KEY=... node scripts/gen-home.mjs [--servers N] [--out home]
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; };
const MAX_SERVERS = parseInt(arg("servers", "99"), 10);
const OUT_DIR = join(root, arg("out", "home"));
const HOME_MOVIES = 7, HOME_SERIES = 4, RAIL_ITEMS = 20, FEATURED = 6;
const SCHEMA = 1;

const tmp = mkdtempSync(join(tmpdir(), "uhd-gen-"));
const { kino } = createKino(checked.manifest, { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env });
globalThis.kino = kino;
const cat = await import(pathToFileURL(join(root, "src", "catalog.js")).href);
const sv = await import(pathToFileURL(join(root, "src", "screenView.js")).href);
const { enrichTmdb } = await import(pathToFileURL(join(root, "src", "tmdbLazy.js")).href);

const ms = (t0) => Math.round(performance.now() - t0);

// Un servidor: arma el Home (idioma por defecto) y devuelve el objeto a publicar, o null si no cargó nada.
async function buildServer() {
  const [mv, sr] = await Promise.all([
    cat.homeRailPlan("vod", HOME_MOVIES, null).catch(() => ({ cats: [], lang: null, langs: [] })),
    cat.homeRailPlan("series", HOME_SERIES, null).catch(() => ({ cats: [], lang: null, langs: [] })),
  ]);
  const lang = mv.lang || sr.lang;
  const langs = mv.langs && mv.langs.length ? mv.langs : sr.langs || [];
  const plan = [
    ...mv.cats.map((c) => ({ kind: "vod", id: c.id, title: c.title })),
    ...sr.cats.map((c) => ({ kind: "series", id: c.id, title: c.title })),
  ];
  const rows = [];
  const fullRails = []; // con ítems completos, para armar el hero
  for (const p of plan) {
    const rail = await cat.oneRail(p.kind, p.id, RAIL_ITEMS, lang);
    if (!rail || !rail.items || !rail.items.length) continue;
    await enrichTmdb(rail.items, { max: 16, budgetMs: 8000 }).catch(() => {}); // pósters/ids de TMDB (sin prisa, es un build)
    const full = { ...rail, items: rail.items.map(cat.withFicha) };
    fullRails.push(full);
    // Las tarjetas de las filas NO llevan sinopsis (solo los slides la necesitan): sin eso el archivo pesa mucho menos.
    rows.push({ id: full.id, title: full.title, ref: full.ref, items: full.items.map(sv.cardOf).map(({ overview, ...c }) => c) });
  }
  if (!rows.length) return null;
  // Hero: backdrop+sinopsis de la ficha IPTV de unos candidatos (uno por fila), luego se arman los slides.
  const oneEachVod = fullRails.filter((r) => r.id.startsWith("vod-")).map((r) => r.items[0]).filter(Boolean);
  const oneEachSr = fullRails.filter((r) => r.id.startsWith("series-")).map((r) => r.items[0]).filter(Boolean);
  if (oneEachVod.length) await cat.enrichFeatured("vod", oneEachVod, 10).catch(() => {});
  if (oneEachSr.length) await cat.enrichFeatured("series", oneEachSr, 6).catch(() => {});
  const slides = [];
  for (const r of fullRails) {
    const refreshed = { ...r, items: r.items.map(cat.withFicha) };
    for (const s of sv.slidesOf([refreshed])) if (slides.length < FEATURED && !slides.some((x) => x.id === s.id)) slides.push(s);
  }
  return { v: SCHEMA, at: Date.now(), serverKey: cat.serverKey(), lang, langs, slides, rows };
}

mkdirSync(OUT_DIR, { recursive: true });
const list = await cat.serverList();
const total = Math.min((list.items || []).length, MAX_SERVERS);
console.log(`servidores a procesar: ${total} de ${(list.items || []).length}`);
let ok = 0, empty = 0, fail = 0;
const index = [];
const builtKeys = new Set();
for (let i = 0; i < total; i++) {
  const t0 = performance.now();
  try {
    const sel = await cat.selectServer(i);
    if (!sel.ok) { console.log(`#${i + 1} (${ms(t0)} ms): servidor no responde, se salta`); fail++; continue; }
    const key = cat.serverKey();
    if (builtKeys.has(key)) { console.log(`#${i + 1} ${key}: ya generado (mismo servidor), se salta`); continue; }
    builtKeys.add(key);
    const home = await buildServer();
    if (!home) { console.log(`#${i + 1} ${key} (${ms(t0)} ms): sin contenido`); empty++; continue; }
    const file = join(OUT_DIR, key + ".json");
    writeFileSync(file, JSON.stringify(home));
    const bytes = JSON.stringify(home).length;
    index.push({ serverKey: key, at: home.at, rows: home.rows.length, slides: home.slides.length, bytes });
    console.log(`#${i + 1} ${key} (${ms(t0)} ms): ${home.rows.length} filas, ${home.slides.length} slides, ${Math.round(bytes / 1024)} KB -> ${key}.json`);
    ok++;
  } catch (e) { console.log(`#${i + 1} (${ms(t0)} ms): error ${e && e.message}`); fail++; }
}
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify({ v: SCHEMA, at: Date.now(), servers: index }));
console.log(`\nlisto: ${ok} ok, ${empty} vacíos, ${fail} fallos. Índice: ${index.length} servidores.`);
