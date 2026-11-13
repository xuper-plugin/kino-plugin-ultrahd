// Baja el Home pre-armado que el Action publica 2x/día en home/<serverKey>.json. Si existe y es reciente, el plugin pinta su
// Home al instante (sin recorrer el servidor IPTV); si falta, está viejo o el fetch falla, se usa la carga en vivo progresiva.
const BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd/main/home/";
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // tolera varias corridas perdidas; más viejo que esto -> se ignora y se carga en vivo

/** El Home pre-armado del servidor, o null (sin feed, viejo, no coincide, o falló): `{ lang, langs, slides, rows }`. */
export async function fetchHomeFeed(serverKey) {
  if (!serverKey) return null;
  try {
    // El `v` por hora evita una caché de CDN demasiado pegajosa sin pedir siempre de nuevo.
    const r = await kino.fetch(`${BASE}${encodeURIComponent(serverKey)}.json?v=${Math.floor(Date.now() / 3600000)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const d = r.json();
    if (!d || d.v !== 1 || d.serverKey !== serverKey || !Array.isArray(d.rows) || !d.rows.length) return null;
    if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
    const rows = d.rows.filter((r2) => r2 && typeof r2.id === "string" && typeof r2.title === "string" && Array.isArray(r2.items) && r2.items.length);
    if (!rows.length) return null;
    return { lang: typeof d.lang === "string" ? d.lang : null, langs: Array.isArray(d.langs) ? d.langs : [], slides: Array.isArray(d.slides) ? d.slides : [], rows };
  } catch (_) { return null; }
}
