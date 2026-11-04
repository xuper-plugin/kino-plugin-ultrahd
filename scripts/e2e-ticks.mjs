// Home de la pantalla con red real: cuenta los ticks y lo que tarda cada uno hasta que el índice queda listo.   node scripts/e2e-ticks.mjs
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "uhd-ticks-"));
const { kino } = createKino(checked.manifest, { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env });
globalThis.kino = kino;
const scr = await import(pathToFileURL(join(root, "src", "screen.js")).href);
const idx = await import(pathToFileURL(join(root, "src", "titleIndex.js")).href);
let state = { tab: "home", lang: "es-419" };
const times = [];
for (let i = 0; i < 40; i++) {
  const t0 = performance.now();
  const r = await scr.screenEvent({ name: "tick", state });
  const ms = Math.round(performance.now() - t0);
  if (!r) { console.log("sin más unidades tras", i, "ticks"); break; }
  state = { ...state, ...r.state };
  times.push(ms);
}
console.log("ticks:", times.length, "| ms por tick:", times.join(" "), "| máx", Math.max(...times));
console.log("índice pendiente:", idx.indexNeeded(), "|", await idx.indexLabel());
