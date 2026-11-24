// Ultra Hd — entrada del plugin: catálogo, ajustes y pantalla propia.
// Every export writes the storage index once, after the call (store.flush): a put writes only its own value.
import * as cat from "./catalog.js";
import * as scr from "./screen.js";
import { flush } from "./store.js";
import { catalogDoor } from "./door.js";

const once = (fn) => async (...args) => { try { return await fn(...args); } finally { flush(); } };

export const home = once(cat.home);
export const browse = once(cat.browse);
export const search = once(cat.search);
export const episodes = once(cat.episodes);
export const resolve = once(cat.resolve);
export const liveCategories = once(cat.liveCategories);
export const liveChannels = once(cat.liveChannels);
export const liveSearch = once(cat.liveSearch);
export const guide = once(cat.guide);
export const settingsStatus = once(cat.settingsStatus);
export const action = once(cat.action);
export const screen = once(scr.screen);
export const screenEvent = once(scr.screenEvent);
export const section = once(scr.section);
// The catalog door (Kino's plugin protocol, manifest "provides" at apiVersion 20+): the title index answers Da-Video's search.
export const proto_catalog_search = once(catalogDoor(cat.catalogSearch));
