// Ultra Hd — entrada del plugin: catálogo, ajustes y pantalla propia.
// La pantalla responde al instante a un toque aunque haya peticiones en vuelo (p. ej. abrir el selector mientras carga).
globalThis.__kinoDropPendingFetches = true;
export { home, browse, search, episodes, resolve, liveCategories, liveChannels, liveSearch, guide, settingsStatus, action } from "./catalog.js";
export { screen, screenEvent, section } from "./screen.js";
