// Baja el Home pre-armado que el Action publica 2x/día en home/<serverKey>.json. Si existe y es reciente, el plugin pinta su
// Home al instante (sin recorrer el servidor IPTV); si falta, está viejo o el fetch falla, se usa la carga en vivo progresiva.
// Los feeds se publican SELLADOS (AES-256-GCM con el secreto feedKey, igual que Xuper): el plugin los abre con
// kino.secret("feedKey") — solo dentro de Kino; un fork con el código copiado no puede.
const BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd/main/home/";
const LIVE_BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd/main/live/";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo

// Abre el sobre sellado { v:1, iv:b64, data:b64 } con el secreto feedKey (AES-256-GCM). null si no abre. Nunca lanza.
function openBox(text) {
  let box = null;
  try { box = JSON.parse(text); } catch (_) { return null; }
  if (!box || typeof box !== "object" || box.v !== 1 || typeof box.iv !== "string" || typeof box.data !== "string") return null;
  try {
    return JSON.parse(kino.crypto.decrypt("aes-256-gcm", { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data }));
  } catch (_) { return null; }
}

// Deja una pestaña `{slides, rows}` solo con filas válidas (id/title/items), o null si no sirve.
function tabOf(t) {
  if (!t || !Array.isArray(t.rows)) return null;
  const rows = t.rows.filter((r) => r && typeof r.id === "string" && typeof r.title === "string" && Array.isArray(r.items) && r.items.length);
  if (!rows.length) return null;
  return { slides: Array.isArray(t.slides) ? t.slides : [], rows, cats: Array.isArray(t.cats) ? t.cats : [] };
}

/**
 * El Home pre-armado del servidor, o null (sin feed, viejo, no coincide, o falló): `{ lang, langs, slides, rows, movies, series }`.
 * Esquema v1: `slides`/`rows` = Inicio (lo que leen los lectores viejos). `movies`/`series` son campos extra (cada uno
 * `{slides, rows, cats}` o null) que los lectores viejos ignoran; aquí se usan para pintar esas pestañas al instante.
 */
export async function fetchHomeFeed(serverKey) {
  if (!serverKey) return null;
  try {
    // El `v` por hora evita una caché de CDN demasiado pegajosa sin pedir siempre de nuevo.
    const r = await kino.fetch(`${BASE}${encodeURIComponent(serverKey)}.enc.json?v=${Math.floor(Date.now() / 3600000)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) { console.log("[dbg] homefeed: HTTP no ok status=" + r.status + " key=" + serverKey); return null; }
    const d = openBox(r.text());
    if (!d) { console.log("[dbg] homefeed: NO ABRE (descifrado fallido o sobre invalido) key=" + serverKey); return null; }
    if (d.v !== 1 || d.serverKey !== serverKey || !Array.isArray(d.rows) || !d.rows.length) { console.log("[dbg] homefeed: contenido no valido v=" + d.v + " serverKey=" + d.serverKey + " esperado=" + serverKey + " rows=" + (Array.isArray(d.rows) ? d.rows.length : "n/a")); return null; }
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) { console.log("[dbg] homefeed: VIEJO " + Math.round((Date.now() - d.at) / 36e5) + " h"); return null; }
    const home = tabOf({ slides: d.slides, rows: d.rows }); // Inicio (compat v1: slides/rows están arriba)
    if (!home) { console.log("[dbg] homefeed: tabOf(home) vacio"); return null; }
    console.log("[dbg] homefeed: OK key=" + serverKey + " lang=" + d.lang + " home=" + home.rows.length + " movies=" + (d.movies && d.movies.rows ? d.movies.rows.length : 0) + " series=" + (d.series && d.series.rows ? d.series.rows.length : 0) + " " + Math.round(r.text().length / 1024) + "KB");
    return {
      lang: typeof d.lang === "string" ? d.lang : null,
      langs: Array.isArray(d.langs) ? d.langs : [],
      slides: home.slides,
      rows: home.rows,
      movies: tabOf(d.movies), // null en feeds v1
      series: tabOf(d.series),
    };
  } catch (e) { console.log("[dbg] homefeed: EXCEPCION " + (e && e.message)); return null; }
}

/**
 * La primera pantalla de En vivo pre-armada del servidor (filas de canales por categoría), refrescada ~1x/día: `{ rails }`,
 * o null (sin feed, viejo, no coincide, o falló). Cambiar de categoría en la app sigue haciendo la consulta en vivo normal.
 */
export async function fetchLiveFeed(serverKey) {
  if (!serverKey) return null;
  try {
    // Cache-bust por día (el feed de En vivo se regenera 1x/día): basta con refrescar la CDN una vez al día.
    const r = await kino.fetch(`${LIVE_BASE}${encodeURIComponent(serverKey)}.enc.json?v=${Math.floor(Date.now() / 86400000)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const d = openBox(r.text());
    if (!d || d.v !== 1 || d.serverKey !== serverKey || !Array.isArray(d.rails) || !d.rails.length) return null;
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
    const rails = d.rails.filter((r2) => r2 && typeof r2.id === "string" && typeof r2.title === "string" && Array.isArray(r2.items) && r2.items.length);
    return rails.length ? { rails } : null;
  } catch (_) { return null; }
}
