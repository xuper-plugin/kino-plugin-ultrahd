// Cuántas categorías reales cubre la tabla y cuántas caen al respaldo automático. Prueba además una categoría inventada.
// node scripts/check-categories.mjs [volcado.json]   (sin argumento pide las categorías a los servidores)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { mergeVod, mergeLive } = await import(pathToFileURL(join(root, "src", "categories.js")).href);

let file = process.argv[2];
if (!file) {
  file = join(tmpdir(), `uhd-cats-check-${Date.now()}.json`);
  execFileSync(process.execPath, [join(root, "scripts", "fetch-categories.mjs"), file], { stdio: ["ignore", "inherit", "inherit"] });
}
const dump = JSON.parse(readFileSync(file, "utf8"));
const listOf = (o) => Object.entries(o).map(([id, c]) => ({ category_id: id, category_name: c.name }));
const liveList = Object.entries(dump.live).map(([name, c], n) => ({ category_id: String(9000 + n), category_name: name }));

const report = (label, all, shown) => {
  const known = shown.filter((c) => c.known).length;
  console.log(`${label.padEnd(8)} reales ${String(all).padStart(3)} | visibles ${String(shown.length).padStart(3)} (tabla ${known}, respaldo automático ${shown.length - known}) | ocultas/18+ ${all - shown.length}`);
};
for (const kind of ["vod", "series"]) {
  const list = listOf(dump[kind]);
  report(kind, list.length, mergeVod(kind, list, { showAdult: false }));
  report(kind + "+18", list.length, mergeVod(kind, list, { showAdult: true }));
}
report("live", liveList.length, mergeLive(liveList, { showAdult: false }));
report("live+18", liveList.length, mergeLive(liveList, { showAdult: true }));

// Una categoría nueva que la tabla no conoce: debe aparecer, con nombre limpio, idioma y país deducidos.
const vodNew = mergeVod("vod", [...listOf(dump.vod), { category_id: "999991", category_name: "MARATÓN NAVIDEÑO - (CAST)" }], {}).find((c) => c.id === "999991");
const seriesNew = mergeVod("series", [...listOf(dump.series), { category_id: "999992", category_name: "TURCAS NUEVAS (LAT)" }], {}).find((c) => c.id === "999992");
const liveNew = mergeLive([...liveList, { category_id: "999993", category_name: "★ ★   C H I L E   D E P O R T E S   ★ ★" }], {}).find((c) => c.id === "999993");
console.log("inventada vod   :", JSON.stringify(vodNew && { title: vodNew.title, lang: vodNew.lang, group: vodNew.group, known: vodNew.known }));
console.log("inventada series:", JSON.stringify(seriesNew && { title: seriesNew.title, lang: seriesNew.lang, group: seriesNew.group, known: seriesNew.known }));
console.log("inventada live  :", JSON.stringify(liveNew && { title: liveNew.title, country: liveNew.country, genre: liveNew.genre, group: liveNew.group, known: liveNew.known }));
const bad = !vodNew || vodNew.known || vodNew.title !== "Maratón Navideño" || vodNew.lang !== "es-ES" || !liveNew || liveNew.title !== "Chile Deportes" || liveNew.country !== "CL";
console.log(bad ? "FALLA: una categoría inventada no salió bien" : "OK: una categoría inventada aparece con nombre limpio");
process.exitCode = bad ? 1 : 0;
