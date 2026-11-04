# Ultra Hd

Plugin de Kino: películas, series y TV en vivo en Ultra HD. No pide usuario ni contraseña: las credenciales se obtienen solas desde el servicio, y el plugin cambia de servidor si uno falla.

- **Inicio y búsqueda:** filas por categoría de películas y series, y un buscador que recorre las categorías en paralelo.
- **Series:** ficha con temporadas y episodios.
- **En vivo:** categorías, canales con logo y número, búsqueda de canales y guía de programación (cuando el servidor la publica).
- **Detalle:** géneros, duración, fondo y los ids de TMDB e IMDb cuando la lista los trae.
- **Contenido 18+:** las categorías adultas se marcan y Kino las muestra solo con el código 18+ desbloqueado; el inicio las omite.
- **Servidores:** guarda una lista, prefiere HTTPS (lo único que Kino permite con servidores externos), recuerda el que funciona y pasa al siguiente cuando falla.
- **Hosts:** el servicio de arranque va por HTTP (`insecureHttp`) y el video puede salir de otros hosts (`streamHosts: any`, aviso en rojo al instalar).

## Estado

0.1.0. Verificado con el ejecutor del kit contra el servicio real: inicio, búsqueda, episodios, categorías y canales en vivo, y la resolución de películas, episodios y canales a una URL de reproducción. No probado en un aparato. La guía de programación está implementada pero sin verificar con datos reales, porque el servidor probado no tiene.

## Construir y probar

```bash
npm install
npm run build      # empaqueta src/plugin.js en plugin.js con esbuild
npm run validate   # build + node sdk/validate.mjs .
node sdk/run.mjs . home
node sdk/run.mjs . search "spider"
node sdk/run.mjs . liveCategories
```
