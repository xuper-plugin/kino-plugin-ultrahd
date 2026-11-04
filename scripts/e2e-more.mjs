// Pestaña Películas: carga inicial y "Cargar más categorías" con red real.   node scripts/e2e-more.mjs
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);
const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "uhd-more-"));
const { kino } = createKino(checked.manifest, { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env });
globalThis.kino = kino;
const scr = await import(pathToFileURL(join(root, "src", "screen.js")).href);
let state = { tab: "movies", lang: "es-419" };
const ev = async (name, extra = {}) => { const r = await scr.screenEvent({ name, state, ...extra }); if (r && r.state) state = { ...state, ...r.state }; return r; };
const rowsNow = async () => { const t = await scr.screen({ state, route: { name: "main" }, device: "phone" }); return JSON.stringify(t).match(/"key":"rail-[^"]+"/g) || []; };
for (let i = 0; i < 6; i++) await ev("tick");
console.log("filas tras la carga inicial:", (await rowsNow()).length);
for (let k = 0; k < 3; k++) { await ev("more"); console.log("tras 'más' #" + (k + 1) + ":", (await rowsNow()).length); }
