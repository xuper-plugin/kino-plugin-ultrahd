// Panels and accounts. The service lists ~50 hosts with one public account each, but many are accounts of the SAME Xtream
// panel (same category ids and names, same stream ids). A stream id is only valid on its own panel, so the plugin groups
// the servers into panels from the category lists the health check already downloads (0 extra requests), and remembers
// which accounts are dead (auth 0) or blocked (Kino refuses their host), so nothing spends requests on them.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { put } from "./store.js";
import { PLUGIN_VERSION } from "./version.js";

export const PANELS_KEY = "panels:v1";
export const ACCT_KEY = "acct:v1";
const DAY = 24 * 60 * 60 * 1000;
export const DEAD_TTL_MS = DAY;
const KEEP_OFFLINE_MS = 7 * DAY;
// Same panel: at least MIN_SHARED identical "id|name" category pairs, and at least MIN_SHARE of the smaller list (an
// account's bouquet can be a small subset of another's; two panels both numbering "1|peliculas" are not one panel).
const MIN_SHARED = 8;
const MIN_SHARE = 0.8;

const djb2 = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Stable key of a server (same account on the same host): never shows the user or the password. */
export function keyOf(srv) {
  if (!srv || !srv.url) return "";
  return djb2(srv.url + "|" + srv.username);
}

// A short hash of the whole credential: a dead mark stops counting once the service changes the password.
const credOf = (srv) => djb2(String(srv.url) + "|" + srv.username + "|" + srv.password).slice(0, 6);

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const normName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The fingerprint of one server: the set of hashes of its categories' "id|name" pairs. */
export function pairHashes(cats) {
  const out = new Set();
  for (const c of Array.isArray(cats) ? cats : []) {
    const id = String((c && c.category_id) || "");
    if (id) out.add(fnv(id + "|" + normName(c.category_name)));
  }
  return out;
}

export function linked(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < MIN_SHARED) return false;
  let n = 0;
  for (const h of small) if (large.has(h)) n++;
  return n >= MIN_SHARED && n >= MIN_SHARE * small.size;
}

/**
 * Groups servers into panels around anchors: servers go largest list first; one that links to no anchor becomes an anchor,
 * one that links to exactly one joins it, one that links to two anchors stays unknown (a small account contained in two
 * panels never merges them). [sets]: Map key -> pair hashes of the servers that answered now. [prev]: the stored map.
 * Labels survive: a group keeps the previous label most of its members had; a server that did not answer keeps its label
 * (following its group's relabel) for 7 days. Returns the new `{ v, at, g: {key: label}, t: {key: confirmed ms} }`.
 */
export function groupPanels(sets, prev, now) {
  const prevG = (prev && prev.g) || {};
  const prevT = (prev && prev.t) || {};
  const keys = [...sets.keys()].filter((k) => sets.get(k).size >= MIN_SHARED)
    .sort((a, b) => sets.get(b).size - sets.get(a).size || (a < b ? -1 : a > b ? 1 : 0));
  const groups = [];
  const unknown = new Set();
  for (const k of keys) {
    const hits = groups.filter((gr) => linked(sets.get(k), sets.get(gr.anchor)));
    if (!hits.length) groups.push({ anchor: k, members: [k] });
    else if (hits.length === 1) hits[0].members.push(k);
    else unknown.add(k);
  }
  const g = {};
  const t = {};
  const used = new Set();
  const remap = {};
  for (const gr of groups) {
    const votes = {};
    for (const m of gr.members) if (prevG[m]) votes[prevG[m]] = (votes[prevG[m]] || 0) + 1;
    const old = Object.keys(votes).filter((l) => !used.has(l)).sort((a, b) => votes[b] - votes[a] || (a < b ? -1 : 1))[0];
    const label = old || (used.has(gr.anchor) ? gr.anchor + "~" : gr.anchor);
    used.add(label);
    for (const m of gr.members) {
      g[m] = label;
      t[m] = now;
      if (prevG[m] && !(prevG[m] in remap)) remap[prevG[m]] = label;
    }
  }
  for (const k of Object.keys(prevG)) {
    if (k in g || unknown.has(k) || sets.has(k)) continue;
    if (now - (Number(prevT[k]) || 0) >= KEEP_OFFLINE_MS) continue;
    g[k] = remap[prevG[k]] || prevG[k];
    t[k] = prevT[k];
  }
  return { v: 1, at: now, g, t };
}

export function readPanels() {
  try {
    const o = JSON.parse(kino.storage.get(PANELS_KEY) || "null");
    return o && o.v === 1 && o.g && typeof o.g === "object" ? o : null;
  } catch (_) { return null; }
}

export const writePanels = (map) => put(PANELS_KEY, JSON.stringify(map));

/** The panel label of server key [k], or null when unknown (never treated as the same panel as anything). */
export function panelOf(k, map = readPanels()) {
  return (map && k && map.g[k]) || null;
}

/** Server keys of panel [label] confirmed within [maxAgeMs]. */
export function membersOf(label, map = readPanels(), now = Date.now(), maxAgeMs = KEEP_OFFLINE_MS) {
  if (!map || !label) return [];
  return Object.keys(map.g).filter((k) => map.g[k] === label && now - (Number(map.t && map.t[k]) || 0) < maxAgeMs);
}

// ---- dead and blocked accounts ----------------------------------------------------------------------------------------

function readAcct() {
  try {
    const o = JSON.parse(kino.storage.get(ACCT_KEY) || "null");
    if (o && o.v === 1 && o.dead && o.blocked) return o;
  } catch (_) { /* rebuilt below */ }
  return { v: 1, dead: {}, blocked: {} };
}

function writeAcct(o, now) {
  for (const k of Object.keys(o.dead)) if (now - (Number(o.dead[k][0]) || 0) >= DEAD_TTL_MS) delete o.dead[k];
  for (const k of Object.keys(o.blocked)) if (o.blocked[k] !== PLUGIN_VERSION) delete o.blocked[k];
  put(ACCT_KEY, JSON.stringify(o));
}

/** Answered "Invalid username or password" (or expired, banned, disabled): skipped for a day. */
export function noteDead(srv, now = Date.now()) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  o.dead[k] = [now, credOf(srv)];
  writeAcct(o, now);
}

/** Kino refused the server's own host (not declared, plain http): skipped until the next plugin version, which may declare it. */
export function noteBlocked(srv, now = Date.now()) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  if (o.blocked[k] === PLUGIN_VERSION) return;
  o.blocked[k] = PLUGIN_VERSION;
  writeAcct(o, now);
}

/** A good answer: forget a mark (writes only when there was one). */
export function noteAlive(srv) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  if (!(k in o.dead) && !(k in o.blocked)) return;
  delete o.dead[k];
  delete o.blocked[k];
  put(ACCT_KEY, JSON.stringify(o));
}

export function isDead(srv, now = Date.now()) {
  const d = readAcct().dead[keyOf(srv)];
  return !!d && d[1] === credOf(srv) && now - (Number(d[0]) || 0) < DEAD_TTL_MS;
}

export const isBlocked = (srv) => readAcct().blocked[keyOf(srv)] === PLUGIN_VERSION;

/** Neither dead nor blocked: worth a request. */
export const usable = (srv, now = Date.now()) => !!srv && !isBlocked(srv) && !isDead(srv, now);

/** `"dead"` when an Xtream answer says the account cannot play (auth 0, Expired/Banned/Disabled, past exp_date), else null. */
export function accountVerdict(data, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.user_info || typeof data.user_info !== "object") return null;
  const u = data.user_info;
  if (u.auth !== undefined && String(u.auth) === "0") return "dead";
  if (/^(expired|banned|disabled)$/i.test(String(u.status || ""))) return "dead";
  const exp = Number(u.exp_date);
  if (u.exp_date !== null && u.exp_date !== undefined && u.exp_date !== "" && Number.isFinite(exp) && exp > 0 && exp * 1000 < now) return "dead";
  return null;
}
