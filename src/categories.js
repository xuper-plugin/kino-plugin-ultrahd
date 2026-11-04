// Cruza la lista real de categorías del servidor con la tabla curada. Funciones puras.
// Regla de oro: lo que el servidor devuelve y la tabla no conoce NUNCA se descarta: se muestra con el nombre limpio
// (respaldo automático) al final de su grupo. Solo se omiten las marcadas h (ocultas) y las 18+ con el interruptor apagado.
import { VOD, SERIES, LIVE } from "./categoryTable.js";
import { LANG_ORDER, cleanCategoryName, prettyLiveTitle } from "./names.js";
import { normKey, fallbackVod, fallbackLive, GROUPS } from "./categoryRules.js";

const langRank = (l) => {
  const i = LANG_ORDER.indexOf(l);
  return i < 0 ? LANG_ORDER.length : i; // es-419 va antes que es-ES
};

// Para buscar se recorren primero los géneros.
const SEARCH_GROUPS = ["generos", "estrenos", "plataformas", "canales", "otros"];

// [{ id, name, title, lang, group, order, home, adult, known }] ordenadas: idioma (LAT primero) y orden de la tabla.
export function mergeVod(kind, list, { showAdult = false, table = null } = {}) {
  const T = table || (kind === "vod" ? VOD : SERIES);
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    const id = String(c.category_id || "");
    const name = String(c.category_name || "").trim();
    if (!id || !name) return;
    const e = T[id];
    let cat;
    if (e && normKey(cleanCategoryName(name).title) === normKey(e[0])) {
      const [title, lang, group, order, flags] = e;
      if (flags.includes("h")) return;
      cat = { id, name, title, lang, group, order, home: flags.includes("H"), adult: flags.includes("a"), known: true };
      // La tabla vieja guardó "| NL | …" como Latino: el prefijo manda sobre la tabla.
      if (/^\s*\|/.test(name)) { const p = cleanCategoryName(name); cat.lang = p.lang; cat.title = p.title; cat.home = false; }
    } else cat = fallbackVod(kind, id, name, i);
    if (cat.adult && !showAdult) return;
    const key = cat.lang + "|" + normKey(cat.title);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cat);
  });
  return out.sort((a, b) => Number(a.adult) - Number(b.adult) || langRank(a.lang) - langRank(b.lang) || a.order - b.order);
}

export const searchOrder = (cats) => [...cats].sort((a, b) =>
  Number(a.adult) - Number(b.adult) || langRank(a.lang) - langRank(b.lang) || SEARCH_GROUPS.indexOf(a.group) - SEARCH_GROUPS.indexOf(b.group) || a.order - b.order);

// Home: primero las candidatas marcadas H, luego el resto en su orden.
export const homeOrder = (cats) => [...cats.filter((c) => c.home && !c.adult), ...cats.filter((c) => !(c.home && !c.adult) && !c.adult)];

// En vivo: por nombre normalizado. [{ id, name, title, country, genre, group, order, adult, known }]
export function mergeLive(list, { showAdult = false } = {}) {
  const seen = new Map();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    const id = String(c.category_id || "");
    const name = String(c.category_name || "").trim();
    if (!id || !name) return;
    const key = normKey(prettyLiveTitle(name));
    const e = LIVE[key];
    let cat;
    if (e) {
      const [title, country, genre, group, order, flags] = e;
      if (flags.includes("h")) return;
      cat = { id, name, title, country, genre, group, order, adult: flags.includes("a"), known: true };
    } else cat = { id, ...fallbackLive(name, i) };
    if (cat.adult && !showAdult) return;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) cat.title = `${cat.title} (${n})`;
    out.push(cat);
  });
  return out.sort((a, b) => a.order - b.order);
}

export { GROUPS };
