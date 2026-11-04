// Genera src/categoryTable.js (la tabla de categorías curada) a partir de las categorías reales de los servidores.
// node scripts/gen-categories.mjs            pide las categorías a los servidores HTTPS que respondan (scripts/fetch-categories.mjs)
// node scripts/gen-categories.mjs --from f   usa un volcado ya hecho (f = salida de fetch-categories.mjs)
// La tabla guarda solo nombres e ids de categoría, nunca títulos de películas ni credenciales.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => pathToFileURL(join(root, "src", f)).href;
const { cleanCategoryName, isAdultName, titleCase, prettyLiveTitle, countryOf, liveGenreOf, LANG_ORDER } = await import(src("names.js"));
const { groupOf, orderOf, liveGroupOf, liveOrderOf, normKey, isHidden } = await import(src("categoryRules.js"));

const fromIdx = process.argv.indexOf("--from");
let dump;
if (fromIdx > 0) dump = JSON.parse(readFileSync(process.argv[fromIdx + 1], "utf8"));
else {
  const tmp = join(tmpdir(), `uhd-cats-${Date.now()}.json`);
  execFileSync(process.execPath, [join(root, "scripts", "fetch-categories.mjs"), tmp], { stdio: ["ignore", "inherit", "inherit"] });
  dump = JSON.parse(readFileSync(tmp, "utf8"));
}

function vodTable(kind, cats) {
  const out = [];
  for (const [id, { name, i }] of Object.entries(cats)) {
    const { title, lang } = cleanCategoryName(name);
    const { group, rank } = groupOf(kind, title);
    const hide = isHidden(name);
    const adult = isAdultName(name);
    const home = !hide && !adult && lang === "es-419" &&
      ((kind === "vod" && ((group === "estrenos" && rank <= 1) || (group === "generos" && rank < 5))) || (kind === "series" && group === "plataformas" && rank < 4));
    out.push([id, [titleCase(title), lang, group, orderOf(kind, group, rank, i), `${hide ? "h" : ""}${adult ? "a" : ""}${home ? "H" : ""}`]]);
  }
  return out.sort((a, b) => a[1][3] - b[1][3] || LANG_ORDER.indexOf(a[1][1]) - LANG_ORDER.indexOf(b[1][1]));
}

function liveTable(cats) {
  const out = new Map();
  for (const [name, { i }] of Object.entries(cats)) {
    const title = prettyLiveTitle(name);
    const key = normKey(title);
    if (!key || out.has(key)) continue;
    const country = countryOf(title) || countryOf(name) || "";
    const genre = liveGenreOf(title) || liveGenreOf(name) || "";
    const group = liveGroupOf(title, country, genre);
    out.set(key, [title, country, genre, group, liveOrderOf(group, i), `${isHidden(name) ? "h" : ""}${isAdultName(name) ? "a" : ""}`]);
  }
  return [...out.entries()].sort((a, b) => a[1][4] - b[1][4]);
}

const line = (k, v) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`;
const vod = vodTable("vod", dump.vod);
const series = vodTable("series", dump.series);
const live = liveTable(dump.live);

const text = `// TABLA DE CATEGORÍAS (curación). Generada por scripts/gen-categories.mjs: no se edita a mano, se regenera.
// Se cruza con la lista real que pide el servidor; lo que la tabla no conoce se muestra igual (respaldo automático).
// VOD y series van por category_id (estable). En vivo va por nombre normalizado (los ids cambian de un servidor a otro).
// banderas: h = oculta (CAM, prueba, temporal), a = 18+, H = candidata al Home.

// id: [título, idioma, grupo, orden, banderas]
export const VOD = {
${vod.map(([k, v]) => line(k, v)).join("\n")}
};

// id: [título, idioma, grupo, orden, banderas]
export const SERIES = {
${series.map(([k, v]) => line(k, v)).join("\n")}
};

// nombre normalizado: [título, país ISO, género, grupo, orden, banderas]
export const LIVE = {
${live.map(([k, v]) => line(k, v)).join("\n")}
};
`;
writeFileSync(join(root, "src", "categoryTable.js"), text);
console.error(`src/categoryTable.js: ${vod.length} VOD, ${series.length} series, ${live.length} en vivo, ${(text.length / 1024).toFixed(1)} KB`);
