// Prueba de extremo a extremo con RED REAL: descarga el índice publicado, lo vuelca al catálogo del kit, busca, y abre un
// resultado contra el servicio real. El catálogo del kit vive en memoria de este proceso (el SQLite de Kino no es este).
//   node scripts/e2e-real.mjs
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "uhd-e2e-"));
const { kino } = createKino(checked.manifest, { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env });
globalThis.kino = kino;
const cat = await import(pathToFileURL(join(root, "src", "catalog.js")).href);
const idx = await import(pathToFileURL(join(root, "src", "titleIndex.js")).href);
const lazy = await import(pathToFileURL(join(root, "src", "tmdbLazy.js")).href);

const ms = (t0) => Math.round(performance.now() - t0);
const hide = (u) => String(u).replace(/\/(movie|series|live)\/[^/]+\/[^/]+\//, "/$1/***/***/").replace(/^https?:\/\/[^/]+/, "https://<servidor>");
const log = (...a) => console.log(...a);

let t0 = performance.now();
idx.resetIndexStats();
log("1) primera instalación: indexStep desde raw.githubusercontent.com");
let r = await idx.indexStep({ budgetMs: 180000 });
const s = idx.indexStats();
log(`   resultado ${r} | ${ms(t0)} ms | descargas ${s.downloads} | upserts ${s.upserted} | catálogo ${await kino.catalog.count()} | rev ${(idx.indexStatus() || {}).rev}`);

for (const q of ["spider", "casa de papel", "avengers"]) {
  t0 = performance.now();
  const out = await cat.searchDetailed({ q });
  log(`2) buscar "${q}": ${ms(t0)} ms | ${out.items.length} resultados | parcial=${out.partial} | ${out.items.slice(0, 3).map((i) => `${i.title} (${i.year || "?"})`).join(" · ")}`);
}

log("3) abrir resultados contra el servicio real");
const movie = (await cat.searchDetailed({ q: "spider man" })).items.find((i) => i.kind === "movie");
t0 = performance.now();
const stream = await cat.resolve(movie.ref);
log(`   película "${movie.title}": ${ms(t0)} ms | ${hide(stream.url)}`);
const series = (await cat.searchDetailed({ q: "casa de papel" })).items.find((i) => i.kind === "series");
t0 = performance.now();
const eps = await cat.episodes(series.ref);
log(`   serie "${series.title}": ${ms(t0)} ms | ${eps.episodes.length} episodios en ${new Set(eps.episodes.map((e) => e.season)).size} temporadas`);
if (eps.episodes.length) log(`   resolve del 1.er episodio: ${hide((await cat.resolve(eps.episodes[0].ref)).url)}`);

t0 = performance.now();
idx.resetIndexStats();
r = await idx.indexStep({ budgetMs: 60000 });
log(`4) segunda vez: ${r} | ${ms(t0)} ms | descargas ${idx.indexStats().downloads}`);
log(`5) TMDB (sin clave en el kit): consultas ${JSON.stringify(lazy.tmdbStats())}`);
process.exit(0);
