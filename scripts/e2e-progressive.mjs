// Prueba del Home progresivo (red real): salta el selector de servidor, corre los ticks y tras cada uno cuenta cuántas filas
// se ven en la pantalla, para comprobar que van apareciendo una a una (y mide el tiempo de cada tick).
//   node scripts/e2e-progressive.mjs
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "uhd-prog-"));
const storageFile = join(tmp, "s.json");
const { kino } = createKino(checked.manifest, { storageFile, cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env });
globalThis.kino = kino;
const scr = await import(pathToFileURL(join(root, "src", "screen.js")).href);

// Saltar el selector inicial de servidor: marcar que ya se eligió uno.
kino.storage.set("srvChosen:v1", "1");

function countRails(tree) {
  let n = 0, hero = 0;
  const walk = (x) => {
    if (x && typeof x === "object") {
      const t = x.type;
      if (t === "titleRail") n++;
      if (t === "heroCard" || (t === "pager")) hero++;
      for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
    }
  };
  walk(tree);
  return { rails: n, hero };
}

let state = { tab: "home", lang: "es-419" };
console.log("== primera carga (sin snapshot): las filas deben ir apareciendo ==");
for (let i = 0; i < 40; i++) {
  const t0 = performance.now();
  const r = await scr.screenEvent({ name: "tick", state });
  const ms = Math.round(performance.now() - t0);
  if (r && r.state) state = { ...state, ...r.state };
  const view = await scr.screen({ state, route: { name: "main" }, device: "tv", lang: "es" });
  const c = countRails(view);
  console.log(`tick ${String(i + 1).padStart(2)} (${String(ms).padStart(5)} ms)  filas visibles: ${c.rails}  hero: ${c.hero}`);
  if (!r) { console.log("— sin más unidades —"); break; }
}

// Segunda apertura: nuevo "runtime" (otro proceso simulado) reusando el MISMO storage -> debe pintar el snapshot al instante.
console.log("\n== reapertura (mismo storage, runtime nuevo): snapshot instantáneo ==");
const { kino: kino2 } = createKino(checked.manifest, { storageFile, cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env });
globalThis.kino = kino2;
const scr2 = await import(pathToFileURL(join(root, "src", "screen.js")).href + "?v=2");
kino2.storage.set("srvChosen:v1", "1");
const t1 = performance.now();
const first = await scr2.screen({ state: { tab: "home", lang: "es-419" }, route: { name: "main" }, device: "tv", lang: "es" });
console.log(`primer render SIN tocar red: ${Math.round(performance.now() - t1)} ms  filas: ${countRails(first).rails}  (del snapshot)`);
