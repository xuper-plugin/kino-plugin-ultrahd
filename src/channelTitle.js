// What a live channel's title SHOWS. Xtream panels decorate their channel names with a country, region or tag code and a
// bar ("┃ES┃ M+ DEPORTES", "ES ▎DAZN 1", "|MX| ESPN", "!ES! …", "[ES] …", "ES: …", "ES - …", "MULTI ▎ VIAPLAY",
// "ESPN ┃MX┃") or a group and a panel bar ("BEIN ▎BEIN SPORTS 1", "┃UCL┃ CHAMPIONS LEAGUE"): on screen that adds nothing,
// so it is dropped. Pure functions, no kino. Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
//
// Only the shown title changes. A channel's id, its ref and the cross-panel name matching (channelMatch.js) keep reading
// the panel's raw name. Kino matches a saved channel by id + name, else by ref, else by name: one saved under the raw name
// is found by its ref, which this never changes.
import { normCategory } from "./channelMatch.js";

// Bar-like separators: never part of a name. The panels' own (all but the plain "|", "¦", "∣" and "｜") also mark the
// word before them at the start as the group the panel files the channel under ("BEIN ▎BEIN SPORTS 1").
const PANEL_BAR_CHARS = "┃│▎▍▌▏▕▐‖╎╏┆┇┊┋❘❙";
const BAR_CHARS = "|¦∣｜" + PANEL_BAR_CHARS;
const BAR = "[" + BAR_CHARS + "]";
const PANEL_BAR = new RegExp("[" + PANEL_BAR_CHARS + "]");
// "!" frames a code too ("!ES! DAZN 1"), only a known one: "Yu-Gi-Oh!" keeps its "!".
const OPEN = "(?:" + BAR + "|\\[|\\(|!)";
const CLOSE = "(?:" + BAR + "|\\]|\\)|!)";
const TOK = "[A-Z0-9]{2,6}";
// Inside brackets several codes may share one pair ("[ES/MX]", "┃ES-LAT┃"); before a separator only "/" and "," join them,
// because " - " is itself a separator there ("ES - DAZN").
const BRACKET_TOKS = TOK + "(?:\\s*[/,+&-]\\s*" + TOK + ")*";
const SEP_TOKS = TOK + "(?:\\s*[/,]\\s*" + TOK + ")*";
const SEP = "(?:\\s*" + BAR + "+\\s*|\\s*:\\s*|\\s*[•·●▪►»➤]\\s*|\\s+[-–—]+\\s*|[-–—]+\\s+)";

const LEAD_BRACKET = new RegExp("^\\s*" + OPEN + "\\s*(" + BRACKET_TOKS + ")\\s*" + CLOSE + "\\s*");
const LEAD_SEP = new RegExp("^\\s*(" + SEP_TOKS + ")" + SEP);
const TRAIL_BRACKET = new RegExp("\\s*" + OPEN + "\\s*(" + BRACKET_TOKS + ")\\s*" + CLOSE + "\\s*$");
const TRAIL_SEP = new RegExp("\\s*" + BAR + "+\\s*(" + SEP_TOKS + ")\\s*$");
// Between two bars inside the name ("ESPN ┃MX┃ 2"): only bars, since "(ES)" inside a name can be part of it.
const MID_BRACKET = new RegExp("\\s*" + BAR + "\\s*(" + BRACKET_TOKS + ")\\s*" + BAR + "\\s*", "g");
const BARS_LEFT = new RegExp("\\s*" + BAR + "+\\s*", "g");
// A name with none of these characters carries no decoration: it is only trimmed.
const MAYBE_DECORATED = new RegExp("[" + BAR_CHARS + "\\[\\]()!:•·●▪►»➤–—-]");
// Loose separators and bars at either end ("┃ES┃" loses its outer bars first: "ES┃" is then a code before a separator).
const JUNK = "[\\s" + BAR_CHARS + "·•●▪►»➤:–—-]+";
const LEAD_JUNK = new RegExp("^" + JUNK);
const TRAIL_JUNK = new RegExp(JUNK + "$");
const HAS_TEXT = /[\p{L}\p{N}]/u;
// A group before a panel bar at the start: one upper-case word that is no known code ("BEIN", "UEFA", "VIA", "F1", "UCL",
// "SPORTS", "MGP"). "TV" names a channel ("TV ▎ NOTICIAS").
const GROUP = /^[A-Z][A-Z0-9]{1,5}$/;
const NOT_GROUP = new Set(["TV"]);
const TWO_LETTERS = /\p{L}{2}/u;
// What follows opens a code wrapped in bars ("ESPN ┃MX┃", "ESPN ┃MX┃ 2"): the word before it is the name, not a group.
const OPENS_WRAP = new RegExp("^\\s*" + TOK + "\\s*" + BAR);

// Country codes as a prefix or suffix -> ISO (the same values as channelMatch.js CODES, plus a few more). A 2-3 letter word
// counts only between brackets or before a separator: "UK Gold" and "MX Prime" are names.
const COUNTRY = {
  es: "es", esp: "es", mx: "mx", mex: "mx", ar: "ar", arg: "ar", co: "co", col: "co", cl: "cl", pe: "pe", ve: "ve", ven: "ve",
  ec: "ec", ecu: "ec", uy: "uy", uru: "uy", py: "py", bo: "bo", cr: "cr", pa: "pa", gt: "gt", hn: "hn", sv: "sv", ni: "ni",
  do: "do", pr: "pr", cu: "cu", us: "us", usa: "us", ca: "ca", br: "br", bra: "br", pt: "pt", uk: "gb", gb: "gb", ie: "ie",
  sc: "sc", fr: "fr", fra: "fr", de: "de", ger: "de", it: "it", ita: "it", nl: "nl", be: "be", ch: "ch", at: "at", pl: "pl",
  ro: "ro", tr: "tr", tur: "tr", gr: "gr", al: "al", alb: "al", hr: "hr", rs: "rs", srb: "rs", se: "se", no: "no", dk: "dk",
  fi: "fi", au: "au", nz: "nz", in: "in", pk: "pk", sa: "sa", ksa: "sa", ma: "ma", ru: "ru", rus: "ru", bg: "bg", hu: "hu",
  cz: "cz", il: "il", ua: "ua", lu: "lu", jp: "jp", kr: "kr", cn: "cn",
  // the ex-Yugoslav panels' own spellings ("ARENA SPORT 1 HD (SR)", "(SL)", "(BIH)")
  sr: "rs", sl: "si", slo: "si", bih: "ba", ba: "ba", mkd: "mk", mk: "mk", mne: "me",
};
// Regions, languages and tags in the same places. "lat", "int", "multi" and "en" are channelMatch.js's own region keys.
const REGION = {
  lat: "lat", latam: "lat", latino: "lat", latin: "lat", int: "int", multi: "multi", en: "en", eng: "en", exyu: "exyu",
  asia: "asia", afr: "afr", vip: "vip", ppv: "ppv",
};
// Quality is information, not decoration: its brackets go, the word stays (moved to the end when it led the name).
const QUALITY = { "4k": "4K", "8k": "8K", uhd: "UHD", fhd: "FHD", hd: "HD", sd: "SD", hevc: "HEVC" };

// [Spanish, English] for the suffix that tells apart two channels a list would otherwise show alike.
const LABELS = {
  es: ["España", "Spain"], mx: ["México", "Mexico"], ar: ["AR", "AR"], co: ["Colombia", "Colombia"], cl: ["Chile", "Chile"],
  pe: ["Perú", "Peru"], ve: ["Venezuela", "Venezuela"], ec: ["Ecuador", "Ecuador"], uy: ["Uruguay", "Uruguay"],
  py: ["Paraguay", "Paraguay"], bo: ["Bolivia", "Bolivia"], cr: ["Costa Rica", "Costa Rica"], pa: ["Panamá", "Panama"],
  gt: ["Guatemala", "Guatemala"], hn: ["Honduras", "Honduras"], sv: ["El Salvador", "El Salvador"], ni: ["Nicaragua", "Nicaragua"],
  do: ["Rep. Dominicana", "Dominican Rep."], pr: ["Puerto Rico", "Puerto Rico"], cu: ["Cuba", "Cuba"], us: ["EE. UU.", "USA"],
  ca: ["Canadá", "Canada"], br: ["Brasil", "Brazil"], pt: ["Portugal", "Portugal"], gb: ["Reino Unido", "UK"], ie: ["Irlanda", "Ireland"],
  sc: ["Escocia", "Scotland"], fr: ["Francia", "France"], de: ["Alemania", "Germany"], it: ["Italia", "Italy"],
  nl: ["Países Bajos", "Netherlands"], be: ["Bélgica", "Belgium"], ch: ["Suiza", "Switzerland"], at: ["Austria", "Austria"],
  pl: ["Polonia", "Poland"], ro: ["Rumania", "Romania"], tr: ["Turquía", "Turkey"], gr: ["Grecia", "Greece"], al: ["Albania", "Albania"],
  hr: ["Croacia", "Croatia"], rs: ["Serbia", "Serbia"], se: ["Suecia", "Sweden"], no: ["Noruega", "Norway"], dk: ["Dinamarca", "Denmark"],
  fi: ["Finlandia", "Finland"], au: ["Australia", "Australia"], nz: ["Nueva Zelanda", "New Zealand"], in: ["India", "India"],
  pk: ["Pakistán", "Pakistan"], sa: ["Arabia Saudita", "Saudi Arabia"], ma: ["Marruecos", "Morocco"], ru: ["Rusia", "Russia"],
  bg: ["Bulgaria", "Bulgaria"], hu: ["Hungría", "Hungary"], cz: ["Chequia", "Czechia"], il: ["Israel", "Israel"],
  ua: ["Ucrania", "Ukraine"], lu: ["Luxemburgo", "Luxembourg"], jp: ["Japón", "Japan"], kr: ["Corea", "Korea"], cn: ["China", "China"],
  si: ["Eslovenia", "Slovenia"], ba: ["Bosnia", "Bosnia"], mk: ["Macedonia del Norte", "North Macedonia"], me: ["Montenegro", "Montenegro"],
  lat: ["Latino", "Latin"], int: ["Internacional", "International"], multi: ["Multi", "Multi"], en: ["Inglés", "English"],
  exyu: ["Ex-Yu", "Ex-Yu"], asia: ["Asia", "Asia"], afr: ["África", "Africa"], vip: ["VIP", "VIP"], ppv: ["PPV", "PPV"],
};
// A group's mark is "=" + the word as the panel wrote it ("=BEIN"): it is named as written.
const labelOf = (key, lang) => {
  if (String(key).startsWith("=")) return String(key).slice(1);
  const l = LABELS[key];
  return l ? l[lang === "en" ? 1 : 0] : String(key).toUpperCase();
};

// A full country name before a bar, ":" or "·", or between brackets, is a decoration like its code ("BOLIVIA | PAT PLUS",
// "MÉXICO: AZTECA 7", "[COSTA RICA] TELETICA"). Never before a dash, and never when the rest starts with another country:
// "ESPAÑA - ITALIA" and "ESPAÑA | ITALIA" are matches, not a channel filed under a country.
const NAME_SEP = "(?:\\s*" + BAR + "+\\s*|\\s*:\\s*|\\s*[•·●▪►»➤]\\s*)";
const LEAD_NAME = new RegExp("^\\s*(?:" + OPEN + "\\s*([\\p{L} .'’]{3,24}?)\\s*" + CLOSE + "\\s*|([\\p{L} .'’]{3,24}?)" + NAME_SEP + ")", "u");
const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
// Country names (both languages of LABELS, plus the panels' own spellings) -> key. Regions and tags stay codes only.
const COUNTRY_NAME = new Map();
for (const [k, names] of Object.entries(LABELS)) if (k.length === 2) for (const n of names) if (n.length > 3) COUNTRY_NAME.set(fold(n), k);
for (const [n, k] of [["espana", "es"], ["argentina", "ar"], ["estados unidos", "us"], ["republica dominicana", "do"],
  ["dominicana", "do"], ["inglaterra", "gb"], ["england", "gb"], ["united kingdom", "gb"], ["portugal", "pt"]]) COUNTRY_NAME.set(n, k);
const LATIN_TWO = /\p{Script=Latin}{2}/u;
const countryNamed = (text) => COUNTRY_NAME.get(fold(text)) || null;
// The first words of [rest] name a country ("ITALIA", "COSTA RICA · …"): then the name before it is part of a match.
const startsWithCountry = (rest) => {
  const words = fold(rest).split(" ");
  for (let n = Math.min(3, words.length); n >= 1; n--) if (COUNTRY_NAME.has(words.slice(0, n).join(" "))) return true;
  return false;
};

// HTML entities some panels leave in a name, once or twice escaped ("A&AMP;E", "A&amp;amp;E", "&#39;").
const ENTITY = /&(amp|quot|apos|lt|gt|nbsp|#\d{1,6}|#x[0-9a-f]{1,5});/gi;
const NAMED = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " };
/** [text] with the HTML entities a panel left in it decoded (also programme titles of the guide). Pure. */
export function decodeEntities(text) {
  let s = text;
  for (let i = 0; i < 3 && /&(?:[a-z]+|#x?[0-9a-f]+);/i.test(s); i++) {
    s = s.replace(ENTITY, (all, e) => {
      const k = e.toLowerCase();
      if (NAMED[k] != null) return NAMED[k];
      const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 31 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
    });
  }
  return s;
}

/** A name as Kino compares names (LiveChannelIdentity.normalizedName): accents dropped, case folded, spaces collapsed. */
export const normName = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// The codes of one decoration, or null when any of them is not a known code (then it is part of the name, "ESPN ┃F1┃ 2",
// unless it is a group at the start: see cleanChannelTitle).
function codesOf(text) {
  const marks = [];
  const quality = [];
  for (const t of String(text).split(/[\s/,+&-]+/)) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (COUNTRY[k]) marks.push(COUNTRY[k]);
    else if (REGION[k]) marks.push(REGION[k]);
    else if (QUALITY[k]) quality.push(QUALITY[k]);
    else return null;
  }
  return marks.length || quality.length ? { marks, quality } : null;
}

const hasWord = (s, w) => (" " + s.toUpperCase().replace(/[^A-Z0-9]+/g, " ") + " ").includes(" " + w + " ");

// Raw name -> its cleaning (bounded: emptied when full).
const MEMO_MAX = 20000;
const memo = new Map();

/**
 * `{ title, marks }` for one raw channel name: the title without its decorations (bars and the codes they frame, at the
 * start, at the end or between two bars, repeated or mixed), and the country/region/tag keys it dropped (quality words stay
 * in the title). A bar left between two parts of a name becomes " · ".
 * A name that is only a code ("ES", "UK") or would come out empty keeps its own text. Applying it twice changes nothing.
 * A group word before a panel bar ("BEIN ▎…") goes too, kept as the mark "=BEIN".
 * Remembered per raw name: a live category is cleaned again on every page Kino asks for.
 */
export function cleanChannelTitle(raw) {
  const key = String(raw == null ? "" : raw);
  let out = memo.get(key);
  if (!out) {
    if (memo.size >= MEMO_MAX) memo.clear();
    out = clean(key);
    memo.set(key, out);
  }
  return { title: out.title, marks: out.marks.slice() };
}

function clean(raw) {
  const original = decodeEntities(raw).replace(/\s+/g, " ").trim();
  if (!MAYBE_DECORATED.test(original)) return { title: original, marks: [] };
  let s = original;
  const marks = [];
  const quality = [];
  const take = (codes) => { marks.push(...codes.marks); quality.push(...codes.quality); };
  const trimmed = (t, re) => { const x = t.replace(re, ""); return HAS_TEXT.test(x) ? x : t; };
  for (let i = 0; i < 6; i++) {
    const m = s.match(LEAD_BRACKET) || (s = trimmed(s, LEAD_JUNK)).match(LEAD_SEP);
    const codes = m && codesOf(m[1]);
    const rest = m ? s.slice(m[0].length) : "";
    // A full country name ("BOLIVIA | PAT PLUS", "MEXICO ┃ AZTECA 7"): its key, like a code's, before the group rule below,
    // when a name in Latin letters follows that is not another country ("MOROCCO | المغرب" keeps both).
    if (!codes) {
      const n = s.match(LEAD_NAME);
      const key = n && countryNamed(n[1] || n[2]);
      const after = n ? s.slice(n[0].length) : "";
      if (key && LATIN_TWO.test(after) && !startsWithCountry(after)) {
        marks.push(key);
        s = after;
        continue;
      }
    }
    // A group before a panel bar goes when a name follows it: in "ESPN ▎MX", "ESPN ┃MX┃ 2" or "DAZN ▎ 2" the word is
    // the name.
    if (m && !codes && PANEL_BAR.test(m[0]) && GROUP.test(m[1]) && !NOT_GROUP.has(m[1]) && TWO_LETTERS.test(rest) &&
      !OPENS_WRAP.test(rest) && !codesOf(rest.replace(TRAIL_JUNK, ""))) {
      marks.push("=" + m[1]);
      s = rest;
      continue;
    }
    if (!codes || !HAS_TEXT.test(rest)) break;
    take(codes);
    s = rest;
  }
  for (let i = 0; i < 6; i++) {
    const m = s.match(TRAIL_BRACKET) || (s = trimmed(s, TRAIL_JUNK)).match(TRAIL_SEP);
    const codes = m && codesOf(m[1]);
    const front = m ? s.slice(0, m.index) : "";
    if (!codes || !HAS_TEXT.test(front)) break;
    take(codes);
    s = front;
  }
  s = s.replace(MID_BRACKET, (all, text, at, whole) => {
    const codes = codesOf(text);
    if (!codes || !HAS_TEXT.test(whole.slice(0, at)) || !HAS_TEXT.test(whole.slice(at + all.length))) return all;
    take(codes);
    return " ";
  });
  s = trimmed(trimmed(s.replace(BARS_LEFT, " · "), LEAD_JUNK), TRAIL_JUNK).replace(/\s+/g, " ").trim();
  for (const q of quality) if (!hasWord(s, q)) s += " " + q;
  if (!HAS_TEXT.test(s)) return { title: original, marks: [] };
  return { title: s, marks: [...new Set(marks)] };
}

/**
 * The shown titles of one list of channels ([names] are the panel's raw names), in order. Each loses its decorations.
 * When that leaves two channels of the list looking the same although their raw names differed, the codes that told them
 * apart come back discreetly as a suffix ("ESPN · México", in [lang]: "es" or "en"), only for those, and never the
 * list's own country or region [cat] (a channel of "ES ▎DEPORTE" needs no "· España").
 */
export function channelTitles(names, { cat = "", lang = "es" } = {}) {
  const list = Array.isArray(names) ? names : [];
  const parsed = list.map(cleanChannelTitle);
  const out = parsed.map((p) => p.title);
  const groups = new Map();
  parsed.forEach((p, i) => {
    const k = normName(p.title);
    const g = groups.get(k);
    if (g) g.push(i); else groups.set(k, [i]);
  });
  const own = String(cat || "").toLowerCase();
  for (const g of groups.values()) {
    if (g.length < 2 || new Set(g.map((i) => normName(list[i]))).size < 2) continue;
    // A mark every one of them dropped tells none apart ("EXYU ▎…" in a category whose region the key does not name).
    const common = new Set(parsed[g[0]].marks.filter((k) => g.every((i) => parsed[i].marks.includes(k))));
    const extra = (i) => parsed[i].marks.filter((k) => k !== own && !common.has(k));
    if (new Set(g.map((i) => extra(i).join("+"))).size < 2) continue; // the dropped codes do not tell them apart
    for (const i of g) {
      const e = extra(i);
      if (e.length) out[i] = parsed[i].title + " · " + e.map((k) => labelOf(k, lang)).join(" · ");
    }
  }
  return out;
}

/** The country or region key of a category name, as channelTitles takes it ("" when it names none). */
export const categoryKey = (name) => normCategory(name).cc;

/** [cards] (`{ title, … }`, one list) with their titles cleaned; everything else untouched. */
export function cleanCards(cards, opts) {
  if (!Array.isArray(cards) || !cards.length) return cards;
  const titles = channelTitles(cards.map((c) => (c && typeof c.title === "string" ? c.title : "")), opts);
  return cards.map((c, i) => (c && typeof c.title === "string" && titles[i] !== c.title ? { ...c, title: titles[i] } : c));
}

/** Rails of channel cards (`[{ title, items }]`, a feed or a snapshot) with every card's title cleaned, per rail. */
export function cleanRails(rails, lang) {
  if (!Array.isArray(rails)) return rails;
  return rails.map((r) => (r && Array.isArray(r.items) ? { ...r, items: cleanCards(r.items, { cat: categoryKey(r.title), lang }) } : r));
}
