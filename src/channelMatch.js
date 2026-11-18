// Channel and category names across Xtream panels: normalise them, carry them inside a live ref, and match the same
// channel on another panel BY NAME (ids are per panel). Pure functions, no kino.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.

const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");

// A 2-3 letter code is a country only as the name's prefix ("ES ▎", "┃MX┃", "|AR|", "US:", "UK -"): inside a name "de" or
// "it" are words. Regions and language tags are prefixes too, but never a concrete country.
const CODES = {
  es: "es", esp: "es", mx: "mx", mex: "mx", ar: "ar", arg: "ar", co: "co", col: "co", cl: "cl", pe: "pe", ve: "ve", ec: "ec",
  uy: "uy", py: "py", bo: "bo", cr: "cr", pa: "pa", gt: "gt", hn: "hn", sv: "sv", ni: "ni", do: "do", pr: "pr", cu: "cu",
  us: "us", usa: "us", ca: "ca", br: "br", pt: "pt", uk: "gb", gb: "gb", fr: "fr", de: "de", it: "it", nl: "nl", be: "be",
  ch: "ch", at: "at", pl: "pl", ro: "ro", tr: "tr", gr: "gr", al: "al", hr: "hr", rs: "rs", se: "se", no: "no", dk: "dk",
  fi: "fi", ie: "ie", au: "au", in: "in", pk: "pk", sa: "sa", ma: "ma", ru: "ru", bg: "bg", hu: "hu", cz: "cz",
};
const REGIONS = { lat: "lat", latam: "lat", latino: "lat", latinos: "lat", latina: "lat", int: "int", multi: "multi", en: "en" };
// Country names count anywhere in the name ("DEPORTES PERU", "VIX - MEXICO").
const NAMES = {
  argentina: "ar", brasil: "br", brazil: "br", bolivia: "bo", chile: "cl", colombia: "co", "costa rica": "cr", cuba: "cu",
  ecuador: "ec", "el salvador": "sv", guatemala: "gt", honduras: "hn", mexico: "mx", nicaragua: "ni", panama: "pa",
  paraguay: "py", peru: "pe", "puerto rico": "pr", "republica dominicana": "do", "r dominicana": "do", dominicana: "do",
  uruguay: "uy", venezuela: "ve", espana: "es", spain: "es", canada: "ca", usa: "us", "estados unidos": "us", france: "fr",
  francia: "fr", germany: "de", alemania: "de", deutschland: "de", italy: "it", italia: "it", portugal: "pt", uk: "gb",
  "reino unido": "gb", england: "gb", netherlands: "nl", holanda: "nl", marruecos: "ma", polonia: "pl", poland: "pl",
  rumania: "ro", romania: "ro", turquia: "tr", turkey: "tr", grecia: "gr", albania: "al", belgica: "be", suecia: "se",
};
const REGION_WORDS = { latino: "lat", latinos: "lat", latina: "lat", latinas: "lat", latam: "lat", latinoamerica: "lat" };
const isConcrete = (cc) => typeof cc === "string" && /^[a-z]{2}$/.test(cc) && cc !== "en";

// ---- channels ---------------------------------------------------------------------------------------------------------

const QUALITY = { "4k": "4k", uhd: "4k", "2160p": "4k", fhd: "fhd", "1080p": "fhd", "1080": "fhd", hd: "hd", "720p": "hd", "720": "hd", sd: "sd", "480p": "sd" };
const NOISE = new Set(["hevc", "h265", "h264", "raw", "backup", "bk", "alt", "op1", "op2", "audio", "vip"]);
const EVENT_WORD = /^(eventos?|events?|ppv|jornadas?|partidos?|match(es)?|agenda)$/;
// "ES ▎DAZN 1", "┃ES┃ DAZN", "|ES| DAZN", "ES: DAZN", "ES - DAZN": the code in front, then a separator.
const PREFIX = /^\s*[┃|▎[(]?\s*([A-Za-z]{2,6})\s*(?:[┃|▎\])]|:|\s-\s|-)\s*/;

/** `{ cc, q, key, event }`: the prefix country (or ""), the quality (4k/fhd/hd/sd or ""), the name's words, and whether it
 * is an event channel (its content changes over the day and its numbering is per panel: never matched). */
export function normChannel(raw) {
  let s = strip(raw);
  let cc = "";
  const m = s.match(PREFIX);
  if (m) {
    const code = m[1].toLowerCase();
    if (CODES[code] || REGIONS[code]) { cc = CODES[code] || REGIONS[code]; s = s.slice(m[0].length); }
  }
  s = s.toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  let q = "";
  const key = [];
  let event = false;
  for (const t of s.split(" ")) {
    if (!t) continue;
    if (QUALITY[t]) { if (!q) q = QUALITY[t]; continue; }
    if (NOISE.has(t) || /^\d+fps$/.test(t)) continue;
    if (EVENT_WORD.test(t)) event = true;
    key.push(t);
  }
  return { cc, q, key: key.join(" "), event };
}

const MAX_TOK = 56;
/** The channel's name as it travels in a live ref: "<cc>.<q>.<words…>" ("_" for an empty field), only [a-z0-9._]. "" for an
 * event, an empty name or one too long to carry whole (a cut name could equal another channel's). */
export function channelTok(raw) {
  const n = normChannel(raw);
  if (n.event || !n.key) return "";
  const tok = [isConcrete(n.cc) ? n.cc : "_", n.q || "_", ...n.key.split(" ")].join(".");
  return tok.length <= MAX_TOK ? tok : "";
}

export function parseChannelTok(tok) {
  const p = String(tok || "").split(".");
  if (p.length < 3 || !/^[a-z0-9._]+$/.test(String(tok)) || !/^(_|[a-z]{2})$/.test(p[0]) || !/^(_|4k|fhd|hd|sd)$/.test(p[1])) return null;
  return { cc: p[0] === "_" ? "" : p[0], q: p[1] === "_" ? "" : p[1], key: p.slice(2).join(" ") };
}

const LADDER = { sd: 0, hd: 1, fhd: 2, "4k": 3 };
// A name with no quality prefers the same (no quality), then the usual main feeds.
const NO_Q_ORDER = ["", "fhd", "hd", "4k", "sd"];

/**
 * The channel of [list] (`[{ stream_id, name }]`) that is the one [tok] names: same words, same prefix country when both
 * say one, the same quality or the nearest. `{ id, name }`, or `{ why }` ("bad", "none", "ambiguous"): no fuzzy match, a
 * miss is safe.
 */
export function matchChannel(tok, list) {
  const src = parseChannelTok(tok);
  if (!src || !src.key) return { why: "bad" };
  const cands = [];
  for (const s of Array.isArray(list) ? list : []) {
    const id = String((s && s.stream_id) || "");
    if (!/^\d+$/.test(id)) continue;
    const n = normChannel(s.name);
    if (n.event || n.key !== src.key) continue;
    if (src.cc && isConcrete(n.cc) && n.cc !== src.cc) continue;
    cands.push({ id, name: String(s.name || ""), q: n.q });
  }
  if (!cands.length) return { why: "none" };
  const have = new Set(cands.map((c) => c.q));
  let q;
  if (!src.q) q = NO_Q_ORDER.find((x) => have.has(x));
  else if (have.has(src.q)) q = src.q;
  else {
    const want = LADDER[src.q];
    q = [...have].sort((a, b) => Math.abs(LADDER[a || "hd"] - want) - Math.abs(LADDER[b || "hd"] - want) || LADDER[b || "hd"] - LADDER[a || "hd"])[0];
  }
  const pool = cands.filter((c) => c.q === q);
  if (new Set(pool.map((c) => c.id)).size > 1) return { why: "ambiguous" };
  return { id: pool[0].id, name: pool[0].name };
}

// ---- categories -------------------------------------------------------------------------------------------------------

const STOP = new Set(["general", "generales", "canales", "channels", "tv", "hd", "fhd", "sd", "uhd", "4k", "vip", "y", "and", "de", "del", "la", "el", "los", "las", "plus"]);
const CAT_EVENT = /^(eventos?|events?|ppv|jornadas?|partidos?|match(es)?|agenda|replays?)$/;
const stem = (t) => (/[lrnd]es$/.test(t) && t.length > 5 ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

/** `{ cc, topic: Set, event }` of a category name: the country (a concrete ISO code, a region "lat"/"int"/"multi"/"en",
 * or ""), and its topic words without countries, stop words or plurals. */
export function normCategory(raw) {
  const s = strip(raw).toLowerCase().replace(/la\s+liga/g, "laliga").replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  const toks = s.split(" ").filter(Boolean);
  let cc = "";
  let event = false;
  const topic = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i === 0 && (CODES[t] || REGIONS[t])) { cc = CODES[t] || REGIONS[t]; continue; }
    const two = i + 1 < toks.length ? t + " " + toks[i + 1] : "";
    if (two && NAMES[two]) { if (!cc) cc = NAMES[two]; i++; continue; }
    if (NAMES[t]) { if (!cc) cc = NAMES[t]; continue; }
    if (REGION_WORDS[t]) { if (!cc) cc = REGION_WORDS[t]; continue; }
    if (CAT_EVENT.test(t)) event = true;
    if (STOP.has(t)) continue;
    topic.add(stem(t));
  }
  return { cc, topic, event };
}

const MAX_CAT_TOK = 32;
const EVENT_STEMS = new Set(["evento", "event", "ppv", "jornada", "partido", "match", "matche", "agenda", "replay"]);
/** A category as it travels in a live ref: "<cc>.<topic words, sorted>" ("_" for no country), or "" when too long to
 * carry whole. An event category keeps its event word, so it is still recognised (and never matched) on the way back. */
export function categoryTok(raw) {
  const n = normCategory(raw);
  const tok = [n.cc && /^[a-z]{2,5}$/.test(n.cc) ? n.cc : "_", ...[...n.topic].sort()].join(".");
  return tok.length <= MAX_CAT_TOK && /^[a-z0-9._]+$/.test(tok) ? tok : "";
}

export function parseCategoryTok(tok) {
  const t = String(tok || "");
  if (!t || !/^[a-z0-9._]+$/.test(t)) return null;
  const p = t.split(".");
  const topic = new Set(p.slice(1).filter(Boolean));
  return { cc: p[0] === "_" ? "" : p[0], topic, event: [...topic].some((w) => EVENT_STEMS.has(w)) };
}

/** Whether category [name] is the one [tok] describes, as the same panel would name it (an exact re-encoding). */
export const sameCategory = (tok, name) => !!tok && categoryTok(name) === tok;

/**
 * The category of [list] (`[{ category_id, category_name }]`) that carries the same channels as [tok] on another panel:
 * the same concrete country on both sides (never a region, a language or none: the same brand airs different national
 * feeds) and topic words whose Jaccard is at least 0.6 (two topic-less pages of one country match). The best one, or null.
 */
export function matchCategory(tok, list) {
  const src = parseCategoryTok(tok);
  if (!src || src.event || !isConcrete(src.cc)) return null;
  let best = null;
  for (const c of Array.isArray(list) ? list : []) {
    const id = String((c && c.category_id) || "");
    if (!id) continue;
    const n = normCategory(c.category_name);
    if (n.event || n.cc !== src.cc) continue;
    let inter = 0;
    for (const t of src.topic) if (n.topic.has(t)) inter++;
    const uni = new Set([...src.topic, ...n.topic]).size;
    const score = uni ? inter / uni : 1;
    if (score >= 0.6 && (!best || score > best.score)) best = { id, name: String(c.category_name || ""), score };
  }
  return best;
}
