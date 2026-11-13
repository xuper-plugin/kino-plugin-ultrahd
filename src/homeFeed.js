// Baja el Home pre-armado que el Action publica 2x/día en home/<serverKey>.json. Si existe y es reciente, el plugin pinta su
// Home al instante (sin recorrer el servidor IPTV); si falta, está viejo o el fetch falla, se usa la carga en vivo progresiva.
const BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd/main/home/";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo

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
    const r = await kino.fetch(`${BASE}${encodeURIComponent(serverKey)}.json?v=${Math.floor(Date.now() / 3600000)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const d = r.json();
    if (!d || d.v !== 1 || d.serverKey !== serverKey || !Array.isArray(d.rows) || !d.rows.length) return null;
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
    const home = tabOf({ slides: d.slides, rows: d.rows }); // Inicio (compat v1: slides/rows están arriba)
    if (!home) return null;
    return {
      lang: typeof d.lang === "string" ? d.lang : null,
      langs: Array.isArray(d.langs) ? d.langs : [],
      slides: home.slides,
      rows: home.rows,
      movies: tabOf(d.movies), // null en feeds v1
      series: tabOf(d.series),
    };
  } catch (_) { return null; }
}
