# Ultra Hd

Plugin de Kino: películas, series y TV en vivo en Ultra HD. No pide usuario ni contraseña: las credenciales se obtienen solas desde el servicio, y el plugin cambia de servidor si uno falla.

Requiere Kino 0.9.74 o posterior (usa `kino.catalog`).

- **Pantalla propia** (como Xuper): Home con slider y filas, pestañas Películas, Series y En vivo, buscador con historial y página de ajustes.
- **Búsqueda instantánea:** un índice de ≈ 46.000 títulos (películas y series) vive en el `kino.catalog` de Kino y se busca ahí, sin recorrer categorías en vivo. Si no está listo, o no hay resultados, se busca en vivo como siempre.
- **Series:** ficha con temporadas y episodios.
- **En vivo:** categorías, canales con logo y número, búsqueda de canales y guía de programación (cuando el servidor la publica).
- **TMDB al vuelo:** solo el id de lo que se muestra (primeras filas del Home y primeros resultados de búsqueda), con `kino.tmdb`: la clave y la caché son de Kino, el plugin no lleva ninguna.
- **Contenido 18+:** las categorías adultas se marcan y Kino las muestra solo con el código 18+ desbloqueado; el inicio las omite.
- **Servidores:** guarda una lista, prefiere HTTPS (lo único que Kino permite con servidores externos), recuerda el que funciona y pasa al siguiente cuando falla.
- **Hosts:** el servicio de arranque va por HTTP (`insecureHttp`) y el video puede salir de otros hosts (`streamHosts: any`, aviso en rojo al instalar).

## Cómo funciona el índice

Lo genera a diario un workflow en [kino-plugin-ultrahd-data](https://github.com/xuper-plugin/kino-plugin-ultrahd-data) y lo publica en su rama `data`: un snapshot por trozos (≈ 540 KB comprimido), más los deltas de los últimos 7 días y una `revision`. El plugin (`src/titleIndex.js`):

1. Guarda en `kino.storage` (texto pequeño) la revisión aplicada.
2. Al abrir, o pasado un día, pide solo el manifiesto (una petición pequeña). Si ya está en la revisión actual, no descarga nada.
3. Si está a ≤ 7 revisiones, descarga solo los deltas intermedios y aplica `upsert` de las altas y `remove` de las bajas (lotes de 500), en orden. Tras cada delta comprueba que el catálogo tenga exactamente los títulos que el delta declara.
4. Solo desde cero, con el catálogo vacío (por ejemplo, tras restaurar una copia de seguridad), con un delta ausente, dañado o incoherente, o si está a más de 7 revisiones, vuelca el snapshot completo (`upsert` idempotente por trozos) y retira lo que ya no está; mientras tanto el catálogo anterior sigue sirviendo búsquedas.
5. Un índice dañado, de otra versión o con cobertura baja nunca reemplaza al bueno.

Se puebla por etapas, acotadas en tiempo, dentro de las llamadas normales (Home y búsqueda): los jobs de Kino no pueden usar `kino.catalog`. Los resultados llevan una referencia perezosa (`idx:m:…` / `idx:s:…`): al abrirlos, el id real se pide en vivo solo a las categorías del título.

El catálogo admite 100.000 títulos; si se pasara, el plugin se queda con lo que cupo y lo marca.

## Estado

0.3.0. Verificado con el ejecutor del kit contra el servicio real y la rama `data` publicada: inicio, búsqueda, episodios, categorías y canales en vivo, resolución de películas, episodios y canales, y el índice de extremo a extremo (descarga, volcado, búsqueda, apertura de un resultado). No probado en un aparato. La guía de programación está implementada pero sin verificar con datos reales, porque el servidor probado no tiene. El TMDB al vuelo se probó con un fixture del kit, no con la clave real de Kino.

## Construir y probar

```bash
npm install
npm run build        # empaqueta src/plugin.js en plugin.js con esbuild
npm run validate     # build + node sdk/validate.mjs .
npm run test:index   # índice, deltas y TMDB perezoso (necesita el repo hermano kino-plugin-ultrahd-data; UHD_DATA=ruta)
npm run test:storage # presupuesto de los 256 KB de kino.storage
npm run e2e          # extremo a extremo con red real (usa el índice publicado y el servicio)
node sdk/run.mjs . home
node sdk/run.mjs . search "spider"
node sdk/run.mjs . liveCategories
```
