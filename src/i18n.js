// Textos propios del plugin: [español, inglés]. Lo que viene del servidor (títulos, categorías) no se traduce.
export const TEXTS = Object.freeze({
  tabHome: ["Inicio", "Home"],
  tabMovies: ["Películas", "Movies"],
  tabSeries: ["Series", "Series"],
  tabLive: ["En vivo", "Live"],
  watch: ["Ver", "Watch"],
  info: ["Detalles", "Details"],
  search: ["Buscar", "Search"],
  searchTitle: ["Buscar", "Search"],
  searchHint: ["Película o serie", "Movie or series"],
  searchFailed: ["La búsqueda falló.", "The search failed."],
  noResults: ["No encontramos nada con esas palabras.", "Nothing found for those words."],
  searchedBefore: ["Buscado antes", "Searched before"],
  retry: ["Reintentar", "Retry"],
  category: ["Categoría", "Category"],
  allCats: ["Todas las categorías", "All categories"],
  more: ["Cargar más categorías", "Load more categories"],
  back: ["Atrás", "Back"],
  close: ["Cerrar", "Close"],
  settings: ["Ajustes", "Settings"],
  recent: ["Continuar viendo", "Continue watching"],
  live: ["En vivo", "Live"],
  liveCountry: ["Canales de tu país", "Channels from your country"],
  liveSearchHint: ["Buscar un canal", "Search a channel"],
  liveCategory: ["Categoría", "Category"],
  liveEmpty: ["No hay canales para mostrar.", "No channels to show."],
  liveMore: ["Se muestran los primeros {n}. Usa la búsqueda para encontrar otros.", "Showing the first {n}. Use search to find others."],
  seeLive: ["Ver todo En vivo", "See all Live"],
  partial: ["Algunas filas no cargaron.", "Some rows did not load."],
  searchPartial: ["Resultados parciales: no se revisaron todas las categorías (el servidor limita las peticiones).", "Partial results: not every category was checked (the server limits requests)."],
  empty: ["Todavía no hay nada para mostrar.", "Nothing to show yet."],
  failed: ["No se pudo cargar. Revisa tu conexión.", "Could not load. Check your connection."],
  setTitle: ["Ajustes de Ultra Hd", "Ultra Hd settings"],
  setConnection: ["Conexión", "Connection"],
  setConnectionHint: ["Los servidores se obtienen solos. Aquí puedes cambiar de uno si va mal.", "Servers are picked automatically. Switch here if one misbehaves."],
  setServer: ["Servidor activo", "Active server"],
  setServerOk: ["Responde", "Online"],
  setServerDown: ["Sin respuesta", "No answer"],
  setServerNone: ["Sin servidores", "No servers"],
  setServerPos: ["{i} de {n} en la lista", "{i} of {n} in the list"],
  setPick: ["Elegir servidor", "Choose server"],
  setPickHint: ["Cada servidor trae la bandera de su país (🇲🇽, 🇪🇸, 🌐). Elige el tuyo; si uno no trae buenos canales o logos, prueba otro.", "Each server shows its country flag (🇲🇽, 🇪🇸, 🌐). Pick yours; if one has poor channels or logos, try another."],
  srvSelected: ["Servidor fijado: {host}", "Server set: {host}"],
  srvSelectFail: ["No respondió {host}. Prueba otro.", "{host} did not answer. Try another."],
  setSwitch: ["Cambiar servidor", "Switch server"],
  setSwitchHint: ["Prueba el siguiente servidor de la lista.", "Tries the next server in the list."],
  setRefresh: ["Actualizar lista de servidores", "Update server list"],
  setRefreshHint: ["Vuelve a pedir la lista al servicio.", "Asks the service for the list again."],
  setCheck: ["Comprobar", "Check"],
  setAdultTitle: ["Contenido 18+", "18+ content"],
  setAdultHint: ["Apagado, las categorías para adultos no aparecen. Encendido, salen marcadas y Kino las muestra solo con tu código 18+.", "Off, adult categories are hidden. On, they appear marked and Kino shows them only with your 18+ code."],
  setLiveTitle: ["En vivo", "Live"],
  setLiveHint: ["Formato de los canales. Si uno no carga, prueba el otro.", "Channel format. If one will not play, try the other."],
  setHomeTitle: ["Inicio", "Home"],
  setHomeHint: ["Una fila con los canales en vivo de tu país al final de Inicio.", "A row with your country's live channels at the end of Home."],
  setAbout: ["Acerca de", "About"],
  aboutPlugin: ["Plugin", "Plugin"],
  aboutKino: ["Kino", "Kino"],
  aboutDevice: ["Aparato", "Device"],
  switched: ["Servidor cambiado a {host}", "Server switched to {host}"],
  noOther: ["No hay otro servidor disponible ahora.", "No other server is available now."],
  refreshed: ["Lista actualizada: {n} servidores.", "List updated: {n} servers."],
  refreshFail: ["No se pudo actualizar la lista.", "Could not update the list."],
  checking: ["Comprobando…", "Checking…"],
});

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : "")) : s);

export function twin(key, prop = "text", vars) {
  const [es, en] = TEXTS[key] || [key, key];
  return { [prop]: fill(es, vars), [prop + "En"]: fill(en, vars) };
}

export const say = (key, lang, vars) => {
  const [es, en] = TEXTS[key] || [key, key];
  return fill(lang === "en" ? en : es, vars);
};
