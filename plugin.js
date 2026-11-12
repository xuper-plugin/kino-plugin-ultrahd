// src/store.js
var SOFT_CAP = 200 * 1024;
var CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 5 * 1024, keep: true },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hero: { match: (k) => k.startsWith("vinfo:"), budget: 30 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  recent: { match: (k) => k.startsWith("recent:"), budget: 30 * 1024 },
  idx: { match: (k) => k.startsWith("idx:"), budget: 6 * 1024 },
  tmdb: { match: (k) => k.startsWith("tmdb:"), budget: 24 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 }
};
var ORDER = ["servers", "cats", "hero", "hist", "recent", "idx", "tmdb", "misc"];
var IDX = "_idx";
var classOf = (key) => ORDER.find((c) => CLASSES[c].match(key));
function utf8Len(s) {
  let n = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 55296 && c <= 56319) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
var sizeOf = (key, value) => utf8Len(key) + utf8Len(value);
function readIndex() {
  try {
    const o = JSON.parse(kino.storage.get(IDX) || "null");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}
function writeIndex(idx) {
  try {
    kino.storage.set(IDX, JSON.stringify(idx));
  } catch (_) {
  }
}
function entries() {
  let keys = [];
  try {
    keys = kino.storage.keys();
  } catch (_) {
    return [];
  }
  const idx = readIndex();
  const out = [];
  for (const k of keys) {
    if (k === IDX) continue;
    let v = null;
    try {
      v = kino.storage.get(k);
    } catch (_) {
      v = null;
    }
    if (v === null || v === void 0) continue;
    out.push({ key: k, klass: classOf(k), bytes: sizeOf(k, v), ts: Number(idx[k]) || 0 });
  }
  return out;
}
function evict(list, idx, key) {
  try {
    kino.storage.remove(key);
  } catch (_) {
  }
  delete idx[key];
  const i = list.findIndex((e) => e.key === key);
  if (i >= 0) list.splice(i, 1);
}
function put(key, value) {
  try {
    const klass = classOf(key);
    const need = sizeOf(key, value);
    if (need > CLASSES[klass].budget) return false;
    const idx = readIndex();
    const list = entries().filter((e) => e.key !== key);
    const oldest = (pred) => list.filter(pred).sort((a, b) => a.ts - b.ts)[0];
    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest((e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(list, idx, victim.key);
    }
    let total = list.reduce((n, e) => n + e.bytes, 0) + need + 512;
    while (total > SOFT_CAP) {
      const victim = oldest((e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest((e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes;
      evict(list, idx, victim.key);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        kino.storage.set(key, value);
        idx[key] = Date.now();
        writeIndex(idx);
        return true;
      } catch (_) {
        const victim = oldest((e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(list, idx, victim.key);
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}
function get(key) {
  try {
    return kino.storage.get(key);
  } catch (_) {
    return null;
  }
}

// src/recent.js
var KEY = "recent:v1";
var MAX_RECENT = 12;
var MAX_TOTAL = 36;
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
  let text2 = JSON.stringify(kept);
  while (text2.length > 26 * 1024 && kept.length > 1) {
    kept = kept.slice(0, -1);
    text2 = JSON.stringify(kept);
  }
  put(KEY, text2);
}
function noteRecent(streamId, ext, srv) {
  const id = String(streamId);
  const all = readAll();
  const mine = all.filter((e) => e.srv === srv);
  if (mine[0] && mine[0].id === id) return;
  const prev = mine.find((e) => e.id === id);
  const entry = { id, srv, ext: String(ext || "mp4"), ...prev && prev.card ? { card: prev.card } : {} };
  const others = all.filter((e) => e.srv !== srv);
  writeAll([entry, ...mine.filter((e) => e.id !== id).slice(0, MAX_RECENT - 1), ...others]);
}
var recentEntriesAll = () => readAll();
function rememberCard(srv, id, card) {
  writeAll(readAll().map((e) => e.srv === srv && e.id === id ? { ...e, card } : e));
}

// src/names.js
var LANG_ORDER = ["es", "es-419", "es-ES", "en"];
var isLang = (l) => LANG_ORDER.includes(l) || /^x-[a-z0-9]+$/.test(String(l));
var CODE_NAMES = { nl: "Nederlands", ar: "\xC1rabe", de: "Deutsch", fr: "Fran\xE7ais", it: "Italiano", pt: "Portugu\xEAs", br: "Brasil", tr: "T\xFCrk\xE7e", ru: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", pl: "Polski", multi: "Multi-idioma", hi: "Hindi", in: "India", pk: "Pakist\xE1n", ro: "Rom\xE2n\u0103", al: "Shqip", gr: "\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC", se: "Svenska", no: "Norsk", dk: "Dansk", fi: "Suomi", cz: "\u010Ce\u0161tina", hu: "Magyar", bg: "\u0411\u044A\u043B\u0433\u0430\u0440\u0441\u043A\u0438", rs: "Srpski", hr: "Hrvatski", ex: "Ex-Yu", ir: "\u0641\u0627\u0631\u0633\u06CC", af: "Afrikaans", kr: "\uD55C\uAD6D\uC5B4", jp: "\u65E5\u672C\u8A9E", cn: "\u4E2D\u6587", th: "\u0E44\u0E17\u0E22", vn: "Ti\u1EBFng Vi\u1EC7t", ca: "Canad\xE1", au: "Australia", ie: "Irlanda", mx: "M\xE9xico" };
function langLabel(l) {
  if (LANG_LABELS[l]) return LANG_LABELS[l];
  const code = String(l).replace(/^x-/, "");
  const n = CODE_NAMES[code] || code.toUpperCase();
  return [n, n];
}
function displayTitle(raw) {
  const s = String(raw || "");
  const out = s.replace(/^\s*\|[^|]{1,24}\|\s*/, "").replace(/\s*\[[^\]]*\]/g, "").replace(/\s*\(\s*(?:(?:19|20)\d\d|LAT|CAST|ENG|SUB|DUAL|4K|UHD|FHD|HD)\s*\)/gi, "").replace(/^\s*(?:MULTI|LAT|CAST|ENG|SUB|DUAL)\s*[:\-–]\s+/i, "").replace(/(?:\s+[-–]?\s*(?:2160p|1080p|720p|480p|4K|UHD|FHD|HDR\d*|HD|WEB-?DL|BluRay|BDRip|HDRip|x26[45]|HEVC))+\s*$/i, "").replace(/^[\s|:·•★☆▪■●–—-]+|[\s|:·•★☆–—-]+$/g, "").replace(/\s+/g, " ").trim();
  return out || s.trim();
}
var SUFFIX_LANG = { LAT: "es-419", CAST: "es-ES", ENG: "en" };
var PREFIX_LANG = { LAT: "es-419", LATINO: "es-419", LATAM: "es-419", ES: "es-ES", ESP: "es-ES", CAST: "es-ES", EN: "en", ENG: "en", US: "en", UK: "en", USA: "en" };
function prefixedCategory(raw) {
  const m = raw.match(/^\s*\|\s*([^|]{1,30}?)\s*\|\s*(.+)$/);
  if (!m) return null;
  const code = m[1].replace(/\s*\/.*$/, "").trim();
  const rest = m[2].split("|").map((p) => p.trim()).filter(Boolean).join(" \xB7 ");
  const lang = PREFIX_LANG[code.toUpperCase()] || "x-" + (code.toLowerCase().replace(/[^a-z0-9]/g, "") || "otros");
  return { lang, title: rest };
}
function cleanCategoryName(name) {
  const raw = String(name || "").trim();
  const pre = prefixedCategory(raw);
  if (pre) return pre;
  const m = raw.match(/[\s\-–]*\(\s*(LAT|CAST|ENG)\s*\)\s*$/i);
  const title2 = (m ? raw.slice(0, m.index) : raw).replace(/[\s\-–]+$/, "").trim();
  return { title: title2 || raw, lang: m ? SUFFIX_LANG[m[1].toUpperCase()] : "es-419" };
}
var ADULT = /(\bxxx\b|\badult[oa]?s?\b|\bporn\w*|\ber[oó]tic\w*|\bsex(o|y)?\b|\bhentai\b|\beros\b|\+\s?18|18\s?\+|\b18\s?plus\b)/i;
var isAdultName = (name) => ADULT.test(String(name || ""));
var KEEP_UPPER = /* @__PURE__ */ new Set(["NBA", "NFL", "NHL", "MLB", "UFC", "WNBA", "NCAAB", "PPV", "DAZN", "RFEF", "ESPN", "HBO", "CNN", "LMP", "VIX", "USA", "UK", "TV", "FHD", "HD", "LAT", "DC", "ABC", "NBC", "CBS", "TNT", "AMC", "SVT", "ITV", "BBC", "RAI", "ZDF", "CBC", "RTVE", "NHK"]);
var LOWER_WORDS = /* @__PURE__ */ new Set(["Y", "E", "O", "A", "DE", "DEL", "LA", "LAS", "LOS", "EL", "EN", "THE", "OF", "AND"]);
function titleCase(text2) {
  const s = String(text2 || "");
  if (/\p{Ll}/u.test(s)) return s;
  let first = true;
  return s.split(/([\s\-/]+)/).map((w) => {
    if (w === "" || /^[\s\-/]+$/.test(w)) return w;
    const letters = w.replace(/[^\p{L}]/gu, "");
    const atStart = first;
    first = false;
    if (/\d/.test(w) || KEEP_UPPER.has(letters)) return w;
    if (!atStart && LOWER_WORDS.has(letters)) return w.toLowerCase();
    if (letters.length <= 2 && letters === w) return w;
    return w.charAt(0) + w.slice(1).toLocaleLowerCase();
  }).join("");
}
function prettyLiveTitle(raw) {
  const original = String(raw || "").trim();
  let s = original.replace(/[︎️‍]/g, "");
  s = s.replace(/[^\p{L}\p{N}\s&+./'|,:()-]/gu, " ").replace(/\|/g, "   |   ");
  const chunks = s.split(/\s{3,}/).map((c) => c.trim()).filter(Boolean).map((c) => {
    if (c === "|") return "\xB7";
    return /^(?:[\p{L}\p{N}] ){2,}[\p{L}\p{N}]$/u.test(c) ? c.replace(/ /g, "") : c.replace(/\s+/g, " ");
  });
  const out = chunks.join(" ").replace(/^[\s\-·|:]+|[\s\-·|:]+$/g, "").trim();
  return out ? titleCase(out) : original;
}
var norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
var COUNTRY_PHRASES = [
  ["ARGENTINA", "AR"],
  ["BRASIL", "BR"],
  ["BRAZIL", "BR"],
  ["BOLIVIA", "BO"],
  ["CHILE", "CL"],
  ["COLOMBIA", "CO"],
  ["COSTA RICA", "CR"],
  ["CUBA", "CU"],
  ["CURACAO", "CW"],
  ["ECUADOR", "EC"],
  ["EL SALVADOR", "SV"],
  ["GUATEMALA", "GT"],
  ["HAITI", "HT"],
  ["HONDURAS", "HN"],
  ["JAMAIKA", "JM"],
  ["JAMAICA", "JM"],
  ["MEXICO", "MX"],
  ["NICARAGUA", "NI"],
  ["PANAMA", "PA"],
  ["PARAGUAY", "PY"],
  ["PERU", "PE"],
  ["PUERTO RICO", "PR"],
  ["R DOMINICANA", "DO"],
  ["REPUBLICA DOMINICANA", "DO"],
  ["DOMINICANA", "DO"],
  ["URUGUAY", "UY"],
  ["VENEZUELA", "VE"],
  ["ESPANA", "ES"],
  ["CANADA", "CA"],
  ["USA", "US"],
  ["ESTADOS UNIDOS", "US"],
  ["FRANCE", "FR"],
  ["GERMANY", "DE"],
  ["ITALY", "IT"],
  ["PORTUGAL", "PT"],
  ["UK", "GB"],
  ["NETHERLANDS", "NL"],
  ["MARRUECOS", "MA"]
].sort((a, b) => b[0].length - a[0].length);
function countryMatch(title2) {
  const t = norm(title2);
  const padded = ` ${t} `;
  for (const [phrase, cc] of COUNTRY_PHRASES) {
    if (padded.includes(` ${phrase} `)) return { cc, exact: t === phrase || t.replace(/ \d+$/, "") === phrase, starts: t.startsWith(phrase + " ") };
  }
  return null;
}
var countryOf = (title2) => {
  const m = countryMatch(title2);
  return m ? m.cc : null;
};
function liveGenreOf(title2) {
  const t = norm(title2);
  if (/\b(RADIO|MUSICA|MUSIC)\b/.test(t)) return "musica";
  if (/\b(KIDS|INFANTIL|INFANTILES|CARTOON|CARTOONS|ANIMACION|DIBUJOS)\b/.test(t)) return "infantil";
  if (/\bANIME\b/.test(t)) return "anime";
  if (/\b(DOCUMENTARY|DOCUMENTALES|DOCUMENTAL|SCIENCE|CULTURA)\b/.test(t)) return "documentales";
  if (/\b(NEWS|NOTICIAS)\b/.test(t)) return "noticias";
  if (/\b(SPORTS|SPORT|DEPORTES|FUTBOL|LEAGUE|LIGA|NBA|NFL|NHL|MLB|WNBA|UFC|NCAAB|F1|FORMULA|MOTOR|TENIS|BEISBOL|BASEBALL|CHAMPIONS|LIBERTADORES|SUDAMERICANA|PPV|EVENTOS|EVENTS|EVENT)\b/.test(t)) return "deportes";
  if (/\b(MOVIES|CINE|PELICULAS|FILM)\b/.test(t)) return "peliculas";
  if (/\b(SERIES|REALITY|NOVELAS)\b/.test(t)) return "series";
  if (/\b(ENTRETENIMIENTO|ENTERTAINMENT)\b/.test(t)) return "entretenimiento";
  return null;
}
var LANG_LABELS = {
  es: ["Espa\xF1ol", "Spanish"],
  "es-419": ["Latino", "Latin"],
  "es-ES": ["Espa\xF1a", "Spain"],
  en: ["English", "English"]
};

// src/titleIndex.js
var BASE = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd-data/data/";
var FORMAT = 1;
var STATE_KEY = "idx:state";
var DAY_MS = 24 * 3600 * 1e3;
var BATCH_MIN = 25;
var BATCH_MAX = 500;
var TARGET_MS = 300;
var batchSize = 100;
var lastBatchMs = 0;
var timed = async (st, rows, fn) => {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  lastBatchMs = ms;
  if (ms < TARGET_MS / 2) batchSize = Math.min(BATCH_MAX, batchSize * 2);
  else if (ms > TARGET_MS * 1.5) batchSize = Math.max(BATCH_MIN, Math.floor(batchSize / 2));
  const p = st.perf || (st.perf = { b: 0, ms: 0, rows: 0 });
  p.b++;
  p.ms += ms;
  p.rows += rows;
};
var partCache = null;
var MIN_COVERAGE = 0.9;
var MAX_TITLE = 300;
var REV = /^\d{8}T\d{6}Z$/;
var RETRY_FIRST_MS = 60 * 1e3;
var RETRY_LATER_MS = 10 * 60 * 1e3;
var fetchBase = BASE;
function cleanTitle(raw, yearField) {
  let name = String(raw || "").replace(/[\r\n\t]+/g, " ");
  let year = 0;
  for (let i = 0; i < 6; i++) {
    const before = name;
    name = name.replace(/\s*\(\s*(LAT|CAST|ENG|SUB|DUAL|4K|UHD|FHD|HD)\s*\)\s*$/i, "").replace(/\s*\[\s*(LAT|CAST|ENG|SUB)\s*\]\s*$/i, "");
    const y = name.match(/\s*\(\s*((?:19|20)\d\d)\s*\)\s*$/);
    if (y) {
      if (!year) year = Number(y[1]);
      name = name.slice(0, y.index);
    }
    if (name === before) break;
  }
  if (/^(19|20)\d\d$/.test(String(yearField || "").trim())) year = Number(String(yearField).trim());
  name = name.replace(/\s+/g, " ").trim();
  if (name.length > MAX_TITLE) name = name.slice(0, MAX_TITLE).replace(/[\uD800-\uDBFF]$/, "").trim();
  return { name, year };
}
var findKey = (text2) => String(text2 || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function h32(s, seed) {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function idOf(kind, find, year) {
  const k = `${find}|${year || 0}`;
  return (kind === "movies" ? "m-" : "s-") + h32(k, 2166136261).toString(36) + h32(k, 2538058380).toString(36);
}
var hasCatalog = () => {
  try {
    return typeof kino !== "undefined" && !!kino.catalog && typeof kino.catalog.search === "function";
  } catch (_) {
    return false;
  }
};
function readState() {
  try {
    const o = JSON.parse(get(STATE_KEY) || "null");
    return o && typeof o === "object" && o.v === FORMAT ? o : null;
  } catch (_) {
    return null;
  }
}
function writeState(st) {
  put(STATE_KEY, JSON.stringify(st));
}
async function safeCount() {
  try {
    const r = await kino.catalog.count();
    return typeof r === "number" ? r : r && typeof r.count === "number" ? r.count : -1;
  } catch (_) {
    return -1;
  }
}
var sleep = async (ms) => {
  try {
    if (typeof kino.sleep === "function") await kino.sleep(ms);
  } catch (_) {
  }
};
async function fetchJson(file, hash, tries) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await kino.fetch(`${fetchBase}${file}?v=${hash || Date.now()}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw last || new Error("descarga fallida");
}
var isList = (x) => Array.isArray(x);
function validManifest(m) {
  if (!m || typeof m !== "object" || m.v !== FORMAT || typeof m.generated !== "string" || typeof m.hash !== "string") return false;
  if (typeof m.revision !== "string" || !REV.test(m.revision)) return false;
  if (!(m.coverage >= MIN_COVERAGE && m.coverage <= 1)) return false;
  for (const k of ["movies", "series"]) {
    const s = m[k];
    if (!s || !isList(s.parts) || !isList(s.hashes) || s.parts.length !== s.hashes.length || !Number.isInteger(s.count)) return false;
    if (s.parts.some((f) => typeof f !== "string" || !new RegExp(`^${k}-\\d+\\.json$`).test(f))) return false;
    if (s.hashes.some((h) => typeof h !== "string")) return false;
  }
  return m.movies.parts.length + m.series.parts.length > 0;
}
function chainFor(rev, m) {
  const list = isList(m.deltas) ? m.deltas.filter((d) => d && REV.test(d.from) && REV.test(d.to) && d.file === `delta-${d.from}-${d.to}.json`) : [];
  const i = list.findIndex((d) => d.from === rev);
  if (i < 0) return null;
  const chain = list.slice(i);
  for (let j = 1; j < chain.length; j++) if (chain[j].from !== chain[j - 1].to) return null;
  return chain[chain.length - 1].to === m.revision && chain.length <= 7 ? chain.map((d) => ({ file: d.file, to: d.to })) : null;
}
function validPart(p) {
  if (!p || typeof p.name !== "string" || !isList(p.year) || !isList(p.tmdb) || !isList(p.cats)) throw new Error("trozo inv\xE1lido");
  const names = p.name === "" ? [] : p.name.split("\n");
  if (p.year.length !== names.length || p.tmdb.length !== names.length || p.cats.length !== names.length) throw new Error("listas desalineadas");
  return { names, year: p.year, tmdb: p.tmdb, cats: p.cats };
}
function validDelta(d, from, to) {
  if (!d || d.from !== from || d.to !== to || !Number.isInteger(d.total) || !isList(d.added) || !isList(d.removed)) throw new Error("delta inv\xE1lido");
  for (const e of d.added) {
    if (!e || e.k !== "m" && e.k !== "s" || typeof e.n !== "string" || !e.n || e.n.length > MAX_TITLE || !Number.isInteger(e.y) || !Number.isInteger(e.t) || !isList(e.c)) throw new Error("delta: entrada inv\xE1lida");
  }
  if (d.removed.some((id) => typeof id !== "string" || !/^[ms]-[a-z0-9]{2,26}$/.test(id))) throw new Error("delta: id inv\xE1lido");
  return d;
}
var rowOf = (kindLetter, name, year, tmdb, cats, r) => ({
  id: idOf(kindLetter === "m" ? "movies" : "series", findKey(name), year),
  title: name,
  sort: year,
  data: { y: year, t: tmdb, c: (isList(cats) ? cats.filter((x) => Number.isInteger(x)) : []).slice(0, 8), r }
});
var dataOf = (row) => {
  const d = row && row.data;
  if (d && typeof d === "object") return d;
  try {
    return JSON.parse(d || "{}") || {};
  } catch (_) {
    return {};
  }
};
async function upsertKeeping(rows, existing) {
  if (existing && rows.length) {
    let have = [];
    try {
      have = await kino.catalog.get(rows.map((r) => r.id)) || [];
    } catch (_) {
      have = [];
    }
    const byId = new Map(have.map((x) => [x.id, dataOf(x)]));
    for (const r of rows) {
      const old = byId.get(r.id);
      if (old && !r.data.t && old.t) r.data.t = old.t;
      if (old && old.a && !r.data.t) r.data.a = old.a;
    }
  }
  return kino.catalog.upsert(rows);
}
var running = null;
var sourceTag = (base) => h32(String(base), 2166136261).toString(36);
function indexFitsServer(url) {
  const st = readState();
  if (!st || !st.src) return true;
  return st.src === sourceTag(url);
}
async function indexLabel(serverUrl) {
  if (!hasCatalog()) return "No cargada: este Kino no trae cat\xE1logo, la b\xFAsqueda va en vivo";
  const st = readState();
  const n = await safeCount();
  const fmt = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const ago = (ts) => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 6e4));
    return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  };
  if (st && st.stage) return `Descargando\u2026 ${fmt(Math.max(n, 0))}${st.stage.total ? " de " + fmt(st.stage.total) : ""} t\xEDtulos`;
  if (st && st.done && st.rev && n > 0) {
    const parts = ["Cargada", st.mc ? `${fmt(st.mc)} pel\xEDculas \xB7 ${fmt(st.sc || 0)} series` : `${fmt(n)} t\xEDtulos`];
    const gen = st.gen ? String(st.gen).replace("T", " ").slice(0, 16) + " UTC" : "";
    if (gen) parts.push("lista del " + gen);
    if (st.checked) parts.push("comprobada hace " + ago(st.checked));
    parts.push("en el aparato: " + fmt(n));
    if (serverUrl && !indexFitsServer(serverUrl)) parts.push("es de otro servidor que el activo: aqu\xED la b\xFAsqueda va en vivo (con \xABCambiar servidor\xBB puedes volver al primero)");
    if (st.perf && st.perf.b) parts.push(`lote medio ${Math.round(st.perf.ms / st.perf.b)} ms (${Math.round(st.perf.rows / st.perf.b)} filas)`);
    return parts.join(" \xB7 ");
  }
  if (st && st.done && n === 0) return "Vac\xEDa: se volver\xE1 a descargar al abrir Inicio";
  if (st && st.retryAt && Date.now() < st.retryAt) return "No se pudo descargar; se reintenta sola (sin red o GitHub no responde)";
  return "No cargada todav\xEDa: se descarga al abrir Inicio";
}
function indexNeeded() {
  if (!hasCatalog()) return false;
  const st = readState();
  if (!st || !st.done) return !(st && st.retryAt && Date.now() < st.retryAt && !st.stage);
  if (st.stage) return true;
  return st.src === void 0 || Date.now() - (st.checked || 0) >= DAY_MS;
}
function indexStep(opts = {}) {
  if (!hasCatalog()) return Promise.resolve("unsupported");
  if (running) return running;
  running = step(opts).catch(() => "error").then((r) => {
    running = null;
    return r;
  });
  return running;
}
var stats = { downloads: 0, upserted: 0, removed: 0 };
async function download(file, hash, tries) {
  stats.downloads++;
  return fetchJson(file, hash, tries);
}
function snapshotStage(m, fresh) {
  return {
    mode: "snapshot",
    src: m.src || "",
    target: m.revision,
    hash: m.hash,
    gen: m.generated,
    mc: m.movies.count,
    sc: m.series.count,
    total: m.movies.count + m.series.count,
    fresh,
    files: [...m.movies.parts.map((f, i) => [f, m.movies.hashes[i]]), ...m.series.parts.map((f, i) => [f, m.series.hashes[i]])],
    next: 0,
    offset: 0,
    fails: 0,
    purge: null
  };
}
async function step({ budgetMs = 6e3 } = {}) {
  const deadline = Date.now() + budgetMs;
  let st = readState();
  const now = Date.now();
  if (st && st.rev) {
    const c = await safeCount();
    if (c === 0) st = null;
  }
  if (st && st.done && !st.stage && st.src !== void 0 && now - (st.checked || 0) < DAY_MS) return "fresh";
  if (st && st.retryAt && now < st.retryAt && !st.stage) return "wait";
  if (!st || !st.stage) {
    const first = !st || !st.done;
    let m;
    try {
      m = await download("index.json", "", first ? 3 : 1);
      if (!validManifest(m)) throw new Error("manifiesto inv\xE1lido");
    } catch (_) {
      const keep = st || { v: FORMAT, done: false, snap: 0 };
      keep.retryAt = Date.now() + (first ? RETRY_FIRST_MS : RETRY_LATER_MS);
      writeState(keep);
      return "error";
    }
    if (st && st.done && st.rev === m.revision) {
      st.checked = now;
      st.retryAt = 0;
      st.src = m.src || "";
      writeState(st);
      return "fresh";
    }
    const usable = !!st && st.done && await safeCount() > 0;
    const chain = usable ? chainFor(st.rev, m) : null;
    if (usable && chain) {
      st.stage = { mode: "delta", src: m.src || "", target: m.revision, hash: m.hash, gen: m.generated, mc: m.movies.count, sc: m.series.count, chain, next: 0, offA: 0, offR: 0, fails: 0, snap: snapshotStage(m, false) };
    } else if (usable) {
      st.stage = snapshotStage(m, false);
    } else {
      try {
        await kino.catalog.clear();
      } catch (_) {
        return "error";
      }
      st = { v: FORMAT, done: false, snap: st && st.snap ? st.snap : 0, checked: 0 };
      st.stage = snapshotStage(m, true);
    }
    if (st.stage.mode === "snapshot") st.snap = (st.snap || 0) + 1;
    st.retryAt = 0;
    writeState(st);
  }
  for (let guard = 0; guard < 4 && st.stage; guard++) {
    const out = st.stage.mode === "delta" ? await runDelta(st, deadline) : await runSnapshot(st, deadline);
    if (out !== "again") return out;
  }
  return "paused";
}
async function runDelta(st, deadline) {
  const sg = st.stage;
  const toSnapshot = () => {
    st.stage = sg.snap;
    st.snap = (st.snap || 0) + 1;
    writeState(st);
    return "again";
  };
  while (sg.next < sg.chain.length) {
    if (Date.now() + 2e3 > deadline) {
      writeState(st);
      return "paused";
    }
    const { file, to } = sg.chain[sg.next];
    const from = sg.next === 0 ? st.rev : sg.chain[sg.next - 1].to;
    let d;
    try {
      d = validDelta(await download(file, to, 1), from, to);
    } catch (e) {
      sg.fails++;
      if (sg.fails >= 2 || /inválid|desaline/.test(String(e && e.message))) return toSnapshot();
      writeState(st);
      return "error";
    }
    try {
      for (let off = sg.offA; off < d.added.length; ) {
        if (Date.now() + lastBatchMs > deadline) {
          sg.offA = off;
          writeState(st);
          return "paused";
        }
        const n = batchSize;
        const rows = d.added.slice(off, off + n).map((e) => rowOf(e.k, e.n, e.y, e.t, e.c, st.snap));
        await timed(st, rows.length, () => upsertKeeping(rows, true));
        stats.upserted += rows.length;
        off += n;
      }
      sg.offA = d.added.length;
      for (let off = sg.offR; off < d.removed.length; ) {
        if (Date.now() + lastBatchMs > deadline) {
          sg.offR = off;
          writeState(st);
          return "paused";
        }
        const n = batchSize;
        const ids = d.removed.slice(off, off + n);
        await timed(st, ids.length, () => kino.catalog.remove(ids));
        stats.removed += ids.length;
        off += n;
      }
    } catch (e) {
      if (e && e.code === "limit") {
        st.capped = true;
      } else {
        writeState(st);
        return "error";
      }
    }
    if (!st.capped) {
      const c = await safeCount();
      if (c >= 0 && c !== d.total) return toSnapshot();
    }
    st.rev = to;
    st.total = d.total;
    sg.next++;
    sg.offA = 0;
    sg.offR = 0;
    sg.fails = 0;
    writeState(st);
  }
  st.hash = sg.hash;
  st.gen = sg.gen;
  st.mc = sg.mc || 0;
  st.sc = sg.sc || 0;
  st.src = sg.src || "";
  st.done = true;
  st.checked = Date.now();
  st.retryAt = 0;
  st.stage = null;
  writeState(st);
  return "done";
}
async function runSnapshot(st, deadline) {
  const sg = st.stage;
  while (sg.next < sg.files.length) {
    if (!(partCache && sg.offset > 0) && Date.now() + 1200 > deadline) {
      writeState(st);
      return "paused";
    }
    const [file, hash] = sg.files[sg.next];
    const kind = file.startsWith("movies") ? "m" : "s";
    let part;
    try {
      if (partCache && partCache.file === file && partCache.hash === hash) part = partCache.part;
      else {
        part = validPart(await download(file, hash, 1));
        partCache = { file, hash, part };
      }
    } catch (_) {
      sg.fails++;
      if (sg.fails >= 3) {
        st.stage = null;
        st.retryAt = Date.now() + RETRY_LATER_MS;
        writeState(st);
        return "error";
      }
      writeState(st);
      return "error";
    }
    for (let off = sg.offset; off < part.names.length; ) {
      if (Date.now() + lastBatchMs > deadline) {
        sg.offset = off;
        writeState(st);
        return "paused";
      }
      const n = batchSize;
      const rows = [];
      for (let i = off; i < Math.min(off + n, part.names.length); i++) {
        const title2 = part.names[i];
        if (title2 && title2.length <= MAX_TITLE) rows.push(rowOf(kind, title2, Number(part.year[i]) || 0, Number(part.tmdb[i]) || 0, part.cats[i], st.snap));
      }
      try {
        await timed(st, rows.length, () => upsertKeeping(rows, !sg.fresh));
        stats.upserted += rows.length;
        off += n;
      } catch (e) {
        if (e && e.code === "limit") {
          st.capped = true;
          sg.next = sg.files.length;
          break;
        }
        sg.offset = off;
        writeState(st);
        return "error";
      }
    }
    if (st.capped) break;
    partCache = null;
    sg.next++;
    sg.offset = 0;
    sg.fails = 0;
    writeState(st);
  }
  if (!sg.fresh && !st.capped) {
    if (!sg.purge) sg.purge = { offset: 0 };
    for (; ; ) {
      if (Date.now() + 1500 > deadline) {
        writeState(st);
        return "paused";
      }
      let page;
      try {
        page = await kino.catalog.search({ q: "", limit: 100, offset: sg.purge.offset, order: "title" });
      } catch (_) {
        writeState(st);
        return "error";
      }
      const items = page && isList(page.items) ? page.items : [];
      if (!items.length) break;
      const stale = items.filter((r) => dataOf(r).r !== st.snap).map((r) => r.id);
      if (stale.length) {
        try {
          await kino.catalog.remove(stale);
          stats.removed += stale.length;
        } catch (_) {
          writeState(st);
          return "error";
        }
      }
      sg.purge.offset += items.length - stale.length;
      if (items.length < 100) break;
    }
  }
  st.rev = sg.target;
  st.hash = sg.hash;
  st.gen = sg.gen;
  st.mc = sg.mc || 0;
  st.sc = sg.sc || 0;
  st.src = sg.src || "";
  st.total = sg.total;
  st.done = true;
  st.checked = Date.now();
  st.retryAt = 0;
  st.stage = null;
  writeState(st);
  return "done";
}
var indexStale = () => {
  const st = readState();
  return !!st && st.done && !st.stage && (st.src === void 0 || Date.now() - (st.checked || 0) >= DAY_MS);
};
var indexReady = () => {
  const st = readState();
  return hasCatalog() && !!st && st.done;
};
function itemOfRow(row) {
  const movie = String(row.id).startsWith("m-");
  const d = dataOf(row);
  const year = Number(d.y) || Number(row.sort) || 0;
  const cats = Array.isArray(d.c) ? d.c : [];
  const t = Number(d.t) || 0;
  return {
    id: row.id,
    ref: `idx:${movie ? "m" : "s"}:${findKey(row.title)}|${year}|${cats.join(",")}`,
    title: displayTitle(row.title),
    kind: movie ? "movie" : "series",
    year: year ? String(year) : void 0,
    ...t > 0 ? { ids: { tmdb: t } } : {}
  };
}
var idxRefFor = (kind, title2, year) => title2 && Number(year) ? `idx:${kind === "series" ? "s" : "m"}:${findKey(title2)}|${Number(year)}|` : null;
async function indexSearch(q, type = "any", limit = 60) {
  if (!hasCatalog()) return null;
  const st = readState();
  if (!st || !st.done) return null;
  let res;
  try {
    res = await kino.catalog.search({ q: String(q || "").slice(0, 250), limit: 100, order: "newest" });
  } catch (_) {
    return null;
  }
  if (!res || !isList(res.items)) return null;
  if (!res.items.length && await safeCount() === 0) {
    writeState({ ...st, done: false, rev: "", stage: null, checked: 0, hash: "" });
    return null;
  }
  const want = type === "movie" ? "m-" : type === "series" ? "s-" : "";
  const items = res.items.filter((r) => !want || String(r.id).startsWith(want)).slice(0, limit).map(itemOfRow);
  return { items, total: res.total || items.length };
}
function parseIdxRef(ref) {
  const m = /^idx:([ms]):([^|]*)\|(\d*)\|([\d,]*)$/.exec(String(ref || ""));
  if (!m) return null;
  return { kind: m[1] === "m" ? "movies" : "series", find: m[2], year: Number(m[3]) || 0, cats: m[4] ? m[4].split(",").map(Number).filter((n) => n > 0).slice(0, 4) : [] };
}
var catNames = null;
async function indexCategoryNames() {
  if (catNames) return catNames;
  try {
    const j = await fetchJson("categories.json", "", 1);
    catNames = { vod: j && j.vod || {}, series: j && j.series || {} };
  } catch (_) {
    catNames = { vod: {}, series: {} };
  }
  return catNames;
}
async function resolveIdxRef(ref, fetchCategory2, moreCats) {
  const p = parseIdxRef(ref);
  if (!p) throw kino.error("not_found", "ref desconocido");
  const action2 = p.kind === "movies" ? "get_vod_streams" : "get_series";
  let failed = 0;
  let tried = 0;
  const seen = /* @__PURE__ */ new Set();
  const look = async (cat) => {
    if (seen.has(String(cat))) return null;
    seen.add(String(cat));
    tried++;
    let data;
    try {
      data = await fetchCategory2(action2, cat);
    } catch (_) {
      failed++;
      return null;
    }
    for (const x of data) {
      const { name, year } = cleanTitle(x.name || x.title, x.year || (x.release_date ? String(x.release_date).slice(0, 4) : ""));
      if (year !== p.year || findKey(name) !== p.find) continue;
      return p.kind === "movies" ? `vod:${x.stream_id}:${x.container_extension || "mp4"}` : `series:${x.series_id}`;
    }
    return null;
  };
  let list = [];
  if (typeof moreCats === "function") {
    const names = (await indexCategoryNames())[p.kind === "movies" ? "vod" : "series"];
    const wanted = p.cats.map((id) => names[id]).filter(Boolean).map((e) => [String(e[0]), String(e[1])]);
    try {
      list = await moreCats(p.kind, wanted);
    } catch (_) {
      list = [];
    }
    const same = Number(list.matched) || 0;
    for (const cat of list.slice(0, same)) {
      const r = await look(cat);
      if (r) return r;
    }
  }
  for (const cat of p.cats) {
    const r = await look(cat);
    if (r) return r;
  }
  if (typeof moreCats === "function") {
    const deadline = Date.now() + 12e3;
    const rest = list.filter((c) => !seen.has(String(c))).slice(0, 16);
    for (let i = 0; i < rest.length && Date.now() < deadline; i += 3) {
      const found2 = await Promise.all(rest.slice(i, i + 3).map(look));
      const r = found2.find(Boolean);
      if (r) return r;
    }
  }
  if (failed === tried && failed > 0) throw kino.error("unavailable", "no se pudo consultar el cat\xE1logo", { userMessage: "No se pudo abrir el t\xEDtulo. Int\xE9ntalo de nuevo." });
  throw kino.error("not_found", "el t\xEDtulo ya no est\xE1 en el cat\xE1logo", { userMessage: "Este t\xEDtulo ya no est\xE1 disponible." });
}

// src/tmdbLazy.js
var DAY_MS2 = 864e5;
var RETRY_DAYS = 14;
var CONCURRENCY = 3;
var MAP_KEY = "tmdb:cache";
var MAP_MAX_BYTES = 22 * 1024;
var disabled = false;
var stats2 = { queries: 0, cached: 0, skippedFresh: 0, found: 0, missed: 0, errors: 0, rateLimited: 0 };
var today = () => Math.floor(Date.now() / DAY_MS2);
var tmdbAvailable = () => {
  try {
    return !disabled && typeof kino !== "undefined" && typeof kino.tmdb === "function";
  } catch (_) {
    return false;
  }
};
var yearOfResult = (r) => {
  const d = r.release_date || r.first_air_date || "";
  return /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : 0;
};
function pickTmdbFull(results, entry) {
  const list = Array.isArray(results) ? results : [];
  const okYear = (r) => !entry.year || !yearOfResult(r) || Math.abs(yearOfResult(r) - entry.year) <= 1;
  const same = list.filter((r) => [r.title, r.name, r.original_title, r.original_name].some((t) => t && findKey(t) === entry.find) && okYear(r));
  if (same.length) return same[0];
  if (list.length === 1 && okYear(list[0]) && entry.year) return list[0];
  return null;
}
var POSTER = "https://image.tmdb.org/t/p/w342";
var posterUrl = (p) => p && p !== "-" ? POSTER + p : void 0;
function readMap() {
  try {
    const o = JSON.parse(get(MAP_KEY) || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}
function writeMap(map) {
  let ids = Object.keys(map);
  let text2 = JSON.stringify(map);
  while (text2.length > MAP_MAX_BYTES && ids.length > 1) {
    delete map[ids.shift()];
    text2 = JSON.stringify(map);
  }
  put(MAP_KEY, text2);
}
async function withTimeout(p, ms) {
  if (typeof kino.sleep !== "function") return p;
  let timer = null;
  const gate = new Promise((res) => {
    timer = kino.sleep(Math.max(50, ms)).then(() => res({ timeout: true }));
  });
  const out = await Promise.race([p.then((v) => ({ v })), gate]);
  if (out.timeout) throw Object.assign(new Error("tiempo agotado"), { code: "timeout" });
  return out.v;
}
async function queryOne(c) {
  const params = { query: c.name, language: "es-MX", include_adult: false };
  if (c.year) params[c.tv ? "first_air_date_year" : "year"] = c.year;
  const res = await kino.tmdb(c.tv ? "/search/tv" : "/search/movie", params);
  const r = pickTmdbFull(res && res.results, c);
  return r ? { id: r.id, p: typeof r.poster_path === "string" ? r.poster_path : "" } : { id: 0, p: "" };
}
var hasCatalogGet = () => {
  try {
    return typeof kino.catalog === "object" && kino.catalog && typeof kino.catalog.get === "function";
  } catch (_) {
    return false;
  }
};
async function enrichTmdb(items, { max = 24, budgetMs = 2500 } = {}) {
  try {
    if (!tmdbAvailable() || !Array.isArray(items) || !items.length) return 0;
    const deadline = Date.now() + budgetMs;
    const cands = [];
    const seen = /* @__PURE__ */ new Set();
    for (const it of items.slice(0, 48)) {
      if (!it || it.poster || it.kind !== "movie" && it.kind !== "series" || !it.title) continue;
      const { name, year } = cleanTitle(it.title, it.year);
      const find = findKey(name);
      if (!find) continue;
      const tv = it.kind === "series";
      const id = /^[ms]-/.test(String(it.id)) ? String(it.id) : idOf(tv ? "series" : "movies", find, year);
      const shown = displayTitle(name);
      if (seen.has(id)) continue;
      seen.add(id);
      cands.push({ item: it, id, name: shown, find: findKey(shown), year, tv, kind: tv ? "series" : "movies" });
    }
    if (!cands.length) return 0;
    const rows = /* @__PURE__ */ new Map();
    if (hasCatalogGet()) {
      try {
        for (const r of await kino.catalog.get(cands.map((c) => c.id)) || []) rows.set(r.id, r);
      } catch (_) {
      }
    }
    const map = readMap();
    const now = today();
    const queue = [];
    for (const c of cands) {
      const row = rows.get(c.id);
      const d = row ? dataOf(row) : null;
      const t = d ? Number(d.t) || 0 : map[c.id] && map[c.id][0] || 0;
      const tried = d ? Number(d.a) || 0 : map[c.id] && map[c.id][1] || 0;
      const p = d ? typeof d.p === "string" ? d.p : "" : map[c.id] && typeof map[c.id][2] === "string" ? map[c.id][2] : "";
      if (t > 0 && p) {
        c.item.ids = { ...c.item.ids || {}, tmdb: t };
        if (!c.item.poster) c.item.poster = posterUrl(p);
        stats2.cached++;
        continue;
      }
      if (t > 0) {
        c.item.ids = { ...c.item.ids || {}, tmdb: t };
      }
      if (tried && now - tried < RETRY_DAYS) {
        stats2.skippedFresh++;
        continue;
      }
      queue.push(c);
    }
    const work = queue.slice(0, max);
    const done = [];
    let stop = false;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
      while (!stop && next < work.length && Date.now() < deadline) {
        const c = work[next++];
        try {
          stats2.queries++;
          const r = await withTimeout(queryOne(c), deadline - Date.now());
          const id = r.id;
          done.push([c, id, r.p]);
          if (id) {
            stats2.found++;
            c.item.ids = { ...c.item.ids || {}, tmdb: id };
            if (r.p && !c.item.poster) c.item.poster = posterUrl(r.p);
          } else stats2.missed++;
        } catch (e) {
          stats2.errors++;
          const code = e && e.code;
          if (code === "rate_limited") {
            stats2.rateLimited++;
            stop = true;
          } else if (code === "no_tmdb_key") {
            disabled = true;
            stop = true;
          } else if (code === "timeout") stop = true;
        }
      }
    }));
    if (done.length) {
      const upserts = [];
      let mapDirty = false;
      for (const [c, id, p] of done) {
        const row = rows.get(c.id);
        if (row) upserts.push({ id: row.id, title: row.title, sort: row.sort, data: { ...dataOf(row), t: id, ...id ? { p: p || "-" } : {}, ...id ? { a: 0 } : { a: now } } });
        else {
          delete map[c.id];
          map[c.id] = id ? [id, now, p || "-"] : [id, now];
          mapDirty = true;
        }
      }
      if (upserts.length) {
        try {
          await kino.catalog.upsert(upserts);
        } catch (_) {
        }
      }
      if (mapDirty) writeMap(map);
    }
    return cands.filter((c) => c.item.ids && c.item.ids.tmdb).length;
  } catch (_) {
    return 0;
  }
}

// src/categoryTable.js
var VOD = {
  "1147": ["Estrenos 2026", "es-419", "estrenos", 0, "H"],
  "1102": ["Estrenos 2026", "es-ES", "estrenos", 25, ""],
  "1125": ["New Releases 2026", "en", "estrenos", 48, ""],
  "1149": ["Cine 2025", "es-419", "estrenos", 102, "H"],
  "1151": ["Cine 2025", "es-ES", "estrenos", 126, ""],
  "1154": ["Movies 2025", "en", "estrenos", 149, ""],
  "1150": ["Cine 2024", "es-419", "estrenos", 203, ""],
  "1152": ["Cine 2024", "es-ES", "estrenos", 227, ""],
  "1153": ["Movies 2024", "en", "estrenos", 250, ""],
  "1126": ["Acci\xF3n", "es-419", "generos", 10004, "H"],
  "1055": ["Acci\xF3n", "es-ES", "generos", 10028, ""],
  "1104": ["Action", "en", "generos", 10051, ""],
  "1129": ["Comedia", "es-419", "generos", 10109, "H"],
  "1058": ["Comedia", "es-ES", "generos", 10133, ""],
  "1107": ["Comedy", "en", "generos", 10155, ""],
  "1136": ["Terror", "es-419", "generos", 10223, "H"],
  "1065": ["Terror", "es-ES", "generos", 10246, ""],
  "1114": ["Horror", "en", "generos", 10261, ""],
  "1128": ["Animaci\xF3n", "es-419", "generos", 10305, "H"],
  "1132": ["Drama", "es-419", "generos", 10312, "H"],
  "1057": ["Animaci\xF3n", "es-ES", "generos", 10329, ""],
  "1061": ["Drama", "es-ES", "generos", 10336, ""],
  "1110": ["Drama", "en", "generos", 10357, ""],
  "1127": ["Aventura", "es-419", "generos", 10406, "H"],
  "1056": ["Aventura", "es-ES", "generos", 10430, ""],
  "1106": ["Animation", "en", "generos", 10453, ""],
  "1146": ["Ciencia Ficci\xF3n", "es-419", "generos", 10508, ""],
  "1101": ["Ciencia Ficci\xF3n", "es-ES", "generos", 10532, ""],
  "1105": ["Adventure", "en", "generos", 10552, ""],
  "1141": ["Suspenso", "es-419", "generos", 10622, ""],
  "1070": ["Suspenso", "es-ES", "generos", 10645, ""],
  "1118": ["Science Fiction", "en", "generos", 10665, ""],
  "1139": ["Romance", "es-419", "generos", 10721, ""],
  "1068": ["Romance", "es-ES", "generos", 10744, ""],
  "1117": ["Romance", "en", "generos", 10764, ""],
  "1120": ["Thriller", "en", "generos", 10766, ""],
  "1133": ["Familia", "es-419", "generos", 10813, ""],
  "1062": ["Familia", "es-ES", "generos", 10837, ""],
  "1111": ["Family", "en", "generos", 10854, ""],
  "1130": ["Crimen", "es-419", "generos", 10910, ""],
  "1059": ["Crimen", "es-ES", "generos", 10934, ""],
  "1108": ["Crime", "en", "generos", 10956, ""],
  "1134": ["Fantas\xEDa", "es-419", "generos", 11014, ""],
  "1063": ["Fantas\xEDa", "es-ES", "generos", 11038, ""],
  "1112": ["Fantasy", "en", "generos", 11059, ""],
  "1138": ["Misterio", "es-419", "generos", 11116, ""],
  "1067": ["Misterio", "es-ES", "generos", 11140, ""],
  "1116": ["Mystery", "en", "generos", 11163, ""],
  "1142": ["B\xE9lica", "es-419", "generos", 11207, ""],
  "1071": ["B\xE9lica", "es-ES", "generos", 11231, ""],
  "1121": ["War", "en", "generos", 11268, ""],
  "1131": ["Documental", "es-419", "generos", 11311, ""],
  "1060": ["Documental", "es-ES", "generos", 11335, ""],
  "1109": ["Documentary", "en", "generos", 11358, ""],
  "1135": ["Historia", "es-419", "generos", 11415, ""],
  "1064": ["Historia", "es-ES", "generos", 11439, ""],
  "1113": ["History", "en", "generos", 11460, ""],
  "1137": ["M\xFAsica", "es-419", "generos", 11518, ""],
  "1066": ["M\xFAsica", "es-ES", "generos", 11541, ""],
  "1115": ["Music", "en", "generos", 11562, ""],
  "1143": ["Western", "es-419", "generos", 11624, ""],
  "1072": ["Western", "es-ES", "generos", 11647, ""],
  "1122": ["Western", "en", "generos", 11669, ""],
  "1155": ["Cine Cam", "es-419", "otros", 48901, "h"],
  "1253": ["Religion", "es-419", "otros", 48917, ""],
  "1144": ["Otros", "es-419", "otros", 48919, ""],
  "1140": ["Pelicula de TV", "es-419", "otros", 48920, ""],
  "1089": ["Others", "es-ES", "otros", 48942, ""],
  "1069": ["Pel\xEDcula de TV", "es-ES", "otros", 48943, ""],
  "1119": ["TV Movie", "en", "otros", 48967, ""],
  "1047": ["Eros +18", "es-419", "otros", 48970, "a"],
  "1158": ["TestApp", "es-419", "otros", 48971, "h"]
};
var SERIES = {
  "684": ["Netflix", "es-419", "plataformas", 0, "H"],
  "1053": ["Netflix", "es-ES", "plataformas", 75, ""],
  "687": ["Disney+", "es-419", "plataformas", 101, "H"],
  "1052": ["Disney", "es-ES", "plataformas", 165, ""],
  "688": ["HBO", "es-419", "plataformas", 204, "H"],
  "1197": ["HBO Max", "es-ES", "plataformas", 270, ""],
  "1017": ["Amazon Prime", "es-419", "plataformas", 303, "H"],
  "1051": ["Amazon", "es-ES", "plataformas", 357, ""],
  "1213": ["Amazon", "en", "plataformas", 385, ""],
  "1021": ["Apple TV+", "es-419", "plataformas", 402, ""],
  "1189": ["Apple TV", "es-ES", "plataformas", 461, ""],
  "1054": ["Paramount", "es-419", "plataformas", 506, ""],
  "778": ["Max", "es-419", "plataformas", 628, ""],
  "704": ["Hulu", "es-419", "plataformas", 724, ""],
  "698": ["Peacock", "es-419", "plataformas", 833, ""],
  "729": ["Showtime", "es-419", "plataformas", 943, ""],
  "1205": ["Skyshowtime", "es-ES", "plataformas", 1079, ""],
  "748": ["Starz", "es-419", "plataformas", 1146, ""],
  "730": ["Mgm+", "es-419", "plataformas", 1229, ""],
  "1192": ["Crunchyroll", "es-ES", "plataformas", 1364, ""],
  "1195": ["Filmin", "es-ES", "plataformas", 1468, ""],
  "711": ["Movistar Plus+", "es-419", "plataformas", 1530, ""],
  "1201": ["Movistar", "es-ES", "plataformas", 1574, ""],
  "777": ["VIX Premium", "es-419", "plataformas", 1654, ""],
  "1208": ["Tivify", "es-ES", "plataformas", 1782, ""],
  "720": ["Quibi", "es-419", "plataformas", 1834, ""],
  "742": ["Youtube", "es-419", "plataformas", 1955, ""],
  "1016": ["Otras Plataformas", "es-419", "plataformas", 2032, ""],
  "1040": ["Novelas", "es-419", "generos", 20005, ""],
  "1206": ["Telenovelas", "es-ES", "generos", 20180, ""],
  "1207": ["Telenovelas Latinas", "es-ES", "generos", 20181, ""],
  "1041": ["Series Animadas", "es-419", "generos", 20238, ""],
  "1187": ["Animadas", "es-ES", "generos", 20359, ""],
  "1042": ["Series Anime", "es-419", "generos", 20439, ""],
  "1188": ["Anime", "es-ES", "generos", 20560, ""],
  "1043": ["Series Documentales", "es-419", "generos", 20640, ""],
  "1193": ["Docuseries", "es-ES", "generos", 20766, ""],
  "1044": ["Series Dramas", "es-419", "generos", 20841, ""],
  "1198": ["K-Dramas", "es-ES", "generos", 20971, ""],
  "1209": ["Turkas", "es-ES", "generos", 21083, ""],
  "1199": ["Latinas", "es-ES", "generos", 21172, ""],
  "1045": ["Series Retro", "es-419", "generos", 21242, ""],
  "1050": ["Variadas", "es-ES", "generos", 21384, ""],
  "696": ["ABC", "es-419", "canales", 30007, ""],
  "717": ["ABC TV", "es-419", "canales", 30008, ""],
  "697": ["Fox", "es-419", "canales", 30119, ""],
  "707": ["NBC", "es-419", "canales", 30231, ""],
  "725": ["CBS", "es-419", "canales", 30315, ""],
  "718": ["TNT", "es-419", "canales", 30451, ""],
  "769": ["AMC", "es-419", "canales", 30509, ""],
  "1186": ["AMC", "es-ES", "canales", 30558, ""],
  "716": ["FX", "es-419", "canales", 30622, ""],
  "745": ["The CW", "es-419", "canales", 30750, ""],
  "686": ["Syfy", "es-419", "canales", 30848, ""],
  "780": ["USA Network", "es-419", "canales", 30952, ""],
  "804": ["Freeform", "es-419", "canales", 31021, ""],
  "868": ["Lifetime", "es-419", "canales", 31127, ""],
  "874": ["Discovery", "es-419", "canales", 31218, ""],
  "744": ["History", "es-419", "canales", 31323, ""],
  "1018": ["BBC", "es-419", "canales", 31412, ""],
  "1019": ["ITV", "es-419", "canales", 31525, ""],
  "714": ["Channel 4", "es-419", "canales", 31616, ""],
  "1020": ["SVT", "es-419", "canales", 31747, ""],
  "756": ["ZDF", "es-419", "canales", 31856, ""],
  "690": ["Das Erste", "es-419", "canales", 31917, ""],
  "773": ["Rte One", "es-419", "canales", 32036, ""],
  "1022": ["CBC", "es-419", "canales", 32114, ""],
  "1023": ["RTVE", "es-419", "canales", 32237, ""],
  "1202": ["RTVE", "es-ES", "canales", 32276, ""],
  "1024": ["France TV", "es-419", "canales", 32320, ""],
  "1025": ["RAI", "es-419", "canales", 32435, ""],
  "821": ["Sky", "es-419", "canales", 32544, ""],
  "708": ["Telecinco", "es-419", "canales", 32649, ""],
  "760": ["Antena 3", "es-419", "canales", 32710, ""],
  "721": ["Atresplayer", "es-419", "canales", 32811, ""],
  "1191": ["Atresplayer", "es-ES", "canales", 32863, ""],
  "1190": ["Atresmedia", "es-ES", "canales", 32962, ""],
  "764": ["Canal+", "es-419", "canales", 33013, ""],
  "855": ["Las Estrellas", "es-419", "canales", 33126, ""],
  "723": ["Viaplay", "es-419", "canales", 33253, ""],
  "757": ["Stan", "es-419", "canales", 33345, ""],
  "1194": ["Eventos Deportivos", "es-ES", "otros", 48967, ""],
  "1196": ["Formula 1", "es-ES", "otros", 48969, ""],
  "1200": ["Moto GP", "es-ES", "otros", 48973, ""],
  "1203": ["Series 4K", "es-ES", "otros", 48977, ""],
  "1204": ["Series TV", "es-ES", "otros", 48978, ""]
};
var LIVE = {
  "eventos diarios 03 11": ["Eventos Diarios 03/11", "", "deportes", "premium", 0, ""],
  "eventos diarios exclusivos": ["Eventos Diarios \xB7 Exclusivos", "", "deportes", "premium", 1, ""],
  "cine premium": ["Cine Premium", "", "peliculas", "premium", 2, ""],
  "deportes premium": ["Deportes Premium", "", "deportes", "premium", 4, ""],
  "movies channels usa": ["Movies Channels - USA", "US", "peliculas", "paises", 10003, ""],
  "documentary science usa": ["Documentary & Science - USA", "US", "documentales", "paises", 10007, ""],
  "entertainment usa": ["Entertainment - USA", "US", "entretenimiento", "paises", 10009, ""],
  "news usa": ["News - USA", "US", "noticias", "paises", 10013, ""],
  "kids cartoons usa": ["Kids & Cartoons - USA", "US", "infantil", "paises", 10015, ""],
  "usa 24 7 mix": ["USA - 24/7 - Mix", "US", "", "paises", 10029, ""],
  "cine box 24 7 usa": ["Cine Box - 24/7 - USA", "US", "peliculas", "paises", 10032, ""],
  "argentina": ["Argentina", "AR", "", "paises", 10047, ""],
  "brasil": ["Brasil", "BR", "", "paises", 10048, ""],
  "bolivia": ["Bolivia", "BO", "", "paises", 10050, ""],
  "bolivia 2 test": ["Bolivia 2 (test)", "BO", "", "paises", 10051, "h"],
  "canada general": ["Canada - General", "CA", "", "paises", 10052, ""],
  "canada cinema entertainment": ["Canada - Cinema - Entertainment", "CA", "entretenimiento", "paises", 10053, ""],
  "canada french": ["Canada - French", "CA", "", "paises", 10055, ""],
  "canada local": ["Canada - Local", "CA", "", "paises", 10056, ""],
  "canada kids": ["Canada - Kids", "CA", "infantil", "paises", 10057, ""],
  "chile": ["Chile", "CL", "", "paises", 10058, ""],
  "colombia": ["Colombia", "CO", "", "paises", 10059, ""],
  "colombia 2": ["Colombia 2", "CO", "", "paises", 10060, ""],
  "costa rica": ["Costa Rica", "CR", "", "paises", 10061, ""],
  "curacao": ["Cura\xE7ao", "CW", "", "paises", 10062, ""],
  "cuba": ["Cuba", "CU", "", "paises", 10063, ""],
  "ecuador": ["Ecuador", "EC", "", "paises", 10064, ""],
  "el salvador": ["EL Salvador", "SV", "", "paises", 10066, ""],
  "guatemala": ["Guatemala", "GT", "", "paises", 10067, ""],
  "haiti": ["Haiti", "HT", "", "paises", 10068, ""],
  "honduras": ["Honduras", "HN", "", "paises", 10069, ""],
  "jamaika": ["Jamaika", "JM", "", "paises", 10071, ""],
  "mexico": ["Mexico", "MX", "", "paises", 10072, ""],
  "vix mexico": ["VIX - Mexico", "MX", "", "paises", 10073, ""],
  "nicaragua": ["Nicaragua", "NI", "", "paises", 10075, ""],
  "panama": ["Panama", "PA", "", "paises", 10076, ""],
  "paraguay": ["Paraguay", "PY", "", "paises", 10077, ""],
  "peru": ["Peru", "PE", "", "paises", 10078, ""],
  "puerto rico": ["Puerto Rico", "PR", "", "paises", 10080, ""],
  "r dominicana": ["R. Dominicana", "DO", "", "paises", 10081, ""],
  "uruguay": ["Uruguay", "UY", "", "paises", 10083, ""],
  "uruguay 2": ["Uruguay 2", "UY", "", "paises", 10084, ""],
  "abc local usa": ["ABC - Local - USA", "US", "", "paises", 10085, ""],
  "cbs local usa": ["CBS Local - USA", "US", "", "paises", 10086, ""],
  "cw local usa": ["CW - Local - USA", "US", "", "paises", 10087, ""],
  "fox local usa": ["Fox - Local - USA", "US", "", "paises", 10089, ""],
  "nbc local usa": ["NBC - Local - USA", "US", "", "paises", 10090, ""],
  "venezuela": ["Venezuela", "VE", "", "paises", 10091, ""],
  "espana": ["Espa\xF1a", "ES", "", "paises", 10092, ""],
  "cine y series espana": ["Cine y Series Espa\xF1a", "ES", "peliculas", "paises", 10093, ""],
  "documentales espana": ["Documentales Espa\xF1a", "ES", "documentales", "paises", 10098, ""],
  "dazn espana": ["DAZN Espa\xF1a", "ES", "", "paises", 10099, ""],
  "espana autonomicos": ["Espa\xF1a - Autonomicos", "ES", "", "paises", 10101, ""],
  "france": ["France", "FR", "", "paises", 10102, ""],
  "germany": ["Germany", "DE", "", "paises", 10104, ""],
  "italy": ["Italy", "IT", "", "paises", 10105, ""],
  "marruecos": ["Marruecos", "MA", "", "paises", 10106, ""],
  "netherlands": ["Netherlands", "NL", "", "paises", 10107, ""],
  "portugal": ["Portugal", "PT", "", "paises", 10108, ""],
  "uk": ["UK", "GB", "", "paises", 10110, ""],
  "sports usa": ["Sports - USA", "US", "deportes", "deportes", 20005, ""],
  "directv sports ar co ec pe ch ur": ["Directv Sports AR-CO-EC-PE-CH-UR", "", "deportes", "deportes", 20016, ""],
  "champions league": ["Champions League", "", "deportes", "deportes", 20036, ""],
  "formula 1": ["Formula 1", "", "deportes", "deportes", 20037, ""],
  "motor event": ["Motor - Event", "", "deportes", "deportes", 20038, ""],
  "nba eventos": ["NBA Eventos", "", "deportes", "deportes", 20039, ""],
  "nhl eventos": ["NHL Eventos", "", "deportes", "deportes", 20040, ""],
  "nfl eventos": ["NFL Eventos", "", "deportes", "deportes", 20041, ""],
  "peacock events": ["Peacock Events", "", "deportes", "deportes", 20042, ""],
  "ppv events": ["PPV Events", "", "deportes", "deportes", 20043, ""],
  "tenis padel": ["Tenis / Padel", "", "deportes", "deportes", 20044, ""],
  "ufc eventos": ["UFC Eventos", "", "deportes", "deportes", 20045, ""],
  "wnba events": ["WNBA Events", "", "deportes", "deportes", 20046, ""],
  "brasil sports": ["Brasil Sports", "BR", "deportes", "deportes", 20049, ""],
  "canada sports": ["Canada - Sports", "CA", "deportes", "deportes", 20054, ""],
  "liga pro ec": ["Liga Pro EC", "", "deportes", "deportes", 20065, ""],
  "deportes honduras": ["Deportes Honduras", "HN", "deportes", "deportes", 20070, ""],
  "liga mexicana baseball lmp": ["Liga Mexicana Baseball - LMP", "", "deportes", "deportes", 20074, ""],
  "deportes peru": ["Deportes Peru", "PE", "deportes", "deportes", 20079, ""],
  "beisbol r dominicana": ["Beisbol R. Dominicana", "DO", "deportes", "deportes", 20082, ""],
  "liga endesa": ["Liga Endesa", "", "deportes", "deportes", 20094, ""],
  "futbol espana": ["Futbol Espa\xF1a", "ES", "deportes", "deportes", 20095, ""],
  "deportes espana": ["Deportes Espa\xF1a", "ES", "deportes", "deportes", 20097, ""],
  "france sports": ["France Sports", "FR", "deportes", "deportes", 20103, ""],
  "portugal sports": ["Portugal Sports", "PT", "deportes", "deportes", 20109, ""],
  "uk sports": ["UK Sports", "GB", "deportes", "deportes", 20111, ""],
  "deportes arabes": ["Deportes Arabes", "", "deportes", "deportes", 20112, ""],
  "conference league": ["Conference League", "", "deportes", "deportes", 20113, ""],
  "copa sudamericana": ["Copa Sudamericana", "", "deportes", "deportes", 20114, ""],
  "europa league": ["Europa League", "", "deportes", "deportes", 20115, ""],
  "libertadores": ["Libertadores", "", "deportes", "deportes", 20116, ""],
  "mlb eventos": ["MLB Eventos", "", "deportes", "deportes", 20117, ""],
  "ncaab solo eventos": ["NCAAB - Solo Eventos", "", "deportes", "deportes", 20118, ""],
  "nfl teams only events": ["NFL Teams - Only Events", "", "deportes", "deportes", 20119, ""],
  "premier league": ["Premier League", "", "deportes", "deportes", 20120, ""],
  "todo motor": ["Todo Motor", "", "deportes", "deportes", 20121, ""],
  "cultura": ["Cultura", "", "documentales", "tematicos", 30006, ""],
  "entretenimiento": ["Entretenimiento", "", "entretenimiento", "tematicos", 30008, ""],
  "noticias": ["Noticias", "", "noticias", "tematicos", 30012, ""],
  "infantiles": ["Infantiles", "", "infantil", "tematicos", 30014, ""],
  "24 7 animacion": ["24/7 - Animacion", "", "infantil", "tematicos", 30017, ""],
  "24 7 dibujos animados n": ["24/7 - Dibujos Animados-N", "", "infantil", "tematicos", 30020, ""],
  "24 7 series y reality n": ["24/7 - Series y Reality-N", "", "series", "tematicos", 30021, ""],
  "24 7 peliculas n": ["24/7 - Peliculas-N", "", "peliculas", "tematicos", 30022, ""],
  "24 7 anime": ["24/7 Anime", "", "anime", "tematicos", 30023, ""],
  "24 7 documentales": ["24/7 - Documentales", "", "documentales", "tematicos", 30024, ""],
  "extra cine": ["Extra Cine", "", "peliculas", "tematicos", 30026, ""],
  "novelas y novelas": ["Novelas y Novelas", "", "series", "tematicos", 30027, ""],
  "musica": ["Musica", "", "musica", "tematicos", 30033, ""],
  "radio 60 70": ["Radio 60,70", "", "musica", "radio", 40122, ""],
  "radio 80 90": ["Radio 80,90", "", "musica", "radio", 40123, ""],
  "radio alternativo": ["Radio Alternativo", "", "musica", "radio", 40124, ""],
  "radio cristiana": ["Radio Cristiana", "", "musica", "radio", 40125, ""],
  "radio clasica": ["Radio Clasica", "", "musica", "radio", 40126, ""],
  "radio club": ["Radio Club", "", "musica", "radio", 40127, ""],
  "radio pop": ["Radio Pop", "", "musica", "radio", 40128, ""],
  "radio retro": ["Radio Retro", "", "musica", "radio", 40129, ""],
  "radio dance": ["Radio Dance", "", "musica", "radio", 40130, ""],
  "radio disco": ["Radio Disco", "", "musica", "radio", 40131, ""],
  "radio electronica": ["Radio Electronica", "", "musica", "radio", 40132, ""],
  "radio hard rock": ["Radio Hard Rock", "", "musica", "radio", 40133, ""],
  "radio hip hop": ["Radio Hip Hop", "", "musica", "radio", 40134, ""],
  "radio jazz": ["Radio Jazz", "", "musica", "radio", 40135, ""],
  "radio latino": ["Radio Latino", "", "musica", "radio", 40136, ""],
  "radio reggae": ["Radio Reggae", "", "musica", "radio", 40137, ""],
  "radio salsa": ["Radio Salsa", "", "musica", "radio", 40138, ""],
  "radio sinfonica": ["Radio Sinfon\xEDca", "", "musica", "radio", 40139, ""],
  "radio techno": ["Radio Techno", "", "musica", "radio", 40140, ""],
  "radio metal": ["Radio Metal", "", "musica", "radio", 40141, ""],
  "telemundo unimas univision galavision": ["Telemundo-Unimas-Univision-Galavision", "", "", "otros", 50010, ""],
  "telemundo unimas univision galavision opc2": ["Telemundo - Unimas - Univision - Galavision OPC2", "", "", "otros", 50011, ""],
  "24 7 comedia": ["24/7 - Comedia", "", "", "otros", 50018, ""],
  "24 7 programas de tv": ["24/7 - Programas de TV", "", "", "otros", 50019, ""],
  "24 7 temporal": ["24/7 - Temporal", "", "", "otros", 50025, "h"],
  "vix": ["VIX", "", "", "otros", 50028, ""],
  "gran hermano uy": ["Gran Hermano UY", "", "", "otros", 50030, ""],
  "la granja vip": ["LA Granja Vip", "", "", "otros", 50031, ""],
  "religion": ["Religion", "", "", "otros", 50034, ""],
  "club fight": ["Club Fight", "", "", "otros", 50035, ""],
  "testapp": ["Testapp", "", "", "otros", 50088, "h"],
  "rfef tv": ["RFEF TV", "", "", "otros", 50100, ""],
  "adultos": ["Adultos", "", "", "otros", 50142, "a"]
};

// src/categoryRules.js
var GROUPS = ["estrenos", "generos", "plataformas", "canales", "otros"];
var GROUP_ORDER = { vod: GROUPS, series: ["plataformas", "estrenos", "generos", "canales", "otros"] };
var LIVE_GROUPS = ["premium", "paises", "deportes", "tematicos", "radio", "otros"];
var normKey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
var ESTRENOS = /\b(estrenos?|new releases?)\b|\b(cine|movies?|peliculas?) (19|20)\d\d\b/;
var PLATFORMS = ["netflix", "disney", "hbo", "amazon", "apple", "paramount", "max", "hulu", "peacock", "showtime", "skyshowtime", "starz", "mgm", "crunchyroll", "filmin", "movistar", "vix", "tivify", "quibi", "youtube", "otras plataformas"];
var CHANNELS = ["abc", "fox", "nbc", "cbs", "tnt", "amc", "fx", "the cw", "syfy", "usa network", "freeform", "lifetime", "discovery", "history", "bbc", "itv", "channel 4", "svt", "zdf", "das erste", "rte one", "cbc", "rtve", "france tv", "rai", "sky", "telecinco", "antena 3", "atresplayer", "atresmedia", "canal", "las estrellas", "viaplay", "stan"];
var VOD_GENRES = ["accion", "action", "comedia", "comedy", "terror", "horror", "drama", "animacion", "animation", "aventura", "adventure", "ciencia ficcion", "science fiction", "suspenso", "thriller", "romance", "familia", "family", "crimen", "crime", "fantasia", "fantasy", "misterio", "mystery", "belica", "war", "documental", "documentary", "historia", "history", "musica", "music", "western"];
var SERIES_GENRES = ["novelas", "telenovelas", "series animadas", "animadas", "series anime", "anime", "series documentales", "docuseries", "series dramas", "k dramas", "turkas", "latinas", "series retro", "variadas"];
var hasWord = (t, w) => (" " + t + " ").includes(" " + w + " ");
var indexIn = (list, t) => list.findIndex((w) => hasWord(t, w));
function groupOf(kind, title2) {
  const t = normKey(title2);
  if (ESTRENOS.test(t)) {
    if (/\b(estrenos?|new releases?)\b/.test(t)) return { group: "estrenos", rank: 0 };
    const year = Number((t.match(/(?:19|20)\d\d/) || [2025])[0]);
    return { group: "estrenos", rank: 1 + Math.abs(2025 - year) };
  }
  if (kind === "series") {
    let i = indexIn(PLATFORMS, t);
    if (i >= 0) return { group: "plataformas", rank: i };
    i = indexIn(SERIES_GENRES, t);
    if (i >= 0) return { group: "generos", rank: i };
    i = indexIn(CHANNELS, t);
    if (i >= 0) return { group: "canales", rank: i };
    return { group: "otros", rank: 400 };
  }
  const g = indexIn(VOD_GENRES, t);
  if (g >= 0) return { group: "generos", rank: Math.floor(g / 2) };
  return { group: "otros", rank: 400 };
}
function liveGroupOf(title2, country, genre) {
  const t = normKey(title2);
  if (/\b(premium|eventos diarios|exclusivos)\b/.test(t)) return "premium";
  if (/^radio\b/.test(t)) return "radio";
  if (genre === "deportes") return "deportes";
  if (country) return "paises";
  if (genre) return "tematicos";
  return "otros";
}
function fallbackVod(kind, id, name, i) {
  const { title: title2, lang } = cleanCategoryName(name);
  const { group } = groupOf(kind, title2);
  return { id: String(id), name, title: titleCase(title2), lang, group, order: GROUP_ORDER[kind].indexOf(group) * 1e4 + 9e3 + Math.min(i, 999), home: false, adult: isAdultName(name), known: false };
}
function fallbackLive(name, i) {
  const title2 = prettyLiveTitle(name);
  const country = countryOf(title2) || countryOf(name) || "";
  const genre = liveGenreOf(title2) || liveGenreOf(name) || "";
  const group = liveGroupOf(title2, country, genre);
  return { name, title: title2, country, genre, group, order: LIVE_GROUPS.indexOf(group) * 1e4 + 9e3 + Math.min(i, 999), adult: isAdultName(name), known: false };
}

// src/categories.js
var langRank = (l) => {
  const i = LANG_ORDER.indexOf(l);
  return i < 0 ? LANG_ORDER.length : i;
};
var SEARCH_GROUPS = ["generos", "estrenos", "plataformas", "canales", "otros"];
function mergeVod(kind, list, { showAdult: showAdult2 = false, table = null } = {}) {
  const T = table || (kind === "vod" ? VOD : SERIES);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    const id = String(c.category_id || "");
    const name = String(c.category_name || "").trim();
    if (!id || !name) return;
    const e = T[id];
    let cat;
    if (e && normKey(cleanCategoryName(name).title) === normKey(e[0])) {
      const [title2, lang, group, order, flags] = e;
      if (flags.includes("h")) return;
      cat = { id, name, title: title2, lang, group, order, home: flags.includes("H"), adult: flags.includes("a"), known: true };
      if (/^\s*\|/.test(name)) {
        const p = cleanCategoryName(name);
        cat.lang = p.lang;
        cat.title = p.title;
        cat.home = false;
      }
    } else cat = fallbackVod(kind, id, name, i);
    if (cat.adult && !showAdult2) return;
    const key = cat.lang + "|" + normKey(cat.title);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cat);
  });
  return out.sort((a, b) => Number(a.adult) - Number(b.adult) || langRank(a.lang) - langRank(b.lang) || a.order - b.order);
}
var searchOrder = (cats) => [...cats].sort((a, b) => Number(a.adult) - Number(b.adult) || langRank(a.lang) - langRank(b.lang) || SEARCH_GROUPS.indexOf(a.group) - SEARCH_GROUPS.indexOf(b.group) || a.order - b.order);
var homeOrder = (cats) => [...cats.filter((c) => c.home && !c.adult), ...cats.filter((c) => !(c.home && !c.adult) && !c.adult)];
function mergeLive(list, { showAdult: showAdult2 = false } = {}) {
  const seen = /* @__PURE__ */ new Map();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    const id = String(c.category_id || "");
    const name = String(c.category_name || "").trim();
    if (!id || !name) return;
    const key = normKey(prettyLiveTitle(name));
    const e = LIVE[key];
    let cat;
    if (e) {
      const [title2, country, genre, group, order, flags] = e;
      if (flags.includes("h")) return;
      cat = { id, name, title: title2, country, genre, group, order, adult: flags.includes("a"), known: true };
    } else cat = { id, ...fallbackLive(name, i) };
    if (cat.adult && !showAdult2) return;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) cat.title = `${cat.title} (${n})`;
    out.push(cat);
  });
  return out.sort((a, b) => a.order - b.order);
}

// src/catalog.js
var BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
var VEGETA_VERSION_CODE = "21";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
var SRVS_V = 2;
var PER_PAGE = 60;
var HOME_PREVIEW = 20;
function cfg(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v === void 0 || v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}
var showAdult = () => cfg("showAdult", false) === true;
var liveFormat = () => cfg("liveFormat", "m3u8") === "ts" ? "ts" : "m3u8";
var homeCountry = () => String(cfg("homeCountry", "none"));
function parseServerLine(line) {
  const url = line.split(/\s/)[0].trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (!path.endsWith("player_api.php") && !path.endsWith("get.php")) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    const password = u.searchParams.get("password") || u.searchParams.get("pass") || "";
    if (!username) return null;
    const base = (u.protocol + "//" + u.host).replace(/\/+$/, "");
    const name = line.slice(url.length).trim().replace(/^\[|\]$/g, "").trim().slice(0, 40);
    return { url: base, username, password, ...name ? { name } : {} };
  } catch (_) {
    return null;
  }
}
var vegetaHeaders = (code) => ({
  "X-Vegeta-Version-Code": String(code),
  "X-Vegeta-Servers-Direct": "1",
  "Cache-Control": "no-cache, no-store",
  "Pragma": "no-cache"
});
function readVersionCode() {
  try {
    const v = String(kino.storage.get("vcode") || "");
    return /^\d+$/.test(v) && Number(v) >= Number(VEGETA_VERSION_CODE) ? v : VEGETA_VERSION_CODE;
  } catch (_) {
    return VEGETA_VERSION_CODE;
  }
}
var MAX_SERVERS = 30;
function parseServers(text2) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of String(text2).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const s = parseServerLine(t);
    if (!s) continue;
    const key = s.url + "|" + s.username;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => (b.url.startsWith("https://") ? 1 : 0) - (a.url.startsWith("https://") ? 1 : 0));
}
async function fetchServerList() {
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" } });
    let data = null;
    try {
      data = r.json();
    } catch (_) {
      data = null;
    }
    if (!r.ok || !data || data.ok === false) {
      const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
      if (attempt === 0 && want > Number(code)) {
        code = String(want);
        continue;
      }
      throw kino.error("unavailable", "bootstrap " + r.status, { userMessage: "No se pudo conectar con el servicio." });
    }
    let list = [];
    if (typeof data.servers_text === "string" && data.servers_text.trim()) list = parseServers(data.servers_text);
    if (!list.length && typeof data.servers_url === "string" && data.servers_url.trim()) {
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" } });
      if (r2.ok) list = parseServers(r2.text());
    }
    if (!list.length) {
      const want = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
      if (attempt === 0 && want > Number(code)) {
        code = String(want);
        continue;
      }
      throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
    }
    put("vcode", String(code));
    return list.slice(0, MAX_SERVERS);
  }
  throw kino.error("unavailable", "bootstrap: sin servidores", { userMessage: "El servicio no tiene servidores disponibles." });
}
function keyOf(srv) {
  if (!srv || !srv.url) return "";
  let h = 5381;
  const text2 = srv.url + "|" + srv.username;
  for (let i = 0; i < text2.length; i++) h = (h << 5) + h + text2.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}
function serverKey() {
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  return keyOf(srv);
}
function serverByKey(k) {
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return null;
  return st.list.find((s) => keyOf(s) === k) || null;
}
function readSrvs() {
  try {
    return JSON.parse(kino.storage.get("srvs") || "null");
  } catch (_) {
    return null;
  }
}
function writeSrvs(st) {
  put("srvs", JSON.stringify(st));
}
async function loadServers(force) {
  const cached = readSrvs();
  const usable = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usable && cached.ts && cached.v === SRVS_V && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList();
    const st = { ts: Date.now(), list, idx: Math.max(0, list.findIndex((s) => indexFitsServer(s.url))), ok: false, v: SRVS_V };
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usable) return cached;
    throw e;
  }
}
function badAnswer(action2, data) {
  if (data === null || typeof data !== "object") return true;
  if (!Array.isArray(data)) {
    const auth = data.user_info && data.user_info.auth;
    return auth !== void 0 && String(auth) === "0";
  }
  return data.length === 0 && action2.endsWith("_categories");
}
async function callServer(srv, action2, extra) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, action: action2, ...extra });
  const r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
    }
  });
  if (!r.ok) throw new Error("API " + r.status);
  const data = r.json();
  if (badAnswer(action2, data)) throw new Error("respuesta inv\xE1lida");
  return data;
}
function homeIdx(st) {
  const i = st.list.findIndex((s) => indexFitsServer(s.url));
  return i >= 0 ? i : 0;
}
async function backHome() {
  const st = await loadServers(false);
  const home2 = homeIdx(st);
  if (st.idx === home2 || st.pin || Date.now() - (st.homeAt || 0) < 3e5) return;
  st.homeAt = Date.now();
  try {
    await callServer(st.list[home2], "get_vod_categories", {});
    st.idx = home2;
    st.ok = true;
    st.okAt = Date.now();
  } catch (_) {
  }
  writeSrvs(st);
}
async function api(action2, extra = {}) {
  let last = "";
  for (let pass = 0; pass < 2; pass++) {
    const st = await loadServers(pass === 1);
    if (pass === 0) await backHome();
    const st2 = readSrvs();
    if (st2 && pass === 0) {
      st.idx = st2.idx;
      st.ok = st2.ok;
      st.okAt = st2.okAt;
      st.homeAt = st2.homeAt;
    }
    for (let n = 0; n < st.list.length; n++) {
      const i = (st.idx + n) % st.list.length;
      try {
        const data = await callServer(st.list[i], action2, extra);
        if (i !== st.idx || !st.ok || Date.now() - (st.okAt || 0) > 5e3) {
          st.idx = i;
          st.ok = true;
          st.okAt = Date.now();
          writeSrvs(st);
        }
        return data;
      } catch (e) {
        if (e && e.code === "rate_limited") throw e;
        last = String(e && e.message || e).slice(0, 80);
        lastErr = last;
      }
    }
  }
  throw kino.error("unavailable", "ning\xFAn servidor respondi\xF3 (" + action2 + "): " + last, { userMessage: "Error al contactar el servidor." });
}
async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api("get_vod_categories");
    st = readSrvs();
  }
  return st.list[st.idx];
}
var lastErr = "";
var errText = (e) => String(e && (e.message || e.code) || e).slice(0, 90);
var img = (u) => {
  const s = typeof u === "string" ? u.trim() : "";
  if (!s) return void 0;
  return /^http:\/\//i.test(s) ? "https://" + s.slice(7).replace(/^([^/:]+):80(?=\/|$)/, "$1") : s;
};
var hostOf = (srv) => {
  try {
    return new URL(srv.url).host;
  } catch (_) {
    return "";
  }
};
var labelOf = (srv) => srv && srv.name ? srv.name : hostOf(srv);
var FLAG_NAMES = { AR: "Argentina", BO: "Bolivia", BR: "Brasil", CA: "Canad\xE1", CL: "Chile", CO: "Colombia", CR: "Costa Rica", CU: "Cuba", DE: "Alemania", DO: "Rep. Dominicana", EC: "Ecuador", ES: "Espa\xF1a", FR: "Francia", GB: "Reino Unido", GT: "Guatemala", HN: "Honduras", IT: "Italia", MX: "M\xE9xico", NI: "Nicaragua", PA: "Panam\xE1", PE: "Per\xFA", PR: "Puerto Rico", PT: "Portugal", PY: "Paraguay", SV: "El Salvador", US: "EE. UU.", UY: "Uruguay", VE: "Venezuela" };
function flagInfo(s) {
  const cp = [...String(s || "")];
  if (cp.length >= 2) {
    const a = cp[0].codePointAt(0), b = cp[1].codePointAt(0);
    if (a >= 127462 && a <= 127487 && b >= 127462 && b <= 127487) {
      const code = String.fromCharCode(a - 127462 + 65) + String.fromCharCode(b - 127462 + 65);
      return { code: code.toLowerCase(), name: FLAG_NAMES[code] || code };
    }
  }
  return String(s || "").includes("\u{1F310}") ? { code: "", name: "Global" } : null;
}
var niceLabel = (srv) => {
  const fi = flagInfo(labelOf(srv));
  return fi ? fi.code ? `${fi.code.toUpperCase()} \xB7 ${fi.name}` : fi.name : labelOf(srv);
};
async function serverStatus() {
  const cached = readSrvs();
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - (cached.okAt || 0) < 2e4) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: cached.okAt };
  try {
    await api("get_vod_categories");
    const st = readSrvs();
    return { ok: true, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: st.list.length, at: st.okAt };
  } catch (e) {
    lastErr = errText(e);
    const st = readSrvs();
    return { ok: false, host: st && st.list[st.idx] ? hostOf(st.list[st.idx]) : "", index: st ? st.idx + 1 : 0, total: st ? st.list.length : 0 };
  }
}
async function switchServer() {
  const st = await loadServers(false);
  const n = st.list.length;
  const https = st.list.filter((s) => String(s.url).startsWith("https://")).length;
  for (let k = 1; k < n; k++) {
    const i = (st.idx + k) % n;
    try {
      await callServer(st.list[i], "get_vod_categories", {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.pin = i !== homeIdx(st);
      writeSrvs(st);
      return { changed: true, host: hostOf(st.list[i]), index: i + 1, total: n };
    } catch (e) {
      lastErr = errText(e);
    }
  }
  return { changed: false, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: n, https };
}
async function serverList() {
  const st = await loadServers(false);
  return {
    current: st.idx,
    items: itemsWithHealth(st)
  };
}
function itemsWithHealth(st) {
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  let items = (st.list || []).map((s, i) => {
    const fi = flagInfo(labelOf(s));
    return { i, label: niceLabel(s), host: hostOf(s), https: String(s.url).startsWith("https://"), flag: fi ? fi.code : "", online: online ? online.has(s.url) : true };
  });
  if (online && online.size > 0) items = items.filter((x) => x.online);
  return items;
}
async function selectServer(i) {
  const st = await loadServers(false);
  const n = st.list.length;
  const start = parseInt(i, 10);
  if (!(start >= 0 && start < n)) return { ok: false };
  const wantLabel = labelOf(st.list[start]);
  const all = Array.from({ length: n }, (_, k) => k);
  const order = [start, ...all.filter((k) => k !== start && labelOf(st.list[k]) === wantLabel)].slice(0, 5);
  for (const idx of order) {
    try {
      await callServer(st.list[idx], "get_vod_categories", {});
      st.idx = idx;
      st.ok = true;
      st.okAt = Date.now();
      st.pin = idx !== homeIdx(st);
      writeSrvs(st);
      return { ok: true, host: hostOf(st.list[idx]), label: labelOf(st.list[idx]), index: idx + 1, total: n, exact: idx === start };
    } catch (e) {
      lastErr = errText(e);
    }
  }
  return { ok: false, host: hostOf(st.list[start]), label: labelOf(st.list[start]), index: start + 1, total: n };
}
var HEALTH_KEY = "health:v1";
var HEALTH_TTL_MS = 30 * 60 * 1e3;
var healthRunning = false;
function readHealth() {
  try {
    const o = JSON.parse(kino.storage.get(HEALTH_KEY) || "null");
    return o && Array.isArray(o.online) && typeof o.ts === "number" ? o : null;
  } catch (_) {
    return null;
  }
}
var healthFresh = () => {
  const h = readHealth();
  return h && Date.now() - h.ts < HEALTH_TTL_MS ? h : null;
};
var healthReady = () => !!healthFresh();
var probeAlive = async (srv) => {
  try {
    await callServer(srv, "get_vod_categories", {});
    return true;
  } catch (_) {
    return false;
  }
};
async function healthCheck() {
  if (healthRunning) return 0;
  healthRunning = true;
  try {
    const st = await loadServers(false);
    const list = st.list || [];
    const results = await Promise.all(list.map(async (s) => await probeAlive(s) ? s.url : null));
    const online = results.filter(Boolean);
    put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online }));
    const cur = list[st.idx];
    if (cur && online.length && !online.includes(cur.url)) {
      const i = list.findIndex((s) => s.url === online[0]);
      if (i >= 0) {
        st.idx = i;
        st.ok = true;
        st.okAt = Date.now();
        st.pin = true;
        writeSrvs(st);
      }
    }
    return online.length;
  } catch (_) {
    try {
      put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online: [] }));
    } catch (__) {
    }
    return 0;
  } finally {
    healthRunning = false;
  }
}
async function refreshServers() {
  const before = readSrvs();
  const st = await loadServers(true);
  const fresh = !before || st.ts !== before.ts;
  let ok = fresh;
  if (fresh) {
    try {
      await api("get_vod_categories");
    } catch (_) {
    }
  }
  const now = readSrvs() || st;
  return { ok, total: now.list.length, host: hostOf(now.list[now.idx]) };
}
async function settingsStatus() {
  const s = await serverStatus();
  const idx = await indexLabel((() => {
    try {
      const st = readSrvs();
      return st.list[st.idx].url;
    } catch (_) {
      return "";
    }
  })());
  if (!s.ok) return { status: (s.host ? `Sin respuesta de ${s.host}` : "Sin conexi\xF3n con el servicio") + (lastErr ? ` \xB7 ${lastErr}` : ""), indexStatus: idx };
  return { status: `Conectado a ${s.host} (${s.index} de ${s.total}) \xB7 comprobado ${s.at ? "hace " + Math.max(0, Math.round((Date.now() - s.at) / 1e3)) + " s" : "ahora"}`, indexStatus: idx };
}
async function action(key) {
  if (key === "switchServer") {
    const r = await switchServer();
    return { message: r.changed ? `Servidor cambiado a ${r.host}` : "No hay otro servidor que responda ahora" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  if (key === "refreshServers") {
    const r = await refreshServers();
    return { message: r.ok ? `Lista actualizada: ${r.total} servidores` : "No se pudo actualizar la lista" + (lastErr ? ` (${lastErr})` : ""), refresh: true };
  }
  throw kino.error("not_found");
}
var num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
var INFO_MAX = 80;
var infoMemo = null;
function infoCache() {
  const key = serverKey();
  if (infoMemo && infoMemo.key === key) return infoMemo.map;
  let map = {};
  try {
    map = JSON.parse(kino.storage.get("vinfo:" + key) || "{}") || {};
  } catch (_) {
    map = {};
  }
  infoMemo = { key, map };
  return map;
}
function saveFicha(itemId, ficha) {
  const map = infoCache();
  map[itemId] = ficha;
  const ids = Object.keys(map);
  if (ids.length > INFO_MAX) for (const old of ids.slice(0, ids.length - INFO_MAX)) delete map[old];
  let text2 = JSON.stringify(map);
  while (text2.length > 26 * 1024 && Object.keys(map).length > 1) {
    delete map[Object.keys(map)[0]];
    text2 = JSON.stringify(map);
  }
  put("vinfo:" + infoMemo.key, text2);
}
var splitGenres = (g) => String(g || "").split(/[,/|]/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
function extras(m, ficha) {
  const f = ficha || {};
  const out = {};
  const genres = splitGenres(m.genre).length ? splitGenres(m.genre) : f.genres || [];
  if (genres.length) out.genres = genres;
  let backdrop = m.backdrop_path || f.backdrop;
  if (Array.isArray(backdrop)) backdrop = backdrop[0];
  if (typeof backdrop === "string" && backdrop) out.backdrop = backdrop;
  const runtime = Math.round(num(m.duration_secs) / 60) || parseInt(m.episode_run_time, 10) || f.runtime || 0;
  if (runtime > 0) out.runtimeMinutes = runtime;
  const ids = {};
  const tmdb = parseInt(m.tmdb || m.tmdb_id, 10) || f.tmdb || 0;
  if (tmdb > 0) ids.tmdb = tmdb;
  if (/^tt\d+$/.test(String(m.imdb_id || m.imdb || ""))) ids.imdb = String(m.imdb_id || m.imdb);
  if (Object.keys(ids).length) out.ids = ids;
  return out;
}
var ratingOf = (m) => {
  const r = num(m.rating) || num(m.rating_5based) * 2;
  return r > 0 ? Math.min(10, r) : void 0;
};
function movieNameTok(m) {
  const { name } = cleanTitle(m.name || m.title, "");
  return findKey(name) || "";
}
function vodItem(m, adult) {
  const id = String(m.stream_id || "");
  if (!id) return null;
  const title2 = displayTitle(m.name || m.title);
  if (!title2) return null;
  const ext = String(m.container_extension || "mp4");
  const tok = movieNameTok(m);
  return {
    id: "vod-" + id,
    ref: "vod:" + id + ":" + ext + (tok ? "~" + tok : ""),
    title: title2,
    kind: "movie",
    poster: img(m.stream_icon || m.cover),
    year: m.year ? String(m.year) : m.release_date ? String(m.release_date).slice(0, 4) : void 0,
    rating: ratingOf(m),
    overview: m.plot ? String(m.plot).slice(0, 500) : void 0,
    ...extras(m, infoCache()["vod-" + id]),
    ...adult ? { adult: true } : {}
  };
}
function seriesItem(s, adult) {
  const id = String(s.series_id || "");
  if (!id) return null;
  const title2 = displayTitle(s.name || s.title);
  if (!title2) return null;
  return {
    id: "series-" + id,
    ref: "series:" + id,
    title: title2,
    kind: "series",
    poster: img(s.cover || s.poster),
    year: s.year ? String(s.year) : s.release_date ? String(s.release_date).slice(0, 4) : void 0,
    rating: ratingOf(s),
    overview: s.plot ? String(s.plot).slice(0, 500) : void 0,
    ...extras(s, infoCache()["series-" + id]),
    ...adult ? { adult: true } : {}
  };
}
async function fetchFicha(kind, id) {
  const vod = kind === "vod";
  const data = await api(vod ? "get_vod_info" : "get_series_info", vod ? { vod_id: id } : { series_id: id });
  const info = data && data.info || {};
  let backdrop = info.backdrop_path;
  if (Array.isArray(backdrop)) backdrop = backdrop[0];
  const ficha = {};
  if (typeof backdrop === "string" && /^https:\/\//.test(backdrop)) ficha.backdrop = backdrop;
  const tmdb = parseInt(info.tmdb_id || info.tmdb, 10);
  if (tmdb > 0) ficha.tmdb = tmdb;
  const runtime = Math.round(num(info.duration_secs) / 60) || parseInt(info.episode_run_time, 10) || 0;
  if (runtime > 0) ficha.runtime = runtime;
  const genres = splitGenres(info.genre);
  if (genres.length) ficha.genres = genres;
  return ficha;
}
async function enrichFeatured(kind, items, max = 6) {
  const prefix = kind === "vod" ? "vod-" : "series-";
  const todo = items.filter((it) => it && it.id.startsWith(prefix) && !infoCache()[it.id]).slice(0, max);
  let saved = 0;
  let limited = false;
  await pool(todo, 3, async (it) => {
    if (limited) return;
    try {
      const ficha = await fetchFicha(kind, it.id.slice(prefix.length));
      saveFicha(it.id, ficha);
      saved++;
    } catch (e) {
      if (e && e.code === "rate_limited") limited = true;
    }
  });
  return saved;
}
function genreOf(name) {
  const n = String(name || "").toLowerCase();
  if (/acci[oó]n|action/.test(n)) return "acci\xF3n";
  if (/comedia|comedy/.test(n)) return "comedia";
  if (/drama/.test(n)) return "drama";
  if (/terror|horror/.test(n)) return "terror";
  if (/animaci[oó]n|anime|cartoon/.test(n)) return "animaci\xF3n";
  if (/documenta/.test(n)) return "documentales";
  if (/romance/.test(n)) return "romance";
  if (/thriller|suspen/.test(n)) return "thriller";
  if (/pelic|movie|film|cine/.test(n)) return "pel\xEDculas";
  if (/serie/.test(n)) return "series";
  return void 0;
}
async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}
async function fetchCategory(action2, categoryId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action2, { category_id: String(categoryId) });
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      return data;
    } catch (e) {
      if (attempt >= 1 || e && e.code === "rate_limited") throw e;
    }
  }
}
var byAddedDesc = (a, b) => num(b.added) - num(a.added);
var CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
var catMemo = {};
async function categoryList(kind) {
  const key = serverKey();
  const m = catMemo[kind];
  if (key && m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return m.list;
  if (key) {
    try {
      const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
      if (o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS) {
        const list2 = o.l.map(([category_id, category_name]) => ({ category_id, category_name }));
        catMemo[kind] = { key, ts: o.ts, list: list2 };
        return list2;
      }
    } catch (_) {
    }
  }
  const data = await api(CAT_ACTIONS[kind]);
  const list = (Array.isArray(data) ? data : []).map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  const now = serverKey();
  catMemo[kind] = { key: now, ts: Date.now(), list };
  put("cats:" + kind + ":" + now, JSON.stringify({ ts: Date.now(), l: list.map((c) => [c.category_id, c.category_name]) }));
  return list;
}
var mergedVod = async (kind) => mergeVod(kind, await categoryList(kind), { showAdult: showAdult() });
var itemOf = (kind, x, adult) => kind === "vod" ? vodItem(x, adult) : seriesItem(x, adult);
async function loadRailsInfo(kind, maxRails, perRail, opts = {}) {
  const vod = kind === "vod";
  let cats = await mergedVod(kind);
  const hasEs = cats.some((c) => c.lang === "es-419" || c.lang === "es-ES");
  const extra = [...new Set(cats.map((c) => c.lang).filter((l) => /^x-/.test(l)))].sort((a, b) => langLabel(a)[0].localeCompare(langLabel(b)[0]));
  const langs = [...LANG_ORDER.filter((l) => l === "es" ? hasEs : cats.some((c) => c.lang === l)), ...extra];
  const lang = opts.lang && langs.includes(opts.lang) ? opts.lang : langs[0] || null;
  let inLang = cats;
  if (lang === "es") {
    const seenTitle = /* @__PURE__ */ new Set();
    inLang = cats.filter((c) => (c.lang === "es-419" || c.lang === "es-ES") && !seenTitle.has(c.title.toLowerCase()) && seenTitle.add(c.title.toLowerCase()));
  } else if (lang) inLang = cats.filter((c) => c.lang === lang);
  const ordered = opts.home ? homeOrder(inLang) : inLang.filter((c) => !c.adult);
  const offset = Math.max(0, opts.offset || 0);
  const only = opts.only ? String(opts.only) : "";
  const plain = only ? inLang.filter((c) => c.id === only && !c.adult).slice(0, 1) : ordered.slice(offset, offset + maxRails);
  const hasMore = !only && ordered.length > offset + maxRails;
  const catsList = inLang.filter((c) => !c.adult).map((c) => ({ id: c.id, title: c.title }));
  const chosen = opts.home || offset > 0 ? plain : [...plain, ...inLang.filter((c) => c.adult).slice(0, 1)];
  const fetched = await pool(chosen, 3, async (cat) => {
    try {
      return { cat, data: await fetchCategory(vod ? "get_vod_streams" : "get_series", cat.id) };
    } catch (_) {
      return { cat, failed: true };
    }
  });
  const seen = /* @__PURE__ */ new Set();
  const rails = [];
  let failed = 0;
  for (const r of fetched) {
    if (r.failed) {
      failed++;
      continue;
    }
    const items = [];
    for (const x of [...r.data].sort(byAddedDesc)) {
      if (items.length >= perRail) break;
      const it = itemOf(kind, x, r.cat.adult);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    }
    if (!items.length) continue;
    rails.push({
      id: (vod ? "vod-" : "series-") + r.cat.id,
      title: r.cat.title,
      genre: genreOf(r.cat.name) || (vod ? "pel\xEDculas" : "series"),
      ref: (vod ? "vod:" : "series:") + r.cat.id + (r.cat.adult ? ":a" : ""),
      lang: r.cat.lang,
      items
    });
  }
  if (!rails.length && failed) throw kino.error("unavailable", "ninguna categor\xEDa carg\xF3", { userMessage: "No se pudo cargar el cat\xE1logo." });
  await enrichTmdb(rails.slice(0, vod ? 2 : 1).flatMap((r) => r.items.slice(0, 8)), { max: vod ? 16 : 8, budgetMs: 2500 });
  return { rails, langs, lang, failed, hasMore, next: offset + maxRails, cats: catsList };
}
async function home() {
  const indexing = indexStep({ budgetMs: 1500 });
  const vod = await loadRailsInfo("vod", 7, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const series = await loadRailsInfo("series", 4, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const live = await countryRow().catch(() => null);
  await indexing;
  const rows = [...vod.rails, ...series.rails].map(({ lang, ...r }) => r);
  if (!rows.length) throw kino.error("unavailable", "sin contenido", { userMessage: "Sin contenido disponible por ahora." });
  if (live) rows.push({ id: live.id, title: live.title, genre: "tv", items: live.items });
  return rows;
}
async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const [kindPrefix, catId, flag] = String(ref || "").split(":");
  if (kindPrefix === "lcat" && /^\d+$/.test(catId || "")) {
    const out = await liveChannels({ categoryId: catId });
    const all2 = out.items.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} }));
    return { items: all2.slice(start, start + PER_PAGE), next: all2.length > start + PER_PAGE ? String(page + 1) : void 0 };
  }
  const kind = kindPrefix === "vod" ? "vod" : kindPrefix === "series" ? "series" : null;
  if (!kind || !/^\d+$/.test(catId || "")) return { items: [] };
  const adult = flag === "a";
  if (adult && !showAdult()) return { items: [] };
  const data = await fetchCategory(kind === "vod" ? "get_vod_streams" : "get_series", catId);
  const seen = /* @__PURE__ */ new Set();
  const all = [...data].sort(byAddedDesc).map((x) => itemOf(kind, x, adult)).filter((it) => it && !seen.has(it.id) && seen.add(it.id));
  return { items: all.slice(start, start + PER_PAGE), next: all.length > start + PER_PAGE ? String(page + 1) : void 0 };
}
async function searchKind(kind, cats, q, limit, seen, { maxCats, deadline }) {
  const action2 = kind === "vod" ? "get_vod_streams" : "get_series";
  const items = [];
  let failed = 0;
  let capped = false;
  let scanned = 0;
  for (let i = 0; i < cats.length && items.length < limit; i += 3) {
    if (scanned >= maxCats || Date.now() > deadline) {
      capped = true;
      break;
    }
    const slice = cats.slice(i, i + 3);
    scanned += slice.length;
    const batch = await Promise.all(slice.map(async (cat) => {
      try {
        const data = await fetchCategory(action2, cat.id);
        return { cat, hits: data.filter((x) => String(x.name || x.title || "").toLowerCase().includes(q)) };
      } catch (e) {
        if (e && e.code === "rate_limited") capped = true;
        else failed++;
        return { cat, hits: [] };
      }
    }));
    for (const { cat, hits } of batch) {
      for (const x of hits) {
        if (items.length >= limit) break;
        const it = itemOf(kind, x, cat.adult);
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    }
    if (capped) break;
  }
  if (items.length < limit && scanned < cats.length) capped = true;
  return { items, failed, capped };
}
async function viaIndex(q, type) {
  await backHome().catch(() => {
  });
  const fits = (() => {
    try {
      const st = readSrvs();
      return indexFitsServer(st.list[st.idx].url);
    } catch (_) {
      return true;
    }
  })();
  if (!fits) return null;
  const ready = indexReady();
  const [found2] = await Promise.all([ready ? indexSearch(q, type) : null, !ready || indexStale() ? indexStep({ budgetMs: 1500 }) : null]);
  const res = found2 || (!ready && indexReady() ? await indexSearch(q, type) : null);
  if (!res || !res.items.length) return null;
  await enrichTmdb(res.items.slice(0, 20), { max: 20, budgetMs: 2500 });
  return { items: res.items, partial: false };
}
async function searchDetailed(query, { budgetMs = 11e3 } = {}) {
  const q = String(query && query.q || "").trim().toLowerCase();
  if (!q) return { items: [], partial: false };
  const type = String(query && query.type || "any");
  const indexed = await viaIndex(q, type).catch(() => null);
  if (indexed) return indexed;
  const deadline = Date.now() + Math.max(3e3, budgetMs - 4e3);
  const wantVod = type === "any" || type === "movie";
  const wantSeries = type === "any" || type === "series";
  const seen = /* @__PURE__ */ new Set();
  let failed = 0;
  let capped = false;
  let items = [];
  if (wantVod) {
    const cats = searchOrder(await mergedVod("vod"));
    const r = await searchKind("vod", cats, q, 40, seen, { maxCats: 24, deadline });
    items = items.concat(r.items);
    failed += r.failed;
    capped = capped || r.capped;
  }
  if (wantSeries) {
    const cats = searchOrder(await mergedVod("series"));
    const r = await searchKind("series", cats, q, 20, seen, { maxCats: 12, deadline });
    items = items.concat(r.items);
    failed += r.failed;
    capped = capped || r.capped;
  }
  if (!items.length && failed) throw kino.error("unavailable", "la b\xFAsqueda no pudo completarse", { userMessage: "No se pudo completar la b\xFAsqueda." });
  return { items: items.slice(0, 60), partial: failed > 0 || capped };
}
async function search(query) {
  return (await searchDetailed(query)).items;
}
var serverCats = async (kind, wanted = []) => {
  const all = searchOrder(await mergedVod(kind === "movies" ? "vod" : "series"));
  const key = (title2) => String(title2).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hit = (c) => wanted.some(([t, l]) => key(t) === key(c.title) && (l === c.lang || !l));
  const same = all.filter(hit);
  const out = [...same, ...all.filter((c) => !hit(c))].map((c) => c.id);
  out.matched = same.length;
  return out;
};
async function episodes(ref) {
  if (String(ref || "").startsWith("idx:s:")) ref = await resolveIdxRef(ref, fetchCategory, serverCats);
  const id = String(ref || "").replace(/^series:/, "");
  if (!/^\d+$/.test(id)) throw kino.error("not_found");
  const data = await api("get_series_info", { series_id: id });
  if (!data || typeof data !== "object") throw kino.error("not_found");
  const info = data.info || {};
  const seriesInfo = {
    title: info.name ? String(info.name) : void 0,
    poster: img(info.cover || info.movie_image),
    overview: info.plot ? String(info.plot).slice(0, 500) : void 0,
    year: info.year ? String(info.year) : void 0,
    rating: info.rating ? parseFloat(info.rating) || void 0 : void 0,
    genres: info.genre ? String(info.genre).split(/[,/]/).map((g) => g.trim()).filter(Boolean) : void 0
  };
  const tok = findKey(cleanTitle(info.name || "", "").name);
  const eps = [];
  for (const [season, epList] of Object.entries(data.episodes || {})) {
    const seasonNum = parseInt(season, 10) || 1;
    for (const ep of Array.isArray(epList) ? epList : []) {
      const epId = String(ep.id || "");
      if (!epId) continue;
      const ext = String(ep.info && ep.info.container_extension || ep.container_extension || "mp4");
      eps.push({
        season: seasonNum,
        number: parseInt(ep.episode_num, 10) || 1,
        ref: "ep:" + epId + ":" + ext + (tok ? "~" + id + "~" + tok : ""),
        title: ep.title ? String(ep.title) : void 0,
        overview: ep.info && ep.info.plot ? String(ep.info.plot).slice(0, 300) : void 0,
        still: ep.info && ep.info.movie_image ? String(ep.info.movie_image) : void 0,
        airDate: ep.air_date ? String(ep.air_date) : void 0
      });
    }
  }
  eps.sort((a, b) => a.season - b.season || a.number - b.number);
  return { series: seriesInfo, episodes: eps };
}
var LIVE_PAGE = 200;
var LIVE_CATS_TTL_MS = 10 * 60 * 1e3;
var liveCatsMemo = null;
async function liveCats() {
  const key = serverKey();
  if (liveCatsMemo && key && liveCatsMemo.key === key && Date.now() - liveCatsMemo.ts < LIVE_CATS_TTL_MS) return liveCatsMemo.list;
  const merged = mergeLive(await categoryList("live"), { showAdult: true });
  liveCatsMemo = { key: serverKey(), ts: Date.now(), list: merged };
  return merged;
}
var visibleLive = (list) => showAdult() ? list : list.filter((c) => !c.adult);
async function liveCategories() {
  return visibleLive(await liveCats()).map((c) => ({
    id: c.id,
    title: c.title,
    ...c.country ? { country: c.country } : {},
    ...c.genre ? { genre: c.genre } : {},
    ...c.adult ? { adult: true } : {}
  }));
}
function liveItem(s, categoryId, adult) {
  const id = String(s.stream_id || "");
  const title2 = String(s.name || "").trim();
  if (!id || !title2) return null;
  return {
    id: "live-" + id,
    title: title2,
    ref: "live:" + id,
    logo: img(s.stream_icon),
    number: parseInt(s.num, 10) || void 0,
    categoryId: String(categoryId || s.category_id || ""),
    ...adult ? { adult: true } : {}
  };
}
async function liveChannels({ categoryId, cursor }) {
  const cat = (await liveCats().catch(() => [])).find((c) => c.id === String(categoryId));
  const adult = !!(cat && cat.adult);
  if (adult && !showAdult()) return { items: [] };
  const all = await fetchCategory("get_live_streams", String(categoryId || ""));
  const start = Math.max(0, parseInt(cursor, 10) || 0);
  const items = all.slice(start, start + LIVE_PAGE).map((s) => liveItem(s, categoryId, adult)).filter(Boolean);
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : void 0 };
}
async function liveSearchDetailed({ query }, { budgetMs = 11e3 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { items: [], partial: false };
  const deadline = Date.now() + budgetMs;
  const cats = visibleLive(await liveCats());
  const LIMIT = 100;
  const MAX_CATS = 36;
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  let failed = 0;
  let capped = false;
  let scanned = 0;
  for (let i = 0; i < cats.length && items.length < LIMIT; i += 3) {
    if (scanned >= MAX_CATS || Date.now() > deadline) {
      capped = true;
      break;
    }
    const slice = cats.slice(i, i + 3);
    scanned += slice.length;
    const batch = await Promise.all(slice.map(async (cat) => {
      try {
        const data = await fetchCategory("get_live_streams", cat.id);
        return data.filter((s) => String(s.name || "").toLowerCase().includes(q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean).map((it) => ({ ...it, adult: cat.adult === true }));
      } catch (e) {
        if (e && e.code === "rate_limited") capped = true;
        else failed++;
        return [];
      }
    }));
    for (const list of batch) for (const it of list) if (items.length < LIMIT && !seen.has(it.id)) {
      seen.add(it.id);
      items.push(it);
    }
    if (capped) break;
  }
  if (items.length < LIMIT && scanned < cats.length) capped = true;
  if (!items.length && failed) throw kino.error("unavailable", "la b\xFAsqueda no pudo completarse", { userMessage: "No se pudo completar la b\xFAsqueda." });
  return { items, partial: failed > 0 || capped };
}
async function liveSearch(args) {
  const { items } = await liveSearchDetailed(args);
  return { items };
}
var isCountryCode = (cc) => COUNTRY_PHRASES.some(([, code]) => code === cc);
async function countryRow(limit = 20) {
  const cc = homeCountry();
  if (!isCountryCode(cc)) return null;
  const ranked = visibleLive(await liveCats()).filter((c) => c.country === cc).map((c) => ({ c, m: countryMatch(c.title) })).sort((a, b) => (a.m && a.m.exact ? 0 : a.m && a.m.starts ? 1 : 2) - (b.m && b.m.exact ? 0 : b.m && b.m.starts ? 1 : 2) || a.c.order - b.c.order).slice(0, 3);
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { c } of ranked) {
    if (items.length >= limit) break;
    const data = await fetchCategory("get_live_streams", c.id).catch(() => []);
    for (const s of data) {
      const it = liveItem(s, c.id, c.adult);
      if (!it || items.length >= limit || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...c.adult ? { adult: true } : {} });
    }
  }
  return items.length ? { id: "live-country", title: "Canales en vivo", items } : null;
}
function b64text(s) {
  const str = String(s || "");
  if (!str) return "";
  try {
    const bin = atob(str);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += "%" + bin.charCodeAt(i).toString(16).padStart(2, "0");
    return decodeURIComponent(out);
  } catch (_) {
    return str;
  }
}
async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).slice(0, 50);
  const lists = await Promise.all(ids.map(async (cid) => {
    const streamId = String(cid).replace(/^live-/, "");
    if (!/^\d+$/.test(streamId)) return [];
    try {
      const data = await api("get_short_epg", { stream_id: streamId, limit: "20" });
      const rows = Array.isArray(data) ? data : data && (data.epg_listings || data.listings || data.epg) || [];
      return rows.map((e) => ({
        channelId: String(cid),
        title: b64text(e.title),
        description: b64text(e.description || e.descr),
        start: (parseInt(e.start_timestamp, 10) || 0) * 1e3,
        end: (parseInt(e.stop_timestamp || e.end_timestamp, 10) || 0) * 1e3
      })).filter((e) => e.title && e.end > e.start && e.end > from && e.start < to);
    } catch (_) {
      return [];
    }
  }));
  return lists.flat();
}
var AVAIL_KEY = "avail:v1";
var AVAIL_TTL_MS = 36 * 60 * 60 * 1e3;
var AVAIL_MAX_IDS = 400;
function readAvail() {
  try {
    const o = JSON.parse(kino.storage.get(AVAIL_KEY) || "{}");
    return o && typeof o === "object" ? o : {};
  } catch (_) {
    return {};
  }
}
function recordAvail(id, k, ext) {
  if (!id || !k) return;
  const all = readAvail();
  const t = all[id] && typeof all[id] === "object" ? all[id] : {};
  t[k] = ext ? { has: 1, ext, ts: Date.now() } : { has: 0, ts: Date.now() };
  t._ts = Date.now();
  all[id] = t;
  const keys = Object.keys(all);
  if (keys.length > AVAIL_MAX_IDS) {
    keys.sort((a, b) => (all[a]._ts || 0) - (all[b]._ts || 0));
    for (const old of keys.slice(0, keys.length - AVAIL_MAX_IDS)) delete all[old];
  }
  try {
    put(AVAIL_KEY, JSON.stringify(all));
  } catch (_) {
  }
}
function availFor(id, k) {
  const t = readAvail()[id];
  const e = t && t[k];
  if (!e || Date.now() - (e.ts || 0) > AVAIL_TTL_MS) return null;
  return e;
}
function buildAlternatives(availId, activeKey, makeRef) {
  if (!availId) return [];
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return [];
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  const known = [], unknown = [];
  const countBy = {};
  for (const srv of st.list) {
    const k = keyOf(srv);
    if (!k || k === activeKey) continue;
    if (online && !online.has(srv.url)) continue;
    const av = availFor(availId, k);
    if (av && !av.has) continue;
    const base = niceLabel(srv);
    countBy[base] = (countBy[base] || 0) + 1;
    (av && av.has ? known : unknown).push({ base, host: hostOf(srv), ref: makeRef(k) });
  }
  const label = (e) => countBy[e.base] > 1 && e.host ? `${e.base} \xB7 ${e.host}` : e.base;
  return [...known, ...unknown].slice(0, 12).map((e) => ({ label: label(e), ref: e.ref }));
}
function episodeExtIn(data, epId, hintExt) {
  for (const list of Object.values(data && data.episodes || {})) {
    for (const e of Array.isArray(list) ? list : []) {
      if (String(e.id) === epId) return String(e.info && e.info.container_extension || e.container_extension || hintExt || "mp4");
    }
  }
  return "";
}
async function resolveAlt(s) {
  const segs = s.slice(3).split("~");
  const k = segs[0];
  const kind = segs[1];
  const srv = serverByKey(k);
  if (!srv) throw kino.error("not_found", "servidor desconocido");
  if (kind === "m") {
    const id = segs[2] || "";
    const hintExt = segs[3] || "mp4";
    const tok = segs.slice(4).join("~");
    if (!/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    const availId = "m:" + id;
    const cached = availFor(availId, k);
    if (cached && cached.has && cached.ext) return { url: `${srv.url}/movie/${srv.username}/${srv.password}/${id}.${cached.ext}` };
    let data;
    try {
      data = await callServer(srv, "get_vod_info", { vod_id: id });
    } catch (_) {
      recordAvail(availId, k, null);
      throw kino.error("not_found", "fuente no disponible");
    }
    const md = data && data.movie_data || {};
    const name = md.name || data && data.info && data.info.name || "";
    if (!name || tok && findKey(cleanTitle(name, "").name) !== tok) {
      recordAvail(availId, k, null);
      throw kino.error("not_found", "el servidor no tiene esta pel\xEDcula");
    }
    const ext = String(md.container_extension || hintExt || "mp4");
    recordAvail(availId, k, ext);
    return { url: `${srv.url}/movie/${srv.username}/${srv.password}/${id}.${ext}` };
  }
  if (kind === "e") {
    const epId = segs[2] || "";
    const hintExt = segs[3] || "mp4";
    const seriesId = segs[4] || "";
    const tok = segs.slice(5).join("~");
    if (!/^\d+$/.test(epId) || !/^\d+$/.test(seriesId)) throw kino.error("not_found", "fuente desconocida");
    const availId = "e:" + epId;
    const cached = availFor(availId, k);
    if (cached && cached.has && cached.ext) return { url: `${srv.url}/series/${srv.username}/${srv.password}/${epId}.${cached.ext}` };
    let data;
    try {
      data = await callServer(srv, "get_series_info", { series_id: seriesId });
    } catch (_) {
      recordAvail(availId, k, null);
      throw kino.error("not_found", "fuente no disponible");
    }
    const name = data && data.info && (data.info.name || data.info.title) || "";
    if (tok && name && findKey(cleanTitle(name, "").name) !== tok) {
      recordAvail(availId, k, null);
      throw kino.error("not_found", "el servidor no tiene esta serie");
    }
    const ext = episodeExtIn(data, epId, hintExt);
    if (!ext) {
      recordAvail(availId, k, null);
      throw kino.error("not_found", "el episodio no est\xE1 en este servidor");
    }
    recordAvail(availId, k, ext);
    return { url: `${srv.url}/series/${srv.username}/${srv.password}/${epId}.${ext}` };
  }
  throw kino.error("not_found", "fuente desconocida");
}
async function resolve(ref) {
  let s = String(ref || "");
  if (s.startsWith("at:")) return await resolveAlt(s);
  const active = await activeServer();
  const { url, username, password } = active;
  if (s.startsWith("idx:m:")) s = await resolveIdxRef(s, fetchCategory, serverCats);
  if (s.startsWith("live:")) {
    const id = s.slice(5);
    if (!/^\d+$/.test(id)) throw kino.error("not_found");
    return { url: `${url}/live/${username}/${password}/${id}.${liveFormat()}` };
  }
  if (s.startsWith("vod:")) {
    const [core, ...rest] = s.slice(4).split("~");
    const tok = rest.join("~");
    const parts = core.split(":");
    const streamId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(streamId)) throw kino.error("not_found");
    const aKey = serverKey();
    noteRecent(streamId, ext, aKey);
    recordAvail("m:" + streamId, aKey, ext);
    const out = { url: `${url}/movie/${username}/${password}/${streamId}.${ext}` };
    const alts = buildAlternatives("m:" + streamId, aKey, (k) => `at:${k}~m~${streamId}~${ext}~${tok}`);
    if (alts.length) {
      out.alternatives = alts;
      out.label = niceLabel(active);
    }
    return out;
  }
  if (s.startsWith("ep:")) {
    const [core, ...rest] = s.slice(3).split("~");
    const seriesId = rest[0] || "";
    const tok = rest.slice(1).join("~");
    const parts = core.split(":");
    const epId = parts[0];
    const ext = parts[1] || "mp4";
    if (!/^\d+$/.test(epId)) throw kino.error("not_found");
    const aKey = serverKey();
    recordAvail("e:" + epId, aKey, ext);
    const out = { url: `${url}/series/${username}/${password}/${epId}.${ext}` };
    const alts = /^\d+$/.test(seriesId) ? buildAlternatives("e:" + epId, aKey, (k) => `at:${k}~e~${epId}~${ext}~${seriesId}~${tok}`) : [];
    if (alts.length) {
      out.alternatives = alts;
      out.label = niceLabel(active);
    }
    return out;
  }
  throw kino.error("not_found", "ref desconocido: " + s.slice(0, 30));
}
async function vodInfoItem(streamId) {
  const data = await api("get_vod_info", { vod_id: String(streamId) });
  const info = data && data.info || {};
  const md = data && data.movie_data || {};
  return vodItem({
    stream_id: md.stream_id || streamId,
    name: md.name || info.name,
    container_extension: md.container_extension,
    stream_icon: info.movie_image || info.cover_big,
    plot: info.plot,
    rating: info.rating,
    year: info.releasedate ? String(info.releasedate).slice(0, 4) : "",
    genre: info.genre,
    backdrop_path: info.backdrop_path,
    duration_secs: info.duration_secs,
    tmdb_id: info.tmdb_id
  }, false);
}
function withFicha(item) {
  const e = extras({}, infoCache()[item.id]);
  const out = { ...item };
  if (!out.backdrop && e.backdrop) out.backdrop = e.backdrop;
  if (!out.ids && e.ids) out.ids = e.ids;
  if (!out.runtimeMinutes && e.runtimeMinutes) out.runtimeMinutes = e.runtimeMinutes;
  if (!out.genres && e.genres) out.genres = e.genres;
  return out;
}

// src/i18n.js
var TEXTS = Object.freeze({
  tabHome: ["Inicio", "Home"],
  tabMovies: ["Pel\xEDculas", "Movies"],
  tabSeries: ["Series", "Series"],
  tabLive: ["En vivo", "Live"],
  watch: ["Ver", "Watch"],
  info: ["Detalles", "Details"],
  search: ["Buscar", "Search"],
  searchTitle: ["Buscar", "Search"],
  searchHint: ["Pel\xEDcula o serie", "Movie or series"],
  searchFailed: ["La b\xFAsqueda fall\xF3.", "The search failed."],
  noResults: ["No encontramos nada con esas palabras.", "Nothing found for those words."],
  searchedBefore: ["Buscado antes", "Searched before"],
  retry: ["Reintentar", "Retry"],
  category: ["Categor\xEDa", "Category"],
  allCats: ["Todas las categor\xEDas", "All categories"],
  more: ["Cargar m\xE1s categor\xEDas", "Load more categories"],
  back: ["Atr\xE1s", "Back"],
  close: ["Cerrar", "Close"],
  settings: ["Ajustes", "Settings"],
  recent: ["Continuar viendo", "Continue watching"],
  live: ["En vivo", "Live"],
  liveCountry: ["Canales de tu pa\xEDs", "Channels from your country"],
  liveSearchHint: ["Buscar un canal", "Search a channel"],
  liveCategory: ["Categor\xEDa", "Category"],
  liveEmpty: ["No hay canales para mostrar.", "No channels to show."],
  liveMore: ["Se muestran los primeros {n}. Usa la b\xFAsqueda para encontrar otros.", "Showing the first {n}. Use search to find others."],
  seeLive: ["Ver todo En vivo", "See all Live"],
  partial: ["Algunas filas no cargaron.", "Some rows did not load."],
  searchPartial: ["Resultados parciales: no se revisaron todas las categor\xEDas (el servidor limita las peticiones).", "Partial results: not every category was checked (the server limits requests)."],
  verifying: ["Verificando servidores\u2026", "Checking servers\u2026"],
  empty: ["Todav\xEDa no hay nada para mostrar.", "Nothing to show yet."],
  failed: ["No se pudo cargar. Revisa tu conexi\xF3n.", "Could not load. Check your connection."],
  setTitle: ["Ajustes de Ultra Hd", "Ultra Hd settings"],
  setConnection: ["Conexi\xF3n", "Connection"],
  setConnectionHint: ["Los servidores se obtienen solos. Aqu\xED puedes cambiar de uno si va mal.", "Servers are picked automatically. Switch here if one misbehaves."],
  setServer: ["Servidor activo", "Active server"],
  setServerOk: ["Responde", "Online"],
  setServerDown: ["Sin respuesta", "No answer"],
  setServerNone: ["Sin servidores", "No servers"],
  setServerPos: ["{i} de {n} en la lista", "{i} of {n} in the list"],
  setPick: ["Elegir servidor", "Choose server"],
  setPickHint: ["Cada servidor muestra su pa\xEDs. Elige el tuyo; si uno no responde o no trae buenos canales o logos, prueba otro.", "Each server shows its country. Pick yours; if one does not answer or has poor channels or logos, try another."],
  srvSelected: ["Servidor fijado: {host}", "Server set: {host}"],
  srvSelectFail: ["No respondi\xF3 {host}. Prueba otro.", "{host} did not answer. Try another."],
  setSwitch: ["Cambiar servidor", "Switch server"],
  setSwitchHint: ["Prueba el siguiente servidor de la lista.", "Tries the next server in the list."],
  setRefresh: ["Actualizar lista de servidores", "Update server list"],
  setRefreshHint: ["Vuelve a pedir la lista al servicio.", "Asks the service for the list again."],
  setCheck: ["Comprobar", "Check"],
  setAdultTitle: ["Contenido 18+", "18+ content"],
  setAdultHint: ["Apagado, las categor\xEDas para adultos no aparecen. Encendido, salen marcadas y Kino las muestra solo con tu c\xF3digo 18+.", "Off, adult categories are hidden. On, they appear marked and Kino shows them only with your 18+ code."],
  setLiveTitle: ["En vivo", "Live"],
  setLiveHint: ["Formato de los canales. Si uno no carga, prueba el otro.", "Channel format. If one will not play, try the other."],
  setHomeTitle: ["Inicio", "Home"],
  setHomeHint: ["Una fila con los canales en vivo de tu pa\xEDs al final de Inicio.", "A row with your country's live channels at the end of Home."],
  setAbout: ["Acerca de", "About"],
  aboutPlugin: ["Plugin", "Plugin"],
  aboutKino: ["Kino", "Kino"],
  aboutDevice: ["Aparato", "Device"],
  switched: ["Servidor cambiado a {host}", "Server switched to {host}"],
  noOther: ["No hay otro servidor disponible ahora.", "No other server is available now."],
  refreshed: ["Lista actualizada: {n} servidores.", "List updated: {n} servers."],
  refreshFail: ["No se pudo actualizar la lista.", "Could not update the list."],
  checking: ["Comprobando\u2026", "Checking\u2026"]
});
var fill = (s, vars) => vars ? s.replace(/\{(\w+)\}/g, (_, k) => k in vars ? String(vars[k]) : "") : s;
function twin(key, prop = "text", vars) {
  const [es, en] = TEXTS[key] || [key, key];
  return { [prop]: fill(es, vars), [prop + "En"]: fill(en, vars) };
}
var say = (key, lang, vars) => {
  const [es, en] = TEXTS[key] || [key, key];
  return fill(lang === "en" ? en : es, vars);
};

// src/logo.js
var LOGO_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABV0lEQVR4nO3dQZKCMBgFYddzBK/o/dczaxGTAdFuyv7rbQRJvXwHSC7XXfN7u5wu+3b638/w7VFek//h28ClRq/x6gaj9Xd4Yw/TylO8qMpo+QiviGcEhJeTJKBdQHgtVZZAeCFhAgroKCC8ijYBBRRQQDQQXkIevoE8fAN5+Aby8A3k4RvIwzeQh28gD99AHr6BPHwDefgG8ix//9zPprXG335s5U0TUEABBRTQaVcOKKCAAgpIvHJAAQUU0LcCvTIBBRRQQAG9GegUKwcUUEABBSReOaCAAgpIBjT+fjwvVjkK6MDOAQUUUEBuoMI3kIdvIA/fQB6+gTx8A3n4BvLwDeThG8jDN5CHbyAP30AevoE8HW4ySqe/BBRQQAKgjJ7pBBTQUUAZrep0XPJEJ6CNQBlNjmzP6FGjayNGOl08MqKZA32J0Vigy48ms/NSKXx77xNZzB/7TgYOhL71YQAAAABJRU5ErkJggg==";

// src/screenView.js
var TAB_IDS = ["home", "movies", "series", "live"];
var TAB_KEYS = { home: "tabHome", movies: "tabMovies", series: "tabSeries", live: "tabLive" };
var POLL_MS = 1500;
var GRID_CAP = 60;
var MAX_SLIDES = 6;
var MAX_SLIDE_TEXT = 160;
var HTTPS = /^https:\/\//;
var PRESS_MS = 3e4;
function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind };
  const poster = item.poster || item.logo;
  if (poster && HTTPS.test(poster)) out.poster = poster;
  if (item.backdrop && HTTPS.test(item.backdrop)) out.backdrop = item.backdrop;
  if (item.adult === true) out.adult = true;
  if (typeof item.rating === "number") out.rating = item.rating;
  if (item.ids) out.ids = item.ids;
  if (item.overview) out.overview = item.overview;
  if (item.year) out.year = item.year;
  return out;
}
function slidesOf(rails) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rail2 of rails) {
    for (const item of rail2.items) {
      if (out.length >= MAX_SLIDES) return out;
      const image = item.backdrop && HTTPS.test(item.backdrop) ? item.backdrop : null;
      const text2 = typeof item.overview === "string" ? item.overview.trim() : "";
      if (item.adult === true || seen.has(item.id) || !image || !HTTPS.test(image) || text2 === "") continue;
      seen.add(item.id);
      out.push({
        id: item.id,
        ref: item.ref,
        kind: item.kind,
        title: item.title,
        image,
        text: text2.length <= MAX_SLIDE_TEXT ? text2 : `${text2.slice(0, MAX_SLIDE_TEXT - 1).trimEnd()}\u2026`
      });
    }
  }
  return out;
}
var slim = (card) => {
  const { overview, ...rest } = card;
  return rest;
};
var railSkeleton = (n) => ({
  type: "Column",
  key: "skel" + n,
  gap: 8,
  children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 12, sizes: ["compact"], children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}c${i}`, flex: 1 })) },
    { type: "Row", gap: 12, sizes: ["medium", "expanded"], children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}w${i}`, flex: 1 })) }
  ]
});
var gridSkeleton = () => ({
  type: "Column",
  key: "gridSkeleton",
  gap: 12,
  children: [
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["compact"], key: `gc${r}`, children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `gc${r}-${i}`, flex: 1 })) })),
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["medium", "expanded"], key: `gw${r}`, children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `gw${r}-${i}`, flex: 1 })) }))
  ]
});
var slideNode = (s) => ({
  type: "heroCard",
  key: "slide-" + s.id,
  h: { compact: 200, expanded: 240 },
  title: s.title,
  text: s.text,
  image: s.image,
  buttons: [
    {
      type: "ElevatedButton",
      key: "watch-" + s.id,
      ...twin("watch", "labelText"),
      icon: "play",
      onPressed: { go: { play: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } }
    },
    {
      type: "TextButton",
      key: "info-" + s.id,
      ...twin("info", "labelText"),
      onPressed: { go: { title: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } }
    }
  ]
});
var hero = (slides) => slides.length === 1 ? slideNode(slides[0]) : {
  type: "PageView",
  key: "hero" + slides.length,
  autoPlayMs: 6e3,
  children: slides.map(slideNode)
};
var brandText = () => ({ type: "Text", key: "brandText", text: "Ultra Hd", textEn: "Ultra Hd", style: "h4" });
var title = () => ({
  type: "Row",
  key: "brand",
  gap: 8,
  crossAxisAlignment: "center",
  children: [{ type: "Image", key: "logo", url: LOGO_DATA, aspect: "1:1", fit: "contain", h: 32, alt: "Ultra Hd", altEn: "Ultra Hd" }, brandText()]
});
var tabBar = (active) => ({
  type: "TabBar",
  key: "tabs",
  divider: false,
  value: active,
  onChanged: "tab",
  tabs: TAB_IDS.map((id) => ({ value: id, ...twin(TAB_KEYS[id], "label") }))
});
var langChips = (langs, lang) => ({
  type: "Chips",
  key: "langChips",
  value: lang,
  onChanged: "lang",
  options: langs.map((l) => ({ value: l, label: langLabel(l)[0], labelEn: langLabel(l)[1] }))
});
var roundChannel = (c, n) => ({
  type: "Column",
  key: "ch-" + n,
  w: 120,
  gap: 8,
  crossAxisAlignment: "center",
  onTap: { go: { play: { ref: c.ref, kind: "live", id: c.id, title: c.title } } },
  children: [
    { type: "CircleAvatar", key: "chl-" + n, radius: 44, ...c.poster ? { image: c.poster } : { text: String(c.title).slice(0, 2).toUpperCase() }, labelText: c.title, labelTextEn: c.title },
    { type: "Text", text: c.title, textEn: c.title, style: "caption", maxLines: 1, textAlign: "center" }
  ]
});
var roundRail = (items, key, titleProps) => ({
  type: "Column",
  key,
  gap: 8,
  children: [
    { type: "Text", ...titleProps, style: "h4" },
    { type: "SingleChildScrollView", key: key + "Scroll", direction: "horizontal", children: [{ type: "Row", gap: 24, children: items.slice(0, 20).map(roundChannel) }] }
  ]
});
var rail = (r, key, titleProps) => ({
  type: "titleRail",
  key,
  ...titleProps || { title: r.title, titleEn: r.title },
  ...r.ref ? { ref: r.ref } : {},
  items: r.items.map(slim),
  size: "medium"
});
var barButton = (key, icon, labelKey, onPressed) => ({ type: "IconButton", key, icon, ...twin(labelKey, "labelText"), ...twin(labelKey, "tooltip"), onPressed });
function browseView({ tab, data, recent, country, loading, failed, device = "phone" }) {
  const tv = device === "tv";
  const active = TAB_IDS.includes(tab) ? tab : TAB_IDS[0];
  const body = [];
  const chips = data && data.langs && data.langs.length > 1 && active !== "live" ? langChips(data.langs, data.lang) : null;
  const catDrop = data && data.cats && data.cats.length > 1 && active !== "live" && active !== "home" ? {
    type: "DropdownButton",
    key: "vcat",
    ...twin("category", "labelText"),
    value: data.catSel || "",
    onChanged: "vcat",
    options: [{ value: "", ...twin("allCats", "label") }, ...data.cats.slice(0, 200).map((c) => ({ value: c.id, label: c.title, labelEn: c.title }))]
  } : null;
  if (tv && chips && catDrop) {
    body.push({ type: "Row", key: "chipsCat", gap: 24, crossAxisAlignment: "center", children: [{ ...chips, flex: 1 }, catDrop] });
  } else {
    if (chips) body.push(chips);
    if (catDrop) body.push(catDrop);
  }
  if (data) {
    if (data.slides.length > 0) body.push(hero(data.slides));
    if (active === "home" && recent.length > 0) body.push(rail({ items: recent }, "recent", twin("recent", "title")));
    for (const r of data.rails) body.push(rail(r, "rail-" + r.id));
    if (active === "home" && country.length > 0) {
      body.push(tv ? roundRail(country, "country", twin("liveCountry", "text")) : rail({ items: country }, "country", twin("liveCountry", "title")));
    }
    if (data.hasMore && active !== "home" && active !== "live") body.push({ type: "ElevatedButton", key: "moreCats", ...twin("more", "labelText"), icon: "expand_more", onPressed: "more" });
    if (active === "live") body.push({ type: "ElevatedButton", key: "seeLive", ...twin("seeLive", "labelText"), icon: "tv", onPressed: { event: "go", arg: "live" } });
    if (data.rails.length === 0 && country.length === 0) body.push({ type: "Text", ...twin("empty", "text"), color: "muted" });
    if (data.partial) body.push({ type: "MaterialBanner", key: "partialRows", role: "warning", ...twin("partial"), action: { ...twin("retry", "label"), onTap: "retry" } });
  } else if (failed) {
    body.push({ type: "MaterialBanner", key: "loadFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "retry" } });
  } else {
    body.push({ type: "Skeleton", key: "heroSkeleton", shape: "block", height: { compact: 200, expanded: 320 } }, railSkeleton(1), railSkeleton(2), railSkeleton(3));
  }
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar",
      divider: false,
      mergeWithKinoBar: true,
      dense: true,
      leading: barButton("close", "close", "close", { go: { close: true } }),
      title: tv ? { type: "Row", key: "titleRow", gap: 24, crossAxisAlignment: "center", children: [title(), tabBar(active)] } : title(),
      actions: [
        ...tv ? [barButton("searchButton", "search", "search", "openSearch")] : [],
        barButton("liveButton", "tv", "live", { event: "go", arg: "live" }),
        barButton("serverBtn", "language", "setPick", "openServers"),
        barButton("settings", "settings", "settings", { event: "go", arg: "settings" })
      ]
    },
    ...tv ? {} : { floatingActionButton: { type: "FloatingActionButton", key: "searchFab", icon: "search", ...twin("search", "tooltip"), onPressed: "openSearch" } },
    body: { type: "Column", key: "page", children: [
      ...tv ? [] : [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(active)] }],
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] }
    ] },
    ...loading ? { every: { ms: POLL_MS, event: "tick" } } : {}
  };
}
var searchForm = (tv, query, key, field, event, hintKey, goKey) => ({
  type: "Form",
  key,
  onSubmitted: event,
  gap: 8,
  children: tv ? [{ type: "Row", key: key + "Row", gap: 16, crossAxisAlignment: "center", children: [
    { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: field === "q", onSubmitted: event, weight: 1 },
    { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true }
  ] }] : [
    { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: field === "q", onSubmitted: event },
    { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true }
  ]
});
var backBar = (tv, extra) => ({
  type: "AppBar",
  mergeWithKinoBar: true,
  dense: true,
  divider: false,
  leading: barButton("back", "arrow_back", "back", "back"),
  ...extra
});
function searchView({ query, status, items, enriching = false, partial = false, history = [], device = "phone" }) {
  const tv = device === "tv";
  const form = () => searchForm(tv, query, "searchForm", "q", "search", "searchHint", "searchGo");
  const body = tv ? [] : [form()];
  if (status === "fail") {
    body.push({ type: "MaterialBanner", key: "searchFailed", role: "error", ...twin("searchFailed"), action: { ...twin("retry", "label"), onTap: "sretry" } });
  } else if (status === "done" && items) {
    if (items.length === 0) body.push({ type: "Text", ...twin("noResults", "text"), color: "muted" });
    else body.push({ type: "titleGrid", key: "results", columns: { compact: 3, expanded: 6 }, items: items.slice(0, GRID_CAP).map(slim) });
    if (partial) body.push({ type: "Text", ...twin("searchPartial", "text"), style: "caption", color: "muted" });
  } else if (status !== "idle") {
    body.push(gridSkeleton());
  } else if (history.length > 0) {
    body.push({ type: "Text", ...twin("searchedBefore", "text"), style: "h4" });
    body.push({ type: "titleGrid", key: "history", columns: { compact: 3, expanded: 6 }, items: history.slice(0, GRID_CAP) });
  }
  return {
    type: "Scaffold",
    appBar: backBar(tv, tv ? { title: form() } : twin("searchTitle", "title")),
    body: { type: "SingleChildScrollView", key: "search-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...status === "loading" ? { every: { ms: 1e3, event: "stick" } } : enriching ? { every: { ms: 1500, event: "senrich" } } : {}
  };
}
function liveView({ cats, cat, items, query = "", searching = false, partial = false, failed = false, device = "phone" }) {
  const tv = device === "tv";
  const form = () => searchForm(tv, query, "liveSearch", "lq", "lsearch", "liveSearchHint", "lsearchGo");
  const body = tv ? [] : [form()];
  if (cats && cats.length > 1 && query === "") {
    body.push({ type: "DropdownButton", key: "lcat", ...twin("liveCategory", "labelText"), value: cat, onChanged: "lcat", options: cats.slice(0, 500).map((c) => ({ value: c.id, label: c.title, labelEn: c.title })) });
  }
  if (failed) body.push({ type: "MaterialBanner", key: "liveFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "lretry" } });
  else if (cats && cats.length === 0) body.push({ type: "Text", ...twin("liveEmpty", "text"), color: "muted" });
  else if (items && items.length === 0) body.push({ type: "Text", ...twin("liveEmpty", "text"), color: "muted" });
  else if (items && tv) body.push({ type: "Row", key: "channels", wrap: true, gap: 24, children: items.slice(0, 40).map(roundChannel) });
  else if (items) {
    body.push({ type: "titleGrid", key: "channels", columns: { compact: 3, expanded: 6 }, items: items.slice(0, GRID_CAP) });
    if (items.length >= GRID_CAP) body.push({ type: "Text", ...twin("liveMore", "text", { n: GRID_CAP }), style: "caption", color: "muted" });
    if (partial) body.push({ type: "Text", ...twin("searchPartial", "text"), style: "caption", color: "muted" });
  } else body.push(gridSkeleton());
  return {
    type: "Scaffold",
    appBar: backBar(tv, tv ? { title: form() } : twin("live", "title")),
    body: { type: "SingleChildScrollView", key: "live-" + String(cat).replace(/[^A-Za-z0-9_-]/g, "_"), children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...!failed && (searching || query === "" && (!cats || !items)) ? { every: { ms: 1e3, event: "ltick" } } : {}
  };
}
var text = (key, extra = {}, vars) => ({ type: "Text", ...twin(key, "text", vars), ...extra });
var caption = (key, extra = {}, vars) => text(key, { style: "caption", color: "muted", ...extra }, vars);
var section = (key) => text(key, { style: "h4" });
var press = (event, arg) => ({ event, ...arg !== void 0 ? { arg } : {}, timeoutMs: PRESS_MS });
function settingsView({ srv, busy, pluginVersion, appVersion, device }) {
  const status = !srv ? { badge: "checking", sub: null } : !srv.host ? { badge: "setServerNone", sub: null } : { badge: srv.ok ? "setServerOk" : "setServerDown", sub: srv.total ? twin("setServerPos", "subtitle", { i: srv.index, n: srv.total }) : null };
  const deviceName = device === "tv" ? ["televisor", "TV"] : device === "desktop" ? ["computador", "desktop"] : ["tel\xE9fono", "phone"];
  const rows = [
    ["aboutPlugin", [pluginVersion, pluginVersion]],
    ["aboutKino", [appVersion || "?", appVersion || "?"]],
    ["aboutDevice", deviceName]
  ].map(([k, v], n) => ({ type: "TableRow", key: "diag" + n, children: [
    { type: "TableCell", ...twin(k) },
    { type: "TableCell", text: v[0], textEn: v[1] }
  ] }));
  return {
    type: "Scaffold",
    appBar: backBar(device === "tv", { ...twin("setTitle", "title") }),
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [
      { type: "Card", key: "connCard", children: [
        section("setConnection"),
        caption("setConnectionHint"),
        {
          type: "ListTile",
          key: "serverRow",
          ...twin("setServer", "title"),
          ...status.sub || {},
          leading: { type: "Icon", name: "language" },
          trailing: { type: "Badge", ...twin(status.badge) }
        },
        { type: "Row", wrap: true, gap: 8, children: [
          { type: "ElevatedButton", key: "switchServer", ...twin("setSwitch", "labelText"), icon: "refresh", ...twin("setSwitchHint", "tooltip"), enabled: !busy, onPressed: press("srv.switch") },
          { type: "Button", variant: "secondary", key: "refreshServers", ...twin("setRefresh", "labelText"), icon: "download", ...twin("setRefreshHint", "tooltip"), enabled: !busy, onPressed: press("srv.refresh") },
          { type: "TextButton", key: "checkServer", ...twin("setCheck", "labelText"), enabled: !busy, onPressed: press("srv.check") }
        ] }
      ] },
      { type: "Card", key: "adultCard", children: [
        section("setAdultTitle"),
        caption("setAdultHint"),
        { type: "settings", key: "adultForm", keys: ["showAdult"], autoSave: true, onSaved: "saved" }
      ] },
      { type: "Card", key: "liveCard", children: [
        section("setLiveTitle"),
        caption("setLiveHint"),
        { type: "settings", key: "liveForm", keys: ["liveFormat"], autoSave: true, onSaved: "saved" }
      ] },
      { type: "Card", key: "homeCard", children: [
        section("setHomeTitle"),
        caption("setHomeHint"),
        { type: "settings", key: "homeForm", keys: ["homeCountry"], autoSave: true, onSaved: "saved" }
      ] },
      { type: "Card", key: "aboutCard", children: [
        section("setAbout"),
        { type: "DataTable", key: "aboutTable", columns: [{ flex: 2 }, { flex: 3 }], wrap: true, zebra: true, children: rows }
      ] }
    ] }] },
    ...!srv ? { every: { ms: 1e3, event: "sstatus" } } : {}
  };
}
function verifyingView({ device } = {}) {
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar",
      divider: false,
      mergeWithKinoBar: true,
      dense: true,
      leading: barButton("close", "close", "close", { go: { close: true } }),
      title: title()
    },
    body: { type: "Column", key: "verifying", flex: 1, mainAxisAlignment: "center", crossAxisAlignment: "center", gap: 16, padding: { compact: 24, expanded: 48 }, children: [
      { type: "CircularProgressIndicator", key: "verifySpin" },
      { type: "Text", ...twin("verifying", "text"), textAlign: "center", color: "muted" }
    ] },
    every: { ms: POLL_MS, event: "tick" }
  };
}

// src/screen.js
var PLUGIN_VERSION = "0.3.33";
var TAB_KEY = "browseTab";
var LANG_KEY = "browseLang";
var HIST_KEY = "searchHist:v1";
var HIST_MAX = 24;
var CHANNELS_CAP = 60;
var RAILS_PER_TAB = 12;
var RAIL_ITEMS = 20;
var FEATURED = 6;
var SCREEN_ROUTES = ["main", "search", "live", "settings"];
var memo = /* @__PURE__ */ new Map();
var liveChans = /* @__PURE__ */ new Map();
var countryCards = null;
var recentCards = null;
var liveCats2 = null;
var found = null;
var liveFound = null;
var cacheKey = null;
function resetCaches() {
  memo.clear();
  liveChans.clear();
  countryCards = null;
  recentCards = null;
  liveCats2 = null;
  found = null;
  liveFound = null;
}
function syncServer() {
  const key = serverKey();
  if (cacheKey === null || cacheKey === "") {
    cacheKey = key;
    return;
  }
  if (key !== cacheKey) {
    resetCaches();
    cacheKey = key;
  }
}
var langOf = (ev) => ev && ev.lang === "en" ? "en" : "es";
var getStored = (k) => {
  try {
    return kino.storage.get(k) || null;
  } catch (_) {
    return null;
  }
};
var setStored = (k, v) => {
  put(k, v);
};
var storedTab = () => {
  const t = getStored(TAB_KEY);
  return TAB_IDS.includes(t) ? t : null;
};
var wantedLang = (state) => isLang(state.lang) ? state.lang : isLang(getStored(LANG_KEY)) ? getStored(LANG_KEY) : LANG_ORDER[0];
var histKey = () => HIST_KEY + ":" + serverKey();
function readHistory() {
  try {
    const o = JSON.parse(kino.storage.get(histKey()) || "null");
    return o && o.v === 1 && Array.isArray(o.e) ? o.e.filter((c) => c && typeof c.id === "string" && typeof c.ref === "string").slice(0, HIST_MAX) : [];
  } catch (_) {
    return [];
  }
}
function rememberFound(cards) {
  try {
    const slimmed = cards.filter((c) => c.adult !== true).slice(0, 12).map(({ id, ref, title: title2, kind, poster }) => ({ id, ref, title: title2, kind, ...poster ? { poster } : {} }));
    const ids = new Set(slimmed.map((c) => c.id));
    put(histKey(), JSON.stringify({ v: 1, e: [...slimmed, ...readHistory().filter((c) => !ids.has(c.id))].slice(0, HIST_MAX) }));
  } catch (_) {
  }
}
var railCards = (rails) => rails.map((r) => ({ id: r.id, title: r.title, ref: r.ref, items: r.items.map(cardOf) }));
var channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} });
async function loadVodTab(tab, lang, { home: home2 = false, offset = 0 } = {}) {
  const kind = tab === "movies" ? "vod" : "series";
  const maxRails = home2 ? tab === "movies" ? 7 : 4 : RAILS_PER_TAB;
  const info = await loadRailsInfo(kind, maxRails, RAIL_ITEMS, { lang, home: home2, offset });
  const wantFeatured = home2 && tab === "series" ? 0 : FEATURED;
  const featured = info.rails.flatMap((r) => r.items).filter((i) => i.overview).slice(0, wantFeatured);
  if (featured.length) await enrichFeatured(kind, featured, wantFeatured);
  const rails = info.rails.map((r) => ({ ...r, items: r.items.map(withFicha) }));
  const key = `${home2 ? "home-" : ""}${tab}:${lang}`;
  const prev = offset > 0 ? memo.get(key) : null;
  const have = new Set(prev ? prev.rails.map((r) => r.id) : []);
  const fresh = railCards(rails).filter((r) => !have.has(r.id));
  memo.set(key, { slides: prev ? prev.slides : slidesOf(rails), rails: prev ? [...prev.rails, ...fresh] : fresh, langs: info.langs, lang: info.lang, partial: info.failed > 0, hasMore: !home2 && !!info.hasMore, next: info.next, cats: prev ? prev.cats : info.cats });
}
async function loadLiveTab() {
  const cats = (await liveCategories()).slice(0, RAILS_PER_TAB);
  let failed = 0;
  const rails = [];
  const results = [];
  for (let i = 0; i < cats.length; i += 3) {
    results.push(...await Promise.all(cats.slice(i, i + 3).map(async (c) => {
      try {
        return { c, page: await liveChannels({ categoryId: c.id }) };
      } catch (_) {
        failed++;
        return null;
      }
    })));
  }
  for (const r of results) {
    if (!r) continue;
    const items = r.page.items.slice(0, RAIL_ITEMS).map(channelCard);
    if (items.length) rails.push({ id: "lcat-" + r.c.id, title: r.c.title, ref: "lcat:" + r.c.id, items });
  }
  if (!rails.length && failed) throw new Error("live");
  memo.set("live", { slides: [], rails: railCards(rails), langs: [], lang: null, partial: failed > 0 });
}
async function loadRecent() {
  const key = serverKey();
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  let lookups = 0;
  for (const e of recentEntriesAll()) {
    let card = e.card;
    if (!card && e.srv === key && lookups < 6) {
      lookups++;
      try {
        const item = await vodInfoItem(e.id);
        card = item ? cardOf(item) : null;
        if (card) rememberCard(key, e.id, card);
      } catch (_) {
        card = null;
      }
    }
    if (!card || card.adult && !showAdult()) continue;
    const dk = findKey(card.title);
    if (!dk || seen.has(dk)) continue;
    let ref = card.ref;
    if (e.srv !== key) {
      const ix = idxRefFor(card.kind, card.title, card.year);
      if (!ix) continue;
      ref = ix;
    }
    seen.add(dk);
    out.push(ref === card.ref ? card : { ...card, ref });
    if (out.length >= 12) break;
  }
  recentCards = out;
}
var countryOn = () => homeCountry() !== "none";
function unitsFor(tab, lang) {
  if (tab === "home") return ["health", `home:movies:${lang}`, `home:series:${lang}`, ...countryOn() ? ["country"] : [], "recent", "index"];
  return ["health", tab === "live" ? "tab:live" : `tab:${tab}:${lang}`];
}
function memoKey(unit) {
  const [prefix, tab, lang] = unit.split(":");
  if (tab === "live") return "live";
  return prefix === "home" ? `home-${tab}:${lang}` : `${tab}:${lang}`;
}
function isDone(unit) {
  if (unit === "country") return countryCards !== null;
  if (unit === "recent") return recentCards !== null;
  if (unit === "index") return !indexNeeded();
  if (unit === "health") return healthReady();
  return memo.has(memoKey(unit));
}
function pendingUnit(state, tab, device) {
  const failed = state.failed || {};
  const lang = wantedLang(state);
  return unitsFor(tab, lang).find((u) => !isDone(u) && !failed[u]) || null;
}
async function runUnit(unit) {
  if (unit === "country") {
    const row = await countryRow(20);
    countryCards = row ? row.items.map(cardOf) : [];
  } else if (unit === "recent") await loadRecent();
  else if (unit === "index") {
    const out = await indexStep({ budgetMs: 2500 });
    if (out === "error" || out === "wait") throw new Error("\xEDndice: " + out);
  } else if (unit === "health") await healthCheck();
  else {
    const [prefix, tab, lang] = unit.split(":");
    if (tab === "live") await loadLiveTab();
    else await loadVodTab(tab, lang, { home: prefix === "home" });
  }
}
function tabData(tab, lang, state = {}) {
  if (tab === "live") return memo.get("live") || null;
  if (tab !== "home") {
    const base = memo.get(`${tab}:${lang}`) || null;
    const one = base && state.cat ? onlyCat.get(`${tab}:${lang}:${state.cat}`) : null;
    return one ? { ...base, rails: one.rails, hasMore: false, catSel: state.cat } : base ? { ...base, catSel: "" } : null;
  }
  const m = memo.get(`home-movies:${lang}`);
  const s = memo.get(`home-series:${lang}`);
  if (!m && !s) return null;
  const rails = [...m ? m.rails : [], ...s ? s.rails : []];
  const src = m || s;
  return { slides: [...m ? m.slides : [], ...s ? s.slides : []].slice(0, FEATURED), rails, langs: src.langs, lang: src.lang, partial: !!(m && m.partial || s && s.partial) };
}
var tabOf = (state, route) => {
  const a = route && route.args && typeof route.args === "object" ? route.args : {};
  return TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS.includes(a.tab) ? a.tab : storedTab() || TAB_IDS[0];
};
function mainView(ctx) {
  const state = ctx.state || {};
  if (!healthReady() && !(state.failed && state.failed.health)) return verifyingView({ device: ctx.device });
  const tab = tabOf(state, ctx.route);
  const lang = wantedLang(state);
  const data = tabData(tab, lang, state);
  const failed = unitsFor(tab, lang).some((u) => state.failed && state.failed[u]);
  return browseView({
    tab,
    data,
    recent: recentCards || [],
    country: countryCards || [],
    loading: pendingUnit(state, tab, ctx.device) !== null,
    failed: !data && failed,
    device: ctx.device
  });
}
async function screen(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const state = c.state && typeof c.state === "object" ? c.state : {};
  const name = c.route && SCREEN_ROUTES.includes(c.route.name) ? c.route.name : "main";
  try {
    syncServer();
    if (name === "search") {
      const query = typeof state.sq === "string" ? state.sq : "";
      const items = found && found.q === query ? found.items : null;
      const status = query === "" ? "idle" : state.sstate === "fail" ? "fail" : items ? "done" : "loading";
      const enriching = !!(found && found.q === query && items && tmdbAvailable() && found.enr < found.raw.length);
      return searchView({ query, status, items, enriching, partial: !!(found && found.q === query && found.partial), history: query === "" ? readHistory() : [], device: c.device });
    }
    if (name === "live") {
      const cur = typeof state.lcat === "string" ? state.lcat : liveCats2 && liveCats2[0] ? liveCats2[0].id : null;
      const lq = typeof state.lq === "string" ? state.lq : "";
      const failed = state.lfail === true;
      if (lq !== "") {
        const done = liveFound && liveFound.q === lq;
        return liveView({ cats: liveCats2, cat: cur, items: done ? liveFound.items : null, query: lq, searching: !done, partial: !!(done && liveFound.partial), failed, device: c.device });
      }
      return liveView({ cats: liveCats2, cat: cur, items: cur !== null && liveChans.has(cur) ? liveChans.get(cur) : null, failed, device: c.device });
    }
    if (name === "settings") {
      let appVersion = "";
      try {
        appVersion = typeof kino.appVersion === "string" ? kino.appVersion : "";
      } catch (_) {
        appVersion = "";
      }
      return settingsView({ srv: state.srv || null, busy: state.busy === true, pluginVersion: PLUGIN_VERSION, appVersion, device: c.device });
    }
    return mainView({ ...c, state });
  } catch (_) {
    return { type: "Column", padding: 16, children: [{ type: "settings", key: "classicForm" }] };
  }
}
var cardsOf = (items) => (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === "string" && typeof i.ref === "string").slice(0, CHANNELS_CAP).map(cardOf);
var bump = (state) => ({ n: (state.n || 0) + 1 });
var onlyCat = /* @__PURE__ */ new Map();
function serverSheet(servers) {
  const cur = servers.current;
  const rows = (servers.items || []).slice(0, 60).map((s) => {
    const sel = s.i === cur;
    const hasCountry = s.label !== s.host;
    const title2 = hasCountry ? s.label : s.host;
    const sub = hasCountry ? s.https ? s.host : `${s.host} \xB7 http` : s.https ? "" : "http";
    const leading = s.flag ? { type: "Image", key: "flag-" + s.i, url: `https://flagcdn.com/w40/${s.flag}.png`, w: 32, h: 24 } : { type: "Icon", name: "language" };
    return {
      type: "ListTile",
      key: "srvrow-" + s.i,
      title: title2,
      titleEn: title2,
      selected: sel,
      leading,
      ...sub ? { subtitle: sub, subtitleEn: sub } : {},
      ...sel ? { trailing: { type: "Icon", name: "check" } } : {},
      onTap: { event: "srv.pick", arg: String(s.i) }
    };
  });
  const body = rows.length ? rows : [{ type: "Text", key: "srvEmpty", ...twin("liveEmpty", "text") }];
  return { ...twin("setPick", "title"), body };
}
var events = {
  open({ route, state }) {
    if (route && route.name && route.name !== "main") return null;
    return { state: { tab: tabOf(state, route), lang: wantedLang(state), ...bump(state), failed: null } };
  },
  tab({ value, arg, state }) {
    const tab = TAB_IDS.includes(value) ? value : TAB_IDS.includes(arg) ? arg : null;
    if (!tab) return null;
    setStored(TAB_KEY, tab);
    const failed = { ...state.failed || {} };
    for (const u of unitsFor(tab, wantedLang(state))) delete failed[u];
    return { state: { tab, ...bump(state), failed } };
  },
  lang({ value, state }) {
    if (!isLang(value)) return null;
    setStored(LANG_KEY, value);
    return { state: { lang: value, cat: null, ...bump(state), failed: null } };
  },
  retry({ state }) {
    const tab = tabOf(state);
    const lang = wantedLang(state);
    for (const u of unitsFor(tab, lang)) {
      const key = memoKey(u);
      if (memo.has(key) && memo.get(key).partial) memo.delete(key);
    }
    return { state: { failed: null, ...bump(state) } };
  },
  async vcat({ value, state }) {
    const tab = tabOf(state);
    if (tab === "live" || tab === "home") return null;
    const id = typeof value === "string" ? value : "";
    if (id === "") return { state: { cat: null, ...bump(state) } };
    const lang = wantedLang(state);
    const key = `${tab}:${lang}:${id}`;
    if (!onlyCat.has(key)) {
      const info = await loadRailsInfo(tab === "movies" ? "vod" : "series", 1, 60, { lang, only: id });
      onlyCat.set(key, { rails: railCards(info.rails.map((r) => ({ ...r, items: r.items.map(withFicha) }))) });
    }
    cacheKey = serverKey();
    return { state: { cat: id, ...bump(state) } };
  },
  async more({ state }) {
    const tab = tabOf(state);
    if (tab === "live" || tab === "home") return null;
    const lang = wantedLang(state);
    const m = memo.get(`${tab}:${lang}`);
    if (!m || !m.hasMore) return null;
    await loadVodTab(tab, lang, { offset: m.next });
    cacheKey = serverKey();
    return { state: { ...bump(state) } };
  },
  async tick({ state, device }) {
    const tab = tabOf(state);
    const unit = pendingUnit(state, tab, device);
    if (!unit) return null;
    const failed = { ...state.failed || {} };
    try {
      await runUnit(unit);
    } catch (_) {
      failed[unit] = true;
    }
    cacheKey = serverKey();
    return { state: { ...bump(state), failed } };
  },
  openSearch() {
    return { route: { push: "search" }, state: { sq: "", sstate: null } };
  },
  search({ value, route }) {
    const raw = typeof value === "string" ? value : value && typeof value.q === "string" ? value.q : "";
    const q = raw.trim().slice(0, 100);
    if (q === "") return null;
    const state = { sq: q, sstate: "loading" };
    return route && route.name === "search" ? { state } : { route: { push: "search" }, state };
  },
  // Pósters del resto de los resultados: 20 por tick (límite de TMDB de Kino), mientras el usuario mira los primeros.
  async senrich({ state }) {
    if (!found || !found.raw) return null;
    const slice = found.raw.slice(found.enr, found.enr + 20);
    found.enr += 20;
    if (slice.length) await enrichTmdb(slice, { max: 20, budgetMs: 2500 });
    found.items = found.raw.map(cardOf);
    return { state: { senr: (state.senr || 0) + 1 } };
  },
  async stick({ state }) {
    const q = typeof state.sq === "string" ? state.sq : "";
    if (q === "") return null;
    if (found && found.q === q) return { state: { sstate: "done" } };
    try {
      const out = await searchDetailed({ q }, { budgetMs: 14e3 });
      const raw = out.items.slice(0, 60);
      found = { q, raw, enr: 20, items: raw.map(cardOf), partial: out.partial };
      rememberFound(found.items);
      cacheKey = serverKey();
      return { state: { sstate: "done" } };
    } catch (_) {
      return { state: { sstate: "fail" } };
    }
  },
  sretry({ state }) {
    if (typeof state.sq !== "string" || state.sq === "") return null;
    found = null;
    return { state: { sstate: "loading" } };
  },
  back() {
    return { route: { pop: true }, state: { sq: null, sstate: null } };
  },
  async ltick({ state }) {
    const lq = typeof state.lq === "string" ? state.lq : "";
    if (lq !== "") {
      if (!(liveFound && liveFound.q === lq)) {
        let out;
        try {
          out = await liveSearchDetailed({ query: lq }, { budgetMs: 14e3 });
        } catch (_) {
          return { state: { lfail: true } };
        }
        liveFound = { q: lq, items: cardsOf(out.items.map(channelCard)), partial: out.partial };
      }
      return { state: { lq } };
    }
    if (!liveCats2) {
      try {
        liveCats2 = await liveCategories();
      } catch (_) {
        return { state: { lfail: true } };
      }
      cacheKey = serverKey();
      return { state: { lcat: typeof state.lcat === "string" ? state.lcat : null } };
    }
    const cur = typeof state.lcat === "string" ? state.lcat : liveCats2[0] ? liveCats2[0].id : null;
    if (cur === null) return { state: { lcat: null } };
    if (!liveChans.has(cur)) {
      let page;
      try {
        page = await liveChannels({ categoryId: cur });
      } catch (_) {
        return { state: { lfail: true } };
      }
      liveChans.set(cur, cardsOf(page.items.map(channelCard)));
    }
    return { state: { lcat: cur } };
  },
  lsearch({ value }) {
    const raw = typeof value === "string" ? value : value && typeof value.lq === "string" ? value.lq : "";
    const q = raw.trim().slice(0, 100);
    return { state: { lq: q === "" ? null : q } };
  },
  lcat({ value }) {
    return typeof value === "string" && value !== "" ? { state: { lcat: value, lfail: null } } : null;
  },
  lretry() {
    liveFound = null;
    return { state: { lfail: null } };
  },
  go({ arg }) {
    if (arg === "live") return { route: { push: "live" }, state: { lcat: null, lq: null, lfail: null } };
    if (arg === "settings") return { route: { push: "settings" }, state: { srv: null, busy: false } };
    return null;
  },
  async sstatus() {
    return { state: { srv: await serverStatus() } };
  },
  async "srv.check"() {
    return { state: { srv: await serverStatus(), busy: false } };
  },
  async "srv.switch"({ lang }) {
    const r = await switchServer();
    const srv = await serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.changed ? "switched" : "noOther", lang, { host: r.host }), role: r.changed ? "success" : "warning" } };
  },
  async "srv.refresh"({ lang }) {
    const r = await refreshServers();
    const srv = await serverStatus();
    return { state: { srv, busy: false }, toast: { text: say(r.ok ? "refreshed" : "refreshFail", lang, { n: r.total }), role: r.ok ? "success" : "error" } };
  },
  // Modal (sheet) del selector de servidor, abierto desde el botón del header.
  async openServers() {
    let servers;
    try {
      servers = await serverList();
    } catch (_) {
      servers = { current: -1, items: [] };
    }
    return { state: { servers }, sheet: serverSheet(servers) };
  },
  // Elegido un servidor: fijar, recargar por debajo y re-dibujar el sheet con el ✓ en el elegido (NO cerrar el plugin).
  async "srv.pick"({ arg, state, lang }) {
    const r = await selectServer(arg);
    if (r.ok) {
      resetCaches();
      cacheKey = serverKey();
    }
    let servers;
    try {
      servers = await serverList();
    } catch (_) {
      servers = { current: -1, items: [] };
    }
    return { state: { ...bump(state), failed: null, servers }, sheet: serverSheet(servers), toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
  },
  saved({ state }) {
    return { state: bump(state) };
  }
};
async function screenEvent(ev) {
  const e = ev && typeof ev === "object" ? ev : {};
  const handler = Object.hasOwn(events, e.name) ? events[e.name] : null;
  if (!handler) return null;
  try {
    syncServer();
    return await handler({ ...e, state: e.state || {}, lang: langOf(e) }) ?? null;
  } catch (_) {
    return { toast: { text: say("failed", langOf(e)), role: "error" } };
  }
}
var SECTION_TABS = [
  { id: "movies", label: "Pel\xEDculas", en: "Movies" },
  { id: "series", label: "Series", en: "Series" },
  { id: "live", label: "En vivo", en: "Live" }
];
function heroOf(rows) {
  for (const row of rows) {
    for (const item of row.items) {
      const text2 = typeof item.overview === "string" ? item.overview.trim() : "";
      if (item.adult === true || !item.backdrop || !/^https:\/\//.test(item.backdrop) || text2 === "") continue;
      return { title: item.title, text: text2.length <= 300 ? text2 : `${text2.slice(0, 299).trimEnd()}\u2026`, image: item.backdrop };
    }
  }
  return null;
}
async function section2(arg) {
  const asked = arg && typeof arg === "object" ? arg.tab : null;
  const tab = asked || SECTION_TABS[0].id;
  if (!SECTION_TABS.some((t) => t.id === tab)) throw kino.error("not_found", "No se encontr\xF3 esa pesta\xF1a");
  const english = /^en/i.test(String(kino.lang || ""));
  let rows = [];
  if (tab === "live") {
    const cats = (await liveCategories()).slice(0, RAILS_PER_TAB);
    for (let i = 0; i < cats.length; i += 3) {
      const batch = await Promise.all(cats.slice(i, i + 3).map(async (c) => {
        try {
          const page = await liveChannels({ categoryId: c.id });
          const items = page.items.slice(0, RAIL_ITEMS).map(channelCard);
          return items.length ? { id: "lcat-" + c.id, title: c.title, ref: "lcat:" + c.id, items } : null;
        } catch (_) {
          return null;
        }
      }));
      rows.push(...batch.filter(Boolean));
    }
  } else {
    const kind = tab === "movies" ? "vod" : "series";
    const info = await loadRailsInfo(kind, RAILS_PER_TAB, RAIL_ITEMS, {});
    await enrichFeatured(kind, info.rails.flatMap((r) => r.items).filter((i) => i.overview).slice(0, FEATURED), FEATURED);
    rows = info.rails.map(({ genre, lang, ...r }) => ({ ...r, items: r.items.map(withFicha) }));
  }
  const hero2 = heroOf(rows);
  return { tabs: SECTION_TABS.map((t) => ({ id: t.id, label: english ? t.en : t.label })), tab, ...hero2 ? { hero: hero2 } : {}, rows };
}
export {
  action,
  browse,
  episodes,
  guide,
  home,
  liveCategories,
  liveChannels,
  liveSearch,
  resolve,
  screen,
  screenEvent,
  search,
  section2 as section,
  settingsStatus
};
