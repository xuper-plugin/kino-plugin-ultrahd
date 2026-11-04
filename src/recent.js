// Películas reproducidas, por servidor (los stream_id cambian de un servidor a otro).
import { put } from "./store.js";
const KEY = "recent:v1";
export const MAX_RECENT = 12;
const MAX_TOTAL = 36;

function readAll() {
  try {
    const o = JSON.parse(kino.storage.get(KEY) || "null");
    return Array.isArray(o) ? o.filter((e) => e && typeof e.id === "string" && typeof e.srv === "string") : [];
  } catch (_) {
    return [];
  }
}

function writeAll(list) {
  let kept = list.slice(0, MAX_TOTAL);
  let text = JSON.stringify(kept);
  while (text.length > 26 * 1024 && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = JSON.stringify(kept);
  }
  put(KEY, text);
}

export function noteRecent(streamId, ext, srv) {
  const id = String(streamId);
  const all = readAll();
  const mine = all.filter((e) => e.srv === srv);
  if (mine[0] && mine[0].id === id) return;
  const prev = mine.find((e) => e.id === id);
  const entry = { id, srv, ext: String(ext || "mp4"), ...(prev && prev.card ? { card: prev.card } : {}) };
  const others = all.filter((e) => e.srv !== srv);
  writeAll([entry, ...mine.filter((e) => e.id !== id).slice(0, MAX_RECENT - 1), ...others]);
}

export const recentEntries = (srv) => readAll().filter((e) => e.srv === srv).slice(0, MAX_RECENT);

export function rememberCard(srv, id, card) {
  writeAll(readAll().map((e) => (e.srv === srv && e.id === id ? { ...e, card } : e)));
}
