// src/store.js
var SOFT_CAP = 200 * 1024;
var CLASSES = {
  servers: { match: (k) => k === "srvs" || k === "vcode", budget: 8 * 1024, keep: true },
  // The person's choices: nothing else can evict them (they used to share the 2 KB "misc" class with avail:v1 and the health
  // result, and about 13 plays were enough to push srvChosen:v1 out).
  prefs: { match: (k) => k === "srvChosen:v1" || k === "browseTab" || k === "browseLang" || k === "seed:v1", budget: 256, keep: true },
  health: { match: (k) => k === "health:v1", budget: 3 * 1024, keep: true },
  panels: { match: (k) => k === "panels:v1", budget: 4 * 1024, keep: true },
  acct: { match: (k) => k === "acct:v1", budget: 2 * 1024, keep: true },
  // The live failover's last switch (live:v1): the account it moved a channel to survives a runtime restart.
  live: { match: (k) => k === "live:v1", budget: 512, keep: true },
  // Which server has which title (the "Servidor" menu's learning): its own class, trimmed by bytes in catalog.js.
  avail: { match: (k) => k === "avail:v1", budget: 16 * 1024 },
  cats: { match: (k) => k.startsWith("cats:"), budget: 60 * 1024 },
  hero: { match: (k) => k.startsWith("vinfo:"), budget: 30 * 1024 },
  hist: { match: (k) => k.startsWith("searchHist:"), budget: 10 * 1024 },
  recent: { match: (k) => k.startsWith("recent:"), budget: 30 * 1024 },
  idx: { match: (k) => k.startsWith("idx:"), budget: 6 * 1024 },
  tmdb: { match: (k) => k.startsWith("tmdb:"), budget: 24 * 1024 },
  // Snapshots de las pestañas (Inicio/Películas/Series/En vivo, una entrada por servidor+pestaña+idioma): pintan al instante al reabrir.
  homeSnap: { match: (k) => k.startsWith("homeSnap:"), budget: 40 * 1024 },
  misc: { match: () => true, budget: 2 * 1024 }
};
var ORDER = ["servers", "prefs", "health", "panels", "acct", "live", "avail", "cats", "hero", "hist", "recent", "idx", "tmdb", "homeSnap", "misc"];
var IDX = "_idx";
var TOUCH_MS = 60 * 60 * 1e3;
var IDX_REFRESH_MS = 10 * 60 * 1e3;
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
function jsonSize(s) {
  const str = String(s);
  let n = utf8Len(str) + 2;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 34 || c === 92 || c === 47 || c === 9 || c === 10 || c === 13 || c === 8 || c === 12) n += 1;
    else if (c < 32) n += 5;
  }
  return n;
}
var sizeOf = (key, value) => jsonSize(key) + jsonSize(value) + 2;
var mem = null;
function load() {
  let storage = null;
  try {
    storage = kino.storage;
  } catch (_) {
    storage = null;
  }
  if (mem && mem.storage === storage) return mem;
  let raw = {};
  try {
    const o = JSON.parse(storage.get(IDX) || "null");
    if (o && typeof o === "object" && !Array.isArray(o)) raw = o;
  } catch (_) {
    raw = {};
  }
  mem = { storage, idx: {}, dirty: false, keys: false, at: 0 };
  for (const k of Object.keys(raw)) {
    const e = raw[k];
    if (Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1])) mem.idx[k] = [e[0], e[1]];
    else mem.idx[k] = [Number(e) || 0, -1];
  }
  return mem;
}
function sync(m) {
  let keys = [];
  try {
    keys = m.storage.keys();
  } catch (_) {
    return m;
  }
  const present = new Set(keys);
  for (const k of Object.keys(m.idx)) if (!present.has(k)) {
    delete m.idx[k];
    m.dirty = true;
    m.keys = true;
  }
  for (const k of keys) {
    if (k === IDX) continue;
    const e = m.idx[k];
    if (e && e[1] >= 0) continue;
    let v = null;
    try {
      v = m.storage.get(k);
    } catch (_) {
      v = null;
    }
    if (v === null || v === void 0) continue;
    if (!e) m.keys = true;
    m.idx[k] = [e ? e[0] : 0, sizeOf(k, v)];
    m.dirty = true;
  }
  return m;
}
var idxText = (m) => JSON.stringify(m.idx);
function flush() {
  try {
    const m = mem;
    if (!m || !m.dirty) return;
    if (!m.keys && m.at && Date.now() - m.at < IDX_REFRESH_MS) return;
    let same = false;
    try {
      same = m.storage === kino.storage;
    } catch (_) {
      same = false;
    }
    if (!same) return;
    m.storage.set(IDX, idxText(m));
    m.dirty = false;
    m.keys = false;
    m.at = Date.now();
  } catch (_) {
  }
}
function entries(m) {
  return Object.keys(m.idx).map((k) => ({ key: k, klass: classOf(k), bytes: m.idx[k][1], ts: m.idx[k][0] }));
}
function evict(m, list, key) {
  try {
    m.storage.remove(key);
  } catch (_) {
  }
  delete m.idx[key];
  m.dirty = true;
  m.keys = true;
  const i = list.findIndex((e) => e.key === key);
  if (i >= 0) list.splice(i, 1);
}
function put(key, value) {
  try {
    const text2 = String(value);
    const klass = classOf(key);
    const need = sizeOf(key, text2);
    if (need > CLASSES[klass].budget) return false;
    const m = sync(load());
    let stored = null;
    try {
      stored = m.storage.get(key);
    } catch (_) {
      stored = null;
    }
    if (stored === text2) {
      const e = m.idx[key];
      if (!e || e[1] !== need || Date.now() - e[0] > TOUCH_MS) {
        m.idx[key] = [Date.now(), need];
        m.dirty = true;
      }
      return true;
    }
    const list = entries(m).filter((e) => e.key !== key);
    const oldest = (pred) => list.filter(pred).sort((a, b) => a.ts - b.ts)[0];
    let used = list.filter((e) => e.klass === klass).reduce((n, e) => n + e.bytes, 0);
    while (used + need > CLASSES[klass].budget) {
      const victim = oldest((e) => e.klass === klass);
      if (!victim) return false;
      used -= victim.bytes;
      evict(m, list, victim.key);
    }
    let total = list.reduce((n, e) => n + e.bytes, 0) + need + 2 + 32 * (list.length + 1) + 512;
    while (total > SOFT_CAP) {
      const victim = oldest((e) => !CLASSES[e.klass].keep && e.klass !== klass) || oldest((e) => !CLASSES[e.klass].keep);
      if (!victim) return false;
      total -= victim.bytes + 32;
      evict(m, list, victim.key);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        m.storage.set(key, text2);
        if (!m.idx[key]) m.keys = true;
        m.idx[key] = [Date.now(), need];
        m.dirty = true;
        return true;
      } catch (_) {
        const victim = oldest((e) => !CLASSES[e.klass].keep);
        if (!victim) return false;
        evict(m, list, victim.key);
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

// src/homeFeed.js
var REPO = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd/";
var DATA_BRANCH = "data";
var MAIN_BRANCH = "main";
var DATA_MISS_KEY = "feedData:v1";
var DATA_MISS_TTL_MS = 6 * 60 * 60 * 1e3;
var MIN_REQUEST_MS = 1e3;
var MAX_AGE_MS = 3 * 24 * 60 * 60 * 1e3;
var dataMissAt;
function dataMissing() {
  if (dataMissAt === void 0) {
    let o = null;
    try {
      o = JSON.parse(kino.storage.get(DATA_MISS_KEY) || "null");
    } catch (_) {
      o = null;
    }
    dataMissAt = o && typeof o.at === "number" ? o.at : 0;
  }
  const age = Date.now() - dataMissAt;
  return dataMissAt > 0 && age >= 0 && age < DATA_MISS_TTL_MS;
}
function noteDataMissing() {
  dataMissAt = Date.now();
  put(DATA_MISS_KEY, JSON.stringify({ at: dataMissAt }));
}
var canGunzip = () => {
  try {
    return typeof kino.crypto.gunzip === "function";
  } catch (_) {
    return false;
  }
};
function openBox(text2) {
  let box = null;
  try {
    box = JSON.parse(text2);
  } catch (_) {
    return null;
  }
  if (!box || typeof box !== "object" || box.v !== 1 && box.v !== 2 || typeof box.iv !== "string" || typeof box.data !== "string") return null;
  try {
    const opts = { key: kino.secret("feedKey"), iv: box.iv, ivEncoding: "base64", data: box.data };
    if (box.v === 1) return JSON.parse(kino.crypto.decrypt("aes-256-gcm", opts));
    if (!canGunzip()) return null;
    return JSON.parse(kino.crypto.gunzip(kino.crypto.decrypt("aes-256-gcm", { ...opts, outputEncoding: "base64" })));
  } catch (_) {
    return null;
  }
}
var v2Path = (path) => path.replace(/\.enc\.json$/, ".v2.enc.json");
async function fetchSealed(path, v, accept, until) {
  const dataPath = canGunzip() ? v2Path(path) : path;
  const one = async (branch, file) => {
    const init = { headers: { Accept: "application/json" } };
    if (until) {
      const left = until - Date.now();
      if (left < MIN_REQUEST_MS) return { late: true };
      init.timeoutMs = left;
    }
    const r = await kino.fetch(`${REPO}${branch}/${file}?v=${v}`, init);
    if (!r.ok) {
      console.log("[dbg] feed: HTTP " + r.status + " " + branch + "/" + file.split("/")[0]);
      return { status: r.status };
    }
    const text2 = r.text();
    const d = openBox(text2);
    if (!d) {
      console.log("[dbg] feed: NO ABRE " + branch + "/" + file.split("/")[0]);
      return { status: r.status };
    }
    return { d, kb: Math.round(text2.length / 1024) };
  };
  if (!dataMissing()) {
    const a = await one(DATA_BRANCH, dataPath);
    if (a.d) return accept(a.d, a.kb);
    if (a.late) return null;
    const b2 = await one(MAIN_BRANCH, path);
    const out = b2.d ? accept(b2.d, b2.kb) : null;
    if (out && a.status === 404) noteDataMissing();
    return out;
  }
  const b = await one(MAIN_BRANCH, path);
  return b.d ? accept(b.d, b.kb) : null;
}
function tabOf(t) {
  if (!t || !Array.isArray(t.rows)) return null;
  const rows = t.rows.filter((r) => r && typeof r.id === "string" && typeof r.title === "string" && Array.isArray(r.items) && r.items.length);
  if (!rows.length) return null;
  return { slides: Array.isArray(t.slides) ? t.slides : [], rows, cats: Array.isArray(t.cats) ? t.cats : [] };
}
async function fetchHomeFeed(serverKey2, lang, opts) {
  if (!serverKey2) return null;
  const until = opts && opts.until || 0;
  if (lang === "es-419" || lang === "es-ES") {
    const own = await fetchFeedFile(serverKey2, serverKey2 + "." + lang, until);
    if (own && own.lang === lang) return own;
  }
  return fetchFeedFile(serverKey2, serverKey2, until);
}
async function fetchFeedFile(serverKey2, name, until) {
  try {
    return await fetchSealed(`home/${encodeURIComponent(name)}.enc.json`, Math.floor(Date.now() / 36e5), (d, kb) => {
      if (d.v !== 1 || d.serverKey !== serverKey2 || !Array.isArray(d.rows) || !d.rows.length) {
        console.log("[dbg] homefeed: contenido no valido v=" + d.v + " serverKey=" + d.serverKey + " esperado=" + serverKey2 + " rows=" + (Array.isArray(d.rows) ? d.rows.length : "n/a"));
        return null;
      }
      if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) {
        console.log("[dbg] homefeed: VIEJO " + Math.round((Date.now() - d.at) / 36e5) + " h");
        return null;
      }
      const home3 = tabOf({ slides: d.slides, rows: d.rows });
      if (!home3) {
        console.log("[dbg] homefeed: tabOf(home) vacio");
        return null;
      }
      console.log("[dbg] homefeed: OK key=" + serverKey2 + " lang=" + d.lang + " home=" + home3.rows.length + " movies=" + (d.movies && d.movies.rows ? d.movies.rows.length : 0) + " series=" + (d.series && d.series.rows ? d.series.rows.length : 0) + " " + kb + "KB");
      return {
        lang: typeof d.lang === "string" ? d.lang : null,
        langs: Array.isArray(d.langs) ? d.langs : [],
        slides: home3.slides,
        rows: home3.rows,
        movies: tabOf(d.movies),
        // null en feeds v1
        series: tabOf(d.series)
      };
    }, until);
  } catch (e) {
    console.log("[dbg] homefeed: EXCEPCION " + (e && e.message));
    return null;
  }
}
async function fetchLiveFeed(serverKey2, opts) {
  if (!serverKey2) return null;
  try {
    return await fetchSealed(`live/${encodeURIComponent(serverKey2)}.enc.json`, Math.floor(Date.now() / 864e5), (d) => {
      if (d.v !== 1 || d.serverKey !== serverKey2 || !Array.isArray(d.rails) || !d.rails.length) return null;
      if (typeof d.at === "number" && Date.now() - d.at > MAX_AGE_MS) return null;
      const rails = d.rails.filter((r2) => r2 && typeof r2.id === "string" && typeof r2.title === "string" && Array.isArray(r2.items) && r2.items.length);
      return rails.length ? { rails } : null;
    }, opts && opts.until || 0);
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
  while (jsonSize(text2) > 26 * 1024 && kept.length > 1) {
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
var deltaCache = null;
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
async function fetchJson(file, hash, tries, timeoutMs) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await kino.fetch(`${fetchBase}${file}?v=${hash || Date.now()}`, { headers: { Accept: "application/json" }, ...timeoutMs ? { timeoutMs } : {} });
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
var indexSource = () => {
  const st = readState();
  return st && st.src ? String(st.src) : "";
};
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
    if (serverUrl && !indexFitsServer(serverUrl)) parts.push("de otro servidor, pero la b\xFAsqueda lo usa igual (los resultados se abren en el servidor activo)");
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
var did = false;
var late = (needMs, deadline) => did && Date.now() + needMs > deadline;
async function step({ budgetMs = 6e3 } = {}) {
  const deadline = Date.now() + budgetMs;
  did = false;
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
      did = true;
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
    const usable2 = !!st && st.done && await safeCount() > 0;
    const chain = usable2 ? chainFor(st.rev, m) : null;
    if (usable2 && chain) {
      st.stage = { mode: "delta", src: m.src || "", target: m.revision, hash: m.hash, gen: m.generated, mc: m.movies.count, sc: m.series.count, chain, next: 0, offA: 0, offR: 0, fails: 0, snap: snapshotStage(m, false) };
    } else if (usable2) {
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
    if (late(2e3, deadline)) {
      writeState(st);
      return "paused";
    }
    const { file, to } = sg.chain[sg.next];
    const from = sg.next === 0 ? st.rev : sg.chain[sg.next - 1].to;
    let d;
    try {
      if (deltaCache && deltaCache.file === file) d = deltaCache.d;
      else {
        d = validDelta(await download(file, to, 1), from, to);
        deltaCache = { file, d };
        did = true;
      }
    } catch (e) {
      sg.fails++;
      if (sg.fails >= 2 || /inválid|desaline/.test(String(e && e.message))) return toSnapshot();
      writeState(st);
      return "error";
    }
    try {
      for (let off = sg.offA; off < d.added.length; ) {
        if (late(lastBatchMs, deadline)) {
          sg.offA = off;
          writeState(st);
          return "paused";
        }
        const n = batchSize;
        const rows = d.added.slice(off, off + n).map((e) => rowOf(e.k, e.n, e.y, e.t, e.c, st.snap));
        await timed(st, rows.length, () => upsertKeeping(rows, true));
        did = true;
        stats.upserted += rows.length;
        off += n;
      }
      sg.offA = d.added.length;
      for (let off = sg.offR; off < d.removed.length; ) {
        if (late(lastBatchMs, deadline)) {
          sg.offR = off;
          writeState(st);
          return "paused";
        }
        const n = batchSize;
        const ids = d.removed.slice(off, off + n);
        await timed(st, ids.length, () => kino.catalog.remove(ids));
        did = true;
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
    deltaCache = null;
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
    if (!(partCache && sg.offset > 0) && late(1200, deadline)) {
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
        did = true;
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
      if (late(lastBatchMs, deadline)) {
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
        did = true;
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
      if (late(1500, deadline)) {
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
      did = true;
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
async function indexCategoryNames(opts = {}) {
  if (catNames) return catNames;
  try {
    const j = await fetchJson("categories.json", "", 1, opts.timeoutMs);
    catNames = { vod: j && j.vod || {}, series: j && j.series || {} };
  } catch (_) {
    if (opts.cacheMiss === false) return { vod: {}, series: {} };
    catNames = { vod: {}, series: {} };
  }
  return catNames;
}
async function resolveIdxRef(ref, fetchCategory2, moreCats) {
  const p = parseIdxRef(ref);
  if (!p) throw kino.error("not_found", "ref desconocido");
  const action3 = p.kind === "movies" ? "get_vod_streams" : "get_series";
  let failed = 0;
  let tried = 0;
  const seen = /* @__PURE__ */ new Set();
  const look = async (cat) => {
    if (seen.has(String(cat))) return null;
    seen.add(String(cat));
    tried++;
    let data;
    try {
      data = await fetchCategory2(action3, cat);
    } catch (_) {
      failed++;
      return null;
    }
    let fallback = null;
    for (const x of data) {
      const { name, year } = cleanTitle(x.name || x.title, x.year || (x.release_date ? String(x.release_date).slice(0, 4) : ""));
      if (findKey(name) !== p.find) continue;
      const out = p.kind === "movies" ? `vod:${x.stream_id}:${x.container_extension || "mp4"}` : `series:${x.series_id}`;
      if (p.year && year) {
        if (year === p.year) return out;
        continue;
      }
      if (!fallback) fallback = out;
    }
    return fallback;
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
  while (jsonSize(text2) > MAP_MAX_BYTES && ids.length > 1) {
    delete map[ids.shift()];
    text2 = JSON.stringify(map);
  }
  put(MAP_KEY, text2);
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
          const r = await queryOne(c);
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
  firstPickTitle: ["Elige tu servidor", "Choose your server"],
  firstPickHint: ["Elige desde d\xF3nde ver. El primero ya est\xE1 listo; puedes elegir otro. Luego lo cambias cuando quieras con el bot\xF3n \u{1F310}.", "Pick where to watch from. The first one is ready; you can choose another. Change it anytime later with the \u{1F310} button."],
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
  checking: ["Comprobando\u2026", "Checking\u2026"],
  liveNoServer: ["Este canal no responde ahora en ning\xFAn servidor. Int\xE9ntalo en unos minutos.", "This channel isn't answering on any server right now. Try again in a few minutes."]
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

// src/version.js
var PLUGIN_VERSION = "0.8.6";

// src/panels.js
var PANELS_KEY = "panels:v1";
var ACCT_KEY = "acct:v1";
var DAY = 24 * 60 * 60 * 1e3;
var DEAD_TTL_MS = DAY;
var KEEP_OFFLINE_MS = 7 * DAY;
var MIN_SHARED = 8;
var MIN_SHARE = 0.8;
var djb2 = (text2) => {
  let h = 5381;
  for (let i = 0; i < text2.length; i++) h = (h << 5) + h + text2.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
};
function keyOf(srv) {
  if (!srv || !srv.url) return "";
  return djb2(srv.url + "|" + srv.username);
}
var credOf = (srv) => djb2(String(srv.url) + "|" + srv.username + "|" + srv.password).slice(0, 6);
var fnv = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
var normName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function pairHashes(cats) {
  const out = /* @__PURE__ */ new Set();
  for (const c of Array.isArray(cats) ? cats : []) {
    const id = String(c && c.category_id || "");
    if (id) out.add(fnv(id + "|" + normName(c.category_name)));
  }
  return out;
}
function linked(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < MIN_SHARED) return false;
  let n = 0;
  for (const h of small) if (large.has(h)) n++;
  return n >= MIN_SHARED && n >= MIN_SHARE * small.size;
}
function groupPanels(sets, prev, now) {
  const prevG = prev && prev.g || {};
  const prevT = prev && prev.t || {};
  const keys = [...sets.keys()].filter((k) => sets.get(k).size >= MIN_SHARED).sort((a, b) => sets.get(b).size - sets.get(a).size || (a < b ? -1 : a > b ? 1 : 0));
  const groups = [];
  const unknown = /* @__PURE__ */ new Set();
  for (const k of keys) {
    const hits = groups.filter((gr) => linked(sets.get(k), sets.get(gr.anchor)));
    if (!hits.length) groups.push({ anchor: k, members: [k] });
    else if (hits.length === 1) hits[0].members.push(k);
    else unknown.add(k);
  }
  const g = {};
  const t = {};
  const used = /* @__PURE__ */ new Set();
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
function readPanels() {
  try {
    const o = JSON.parse(kino.storage.get(PANELS_KEY) || "null");
    return o && o.v === 1 && o.g && typeof o.g === "object" ? o : null;
  } catch (_) {
    return null;
  }
}
var writePanels = (map) => put(PANELS_KEY, JSON.stringify(map));
function panelOf(k, map = readPanels()) {
  return map && k && map.g[k] || null;
}
function membersOf(label, map = readPanels(), now = Date.now(), maxAgeMs = KEEP_OFFLINE_MS) {
  if (!map || !label) return [];
  return Object.keys(map.g).filter((k) => map.g[k] === label && now - (Number(map.t && map.t[k]) || 0) < maxAgeMs);
}
function readAcct() {
  try {
    const o = JSON.parse(kino.storage.get(ACCT_KEY) || "null");
    if (o && o.v === 1 && o.dead && o.blocked) return o;
  } catch (_) {
  }
  return { v: 1, dead: {}, blocked: {} };
}
function writeAcct(o, now) {
  for (const k of Object.keys(o.dead)) if (now - (Number(o.dead[k][0]) || 0) >= DEAD_TTL_MS) delete o.dead[k];
  for (const k of Object.keys(o.blocked)) if (o.blocked[k] !== PLUGIN_VERSION) delete o.blocked[k];
  put(ACCT_KEY, JSON.stringify(o));
}
function noteDead(srv, now = Date.now()) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  o.dead[k] = [now, credOf(srv)];
  writeAcct(o, now);
}
function noteBlocked(srv, now = Date.now()) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  if (o.blocked[k] === PLUGIN_VERSION) return;
  o.blocked[k] = PLUGIN_VERSION;
  writeAcct(o, now);
}
function noteAlive(srv) {
  const k = keyOf(srv);
  if (!k) return;
  const o = readAcct();
  if (!(k in o.dead) && !(k in o.blocked)) return;
  delete o.dead[k];
  delete o.blocked[k];
  put(ACCT_KEY, JSON.stringify(o));
}
function isDead(srv, now = Date.now()) {
  const d = readAcct().dead[keyOf(srv)];
  return !!d && d[1] === credOf(srv) && now - (Number(d[0]) || 0) < DEAD_TTL_MS;
}
var isBlocked = (srv) => readAcct().blocked[keyOf(srv)] === PLUGIN_VERSION;
var usable = (srv, now = Date.now()) => !!srv && !isBlocked(srv) && !isDead(srv, now);
function accountVerdict(data, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.user_info || typeof data.user_info !== "object") return null;
  const u = data.user_info;
  if (u.auth !== void 0 && String(u.auth) === "0") return "dead";
  if (/^(expired|banned|disabled)$/i.test(String(u.status || ""))) return "dead";
  const exp = Number(u.exp_date);
  if (u.exp_date !== null && u.exp_date !== void 0 && u.exp_date !== "" && Number.isFinite(exp) && exp > 0 && exp * 1e3 < now) return "dead";
  return null;
}

// src/channelMatch.js
var strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
var CODES = {
  es: "es",
  esp: "es",
  mx: "mx",
  mex: "mx",
  ar: "ar",
  arg: "ar",
  co: "co",
  col: "co",
  cl: "cl",
  pe: "pe",
  ve: "ve",
  ec: "ec",
  uy: "uy",
  py: "py",
  bo: "bo",
  cr: "cr",
  pa: "pa",
  gt: "gt",
  hn: "hn",
  sv: "sv",
  ni: "ni",
  do: "do",
  pr: "pr",
  cu: "cu",
  us: "us",
  usa: "us",
  ca: "ca",
  br: "br",
  pt: "pt",
  uk: "gb",
  gb: "gb",
  fr: "fr",
  de: "de",
  it: "it",
  nl: "nl",
  be: "be",
  ch: "ch",
  at: "at",
  pl: "pl",
  ro: "ro",
  tr: "tr",
  gr: "gr",
  al: "al",
  hr: "hr",
  rs: "rs",
  se: "se",
  no: "no",
  dk: "dk",
  fi: "fi",
  ie: "ie",
  au: "au",
  in: "in",
  pk: "pk",
  sa: "sa",
  ma: "ma",
  ru: "ru",
  bg: "bg",
  hu: "hu",
  cz: "cz"
};
var REGIONS = { lat: "lat", latam: "lat", latino: "lat", latinos: "lat", latina: "lat", int: "int", multi: "multi", en: "en" };
var NAMES = {
  argentina: "ar",
  brasil: "br",
  brazil: "br",
  bolivia: "bo",
  chile: "cl",
  colombia: "co",
  "costa rica": "cr",
  cuba: "cu",
  ecuador: "ec",
  "el salvador": "sv",
  guatemala: "gt",
  honduras: "hn",
  mexico: "mx",
  nicaragua: "ni",
  panama: "pa",
  paraguay: "py",
  peru: "pe",
  "puerto rico": "pr",
  "republica dominicana": "do",
  "r dominicana": "do",
  dominicana: "do",
  uruguay: "uy",
  venezuela: "ve",
  espana: "es",
  spain: "es",
  canada: "ca",
  usa: "us",
  "estados unidos": "us",
  france: "fr",
  francia: "fr",
  germany: "de",
  alemania: "de",
  deutschland: "de",
  italy: "it",
  italia: "it",
  portugal: "pt",
  uk: "gb",
  "reino unido": "gb",
  england: "gb",
  netherlands: "nl",
  holanda: "nl",
  marruecos: "ma",
  polonia: "pl",
  poland: "pl",
  rumania: "ro",
  romania: "ro",
  turquia: "tr",
  turkey: "tr",
  grecia: "gr",
  albania: "al",
  belgica: "be",
  suecia: "se"
};
var REGION_WORDS = { latino: "lat", latinos: "lat", latina: "lat", latinas: "lat", latam: "lat", latinoamerica: "lat" };
var isConcrete = (cc) => typeof cc === "string" && /^[a-z]{2}$/.test(cc) && cc !== "en";
var QUALITY = { "4k": "4k", uhd: "4k", "2160p": "4k", fhd: "fhd", "1080p": "fhd", "1080": "fhd", hd: "hd", "720p": "hd", "720": "hd", sd: "sd", "480p": "sd" };
var NOISE = /* @__PURE__ */ new Set(["hevc", "h265", "h264", "raw", "backup", "bk", "alt", "op1", "op2", "audio", "vip"]);
var EVENT_WORD = /^(eventos?|events?|ppv|jornadas?|partidos?|match(es)?|agenda)$/;
var PREFIX = /^\s*[┃|▎[(]?\s*([A-Za-z]{2,6})\s*(?:[┃|▎\])]|:|\s-\s|-)\s*/;
function normChannel(raw) {
  let s = strip(raw);
  let cc = "";
  const m = s.match(PREFIX);
  if (m) {
    const code = m[1].toLowerCase();
    if (CODES[code] || REGIONS[code]) {
      cc = CODES[code] || REGIONS[code];
      s = s.slice(m[0].length);
    }
  }
  s = s.toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  let q = "";
  const key = [];
  let event = false;
  for (const t of s.split(" ")) {
    if (!t) continue;
    if (QUALITY[t]) {
      if (!q) q = QUALITY[t];
      continue;
    }
    if (NOISE.has(t) || /^\d+fps$/.test(t)) continue;
    if (EVENT_WORD.test(t)) event = true;
    key.push(t);
  }
  return { cc, q, key: key.join(" "), event };
}
var MAX_TOK = 56;
function channelTok(raw) {
  const n = normChannel(raw);
  if (n.event || !n.key) return "";
  const tok = [isConcrete(n.cc) ? n.cc : "_", n.q || "_", ...n.key.split(" ")].join(".");
  return tok.length <= MAX_TOK ? tok : "";
}
function parseChannelTok(tok) {
  const p = String(tok || "").split(".");
  if (p.length < 3 || !/^[a-z0-9._]+$/.test(String(tok)) || !/^(_|[a-z]{2})$/.test(p[0]) || !/^(_|4k|fhd|hd|sd)$/.test(p[1])) return null;
  return { cc: p[0] === "_" ? "" : p[0], q: p[1] === "_" ? "" : p[1], key: p.slice(2).join(" ") };
}
var LADDER = { sd: 0, hd: 1, fhd: 2, "4k": 3 };
var NO_Q_ORDER = ["", "fhd", "hd", "4k", "sd"];
function matchChannel(tok, list) {
  const src = parseChannelTok(tok);
  if (!src || !src.key) return { why: "bad" };
  const cands = [];
  for (const s of Array.isArray(list) ? list : []) {
    const id = String(s && s.stream_id || "");
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
  const pool2 = cands.filter((c) => c.q === q);
  if (new Set(pool2.map((c) => c.id)).size > 1) return { why: "ambiguous" };
  return { id: pool2[0].id, name: pool2[0].name };
}
var STOP = /* @__PURE__ */ new Set(["general", "generales", "canales", "channels", "tv", "hd", "fhd", "sd", "uhd", "4k", "vip", "y", "and", "de", "del", "la", "el", "los", "las", "plus"]);
var CAT_EVENT = /^(eventos?|events?|ppv|jornadas?|partidos?|match(es)?|agenda|replays?)$/;
var stem = (t) => /[lrnd]es$/.test(t) && t.length > 5 ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
function normCategory(raw) {
  const s = strip(raw).toLowerCase().replace(/la\s+liga/g, "laliga").replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  const toks = s.split(" ").filter(Boolean);
  let cc = "";
  let event = false;
  const topic = /* @__PURE__ */ new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i === 0 && (CODES[t] || REGIONS[t])) {
      cc = CODES[t] || REGIONS[t];
      continue;
    }
    const two = i + 1 < toks.length ? t + " " + toks[i + 1] : "";
    if (two && NAMES[two]) {
      if (!cc) cc = NAMES[two];
      i++;
      continue;
    }
    if (NAMES[t]) {
      if (!cc) cc = NAMES[t];
      continue;
    }
    if (REGION_WORDS[t]) {
      if (!cc) cc = REGION_WORDS[t];
      continue;
    }
    if (CAT_EVENT.test(t)) event = true;
    if (STOP.has(t)) continue;
    topic.add(stem(t));
  }
  return { cc, topic, event };
}
var MAX_CAT_TOK = 32;
var EVENT_STEMS = /* @__PURE__ */ new Set(["evento", "event", "ppv", "jornada", "partido", "match", "matche", "agenda", "replay"]);
function categoryTok(raw) {
  const n = normCategory(raw);
  const tok = [n.cc && /^[a-z]{2,5}$/.test(n.cc) ? n.cc : "_", ...[...n.topic].sort()].join(".");
  return tok.length <= MAX_CAT_TOK && /^[a-z0-9._]+$/.test(tok) ? tok : "";
}
function parseCategoryTok(tok) {
  const t = String(tok || "");
  if (!t || !/^[a-z0-9._]+$/.test(t)) return null;
  const p = t.split(".");
  const topic = new Set(p.slice(1).filter(Boolean));
  return { cc: p[0] === "_" ? "" : p[0], topic, event: [...topic].some((w) => EVENT_STEMS.has(w)) };
}
var sameCategory = (tok, name) => !!tok && categoryTok(name) === tok;
function matchCategory(tok, list) {
  const src = parseCategoryTok(tok);
  if (!src || src.event || !isConcrete(src.cc)) return null;
  let best = null;
  for (const c of Array.isArray(list) ? list : []) {
    const id = String(c && c.category_id || "");
    if (!id) continue;
    const n = normCategory(c.category_name);
    if (n.event || n.cc !== src.cc) continue;
    let inter = 0;
    for (const t of src.topic) if (n.topic.has(t)) inter++;
    const uni = (/* @__PURE__ */ new Set([...src.topic, ...n.topic])).size;
    const score = uni ? inter / uni : 1;
    if (score >= 0.6 && (!best || score > best.score)) best = { id, name: String(c.category_name || ""), score };
  }
  return best;
}

// src/liveFailover.js
var CHAIN_GAP_MS = 45e3;
var STICKY_MS = 6e5;
var REFUSED_MS = 6e5;
var VERIFIED_MS = 24 * 60 * 60 * 1e3;
var NAME_MS = 30 * 60 * 1e3;
var LIST_MS = 10 * 60 * 1e3;
var CATS_FRESH_MS = 10 * 60 * 1e3;
var DEADLINE_MS = 1e4;
var MAX_PER_RESOLVE = 6;
var MAX_PER_CHANNEL = 12;
var STICKY_KEY = "live:v1";
var UA = "Mozilla/5.0 (compatible; VegetaTVCache/2.0)";
function parseLiveRef(ref) {
  const s = String(ref || "");
  if (!s.startsWith("live:")) return null;
  const segs = s.slice(5).split("~");
  if (!/^\d+$/.test(segs[0])) return null;
  if (segs.length >= 4 && /^\d+$/.test(segs[1])) return { id: segs[0], catId: segs[1], catTok: segs[2], tok: segs[3], bare: false };
  return { id: segs[0], catId: "", catTok: "", tok: "", bare: true };
}
var liveRef = (id, catId, catTok, tok) => /^\d+$/.test(String(catId || "")) ? `live:${id}~${catId}~${catTok || ""}~${tok || ""}` : `live:${id}`;
var hostnameOf = (srv) => {
  try {
    return new URL(srv.url).hostname;
  } catch (_) {
    return "";
  }
};
var REFUSAL_IN_MESSAGE = /\b(401|403|406|407|429|509)\b|HTTP_PROXY_AUTH/i;
function classifyProbe(res, err) {
  if (err) {
    if (err.code === "host_not_allowed") return "blocked";
    if (err.code === "rate_limited") return "limited";
    return REFUSAL_IN_MESSAGE.test(String(err.message || "")) ? "refused" : "unreachable";
  }
  const st = Number(res && res.status) || 0;
  if (st >= 300 && st < 400) return res.headers && res.headers.location ? "accepted" : "dead";
  if (st >= 200 && st < 300) {
    let body = "";
    try {
      body = String(res.text() || "");
    } catch (_) {
      body = "";
    }
    return /^\s*#EXTM3U/.test(body) && /#EXTINF|#EXT-X-STREAM-INF/.test(body) ? "ok" : "dead";
  }
  if (st === 404 || st === 400 || st === 410) return "missing";
  return "refused";
}
var isGood = (v) => v === "ok" || v === "accepted";
var isBad = (v) => v === "refused" || v === "dead" || v === "missing" || v === "blocked";
function createLiveFailover(deps) {
  const now = () => deps.now();
  const plays = /* @__PURE__ */ new Map();
  let lastLive = null;
  const refused = /* @__PURE__ */ new Map();
  const preferred = /* @__PURE__ */ new Map();
  const verified = /* @__PURE__ */ new Map();
  const nameHits = /* @__PURE__ */ new Map();
  const negName = /* @__PURE__ */ new Map();
  const lists = /* @__PURE__ */ new Map();
  const catsMemo = /* @__PURE__ */ new Map();
  const refreshed = /* @__PURE__ */ new Map();
  const fresh = (ts, ms) => typeof ts === "number" && now() - ts < ms;
  const trim = (map, max) => {
    while (map.size > max) map.delete(map.keys().next().value);
  };
  const isRefused = (k) => fresh(refused.get(k), REFUSED_MS);
  const isBadFor = (st, k) => fresh(st.bad.get(k), REFUSED_MS);
  const isLabel = (p) => !!p && !/^[kc]:/.test(p);
  function rankWith(active) {
    const online = deps.online();
    const aflag = deps.flag(active);
    const seed = String(deps.seed());
    const tie = (s) => {
      let h = 2166136261;
      const t = seed + keyOf(s);
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    return (a, b) => {
      const oa = online ? online.has(a.url) ? 0 : 1 : 0;
      const ob = online ? online.has(b.url) ? 0 : 1 : 0;
      if (oa !== ob) return oa - ob;
      const fa = deps.flag(a) === aflag ? 0 : 1;
      const fb = deps.flag(b) === aflag ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return deps.priority(a) - deps.priority(b) || tie(a) - tie(b);
    };
  }
  const room = (ctx, needMs) => ctx.left > 0 && ctx.st.spent.length < MAX_PER_CHANNEL && ctx.until - now() >= needMs;
  function spend(ctx) {
    ctx.left--;
    ctx.st.spent.push(now());
  }
  async function probe(ctx, srv, id) {
    if (!room(ctx, 1500)) return "skipped";
    spend(ctx);
    const k = keyOf(srv);
    let v;
    try {
      const res = await kino.fetch(deps.playUrl(srv, id, "m3u8"), {
        redirect: "manual",
        cookies: false,
        maxBytes: 2048,
        timeoutMs: Math.max(1e3, Math.min(4e3, ctx.until - now() - 500)),
        headers: { "User-Agent": UA, "Accept": "*/*" }
      });
      v = classifyProbe(res, null);
    } catch (e) {
      v = classifyProbe(null, e);
      if (v === "blocked" && e && e.host && e.host !== hostnameOf(srv)) v = "unreachable";
    }
    if (v === "blocked") noteBlocked(srv);
    if (v === "refused" || v === "dead") refused.set(k, now());
    if (v === "limited") ctx.left = 0;
    ctx.probes.push(v);
    return v;
  }
  async function call(ctx, srv, action3, extra) {
    if (!room(ctx, 2500)) return null;
    spend(ctx);
    try {
      return await deps.callServer(srv, action3, extra || {}, { timeoutMs: Math.max(1e3, Math.min(5e3, ctx.until - now() - 1500)) });
    } catch (e) {
      if (e && e.code === "rate_limited") ctx.left = 0;
      return null;
    }
  }
  async function listOf(ctx, srv, catId) {
    const key = keyOf(srv) + "|" + catId;
    const m = lists.get(key);
    if (m && fresh(m.ts, LIST_MS)) return m.list;
    let data = typeof deps.cachedList === "function" ? deps.cachedList(srv, catId) : null;
    if (!Array.isArray(data)) {
      data = await call(ctx, srv, "get_live_streams", { category_id: String(catId) });
      if (Array.isArray(data) && typeof deps.keepList === "function") deps.keepList(srv, catId, data);
    }
    if (!Array.isArray(data)) return null;
    const list = data.map((s) => ({ stream_id: String(s && s.stream_id || ""), name: String(s && s.name || "") }));
    lists.delete(key);
    lists.set(key, { ts: now(), list });
    trim(lists, 8);
    return list;
  }
  const catsFrom = (data) => data.map((c) => ({ category_id: String(c && c.category_id || ""), category_name: String(c && c.category_name || "") }));
  function memoCats(k, cats) {
    catsMemo.delete(k);
    catsMemo.set(k, { ts: now(), cats });
    trim(catsMemo, 4);
  }
  async function catsOf(ctx, srv) {
    const k = keyOf(srv);
    const m = catsMemo.get(k);
    if (m && fresh(m.ts, NAME_MS)) return m.cats;
    let cats = deps.cachedCats(srv);
    if (!cats) {
      const data = await call(ctx, srv, "get_live_categories", {});
      if (!Array.isArray(data)) return null;
      cats = catsFrom(data);
    }
    memoCats(k, cats);
    return cats;
  }
  async function refreshCats(ctx, srv) {
    const k = keyOf(srv);
    const at = deps.catsAt(srv);
    if (typeof at === "number" && now() - at < CATS_FRESH_MS) return null;
    if (fresh(refreshed.get(k), CATS_FRESH_MS)) return null;
    if (!room(ctx, 2500)) return null;
    refreshed.set(k, now());
    trim(refreshed, 16);
    const data = await call(ctx, srv, "get_live_categories", {});
    if (!Array.isArray(data) || !data.length) return null;
    deps.storeCats(srv, data);
    const cats = catsFrom(data);
    memoCats(k, cats);
    return cats;
  }
  async function byName(ctx, srv, r) {
    if (!r.tok || !r.catTok) return null;
    const neg = keyOf(srv) + "|" + r.catTok + "|" + r.tok;
    if (fresh(negName.get(neg), NAME_MS)) return null;
    const cats = await catsOf(ctx, srv);
    if (!cats) return null;
    const c = matchCategory(r.catTok, cats);
    const list = c ? await listOf(ctx, srv, c.id) : null;
    if (c && !list) return null;
    const m = c ? matchChannel(r.tok, list) : { why: "none" };
    if (!m.id) {
      negName.set(neg, now());
      trim(negName, 32);
      return null;
    }
    return { id: m.id, catId: c.id, catName: c.name };
  }
  async function verify(ctx, srv, r, P) {
    const vk = keyOf(srv) + "|" + P;
    if (fresh(verified.get(vk), VERIFIED_MS)) return true;
    const list = await listOf(ctx, srv, r.catId);
    if (!list) return null;
    const entry = list.find((s) => s.stream_id === r.id);
    if (!entry || r.tok && !matchChannel(r.tok, [entry]).id) return false;
    verified.set(vk, now());
    trim(verified, 64);
    return true;
  }
  const named = (r) => !!r.catTok && r.catTok !== "_";
  function listsCategory(cats, r) {
    const c = cats && cats.find((x) => String(x.category_id) === r.catId);
    return !!c && (!named(r) || sameCategory(r.catTok, c.category_name));
  }
  async function originOf(ctx, r, active, list, map) {
    const own = deps.cachedCats(active);
    if (!own || listsCategory(own, r)) return { srv: active };
    const ap = panelOf(keyOf(active), map);
    let sure = false;
    if (named(r)) {
      for (const s of list) {
        if (s === active || !listsCategory(deps.cachedCats(s), r)) continue;
        if (usable(s, now())) return { srv: s };
        const sp = panelOf(keyOf(s), map);
        if (sp && ap && sp === ap) return { srv: active };
        if (sp && ap) sure = true;
      }
    }
    if (listsCategory(await refreshCats(ctx, active), r)) return { srv: active };
    return { foreign: true, sure };
  }
  function chainState(pkey, t0) {
    const prev = lastLive;
    lastLive = { key: pkey, at: t0 };
    let st = plays.get(pkey);
    if (st) plays.delete(pkey);
    else {
      st = { count: 0, moved: null, tried: /* @__PURE__ */ new Set(), triedPanels: /* @__PURE__ */ new Set(), spent: [], bad: /* @__PURE__ */ new Map() };
      try {
        const o = JSON.parse(kino.storage.get(STICKY_KEY) || "null");
        if (o && o.p === pkey && fresh(o.at, STICKY_MS)) st.moved = { k: o.k, id: o.id, a: o.a, at: o.at };
      } catch (_) {
      }
    }
    plays.set(pkey, st);
    trim(plays, 64);
    const chained = !!prev && prev.key === pkey && t0 - prev.at <= CHAIN_GAP_MS;
    st.count = chained ? st.count + 1 : 1;
    if (!chained) {
      st.tried.clear();
      st.triedPanels.clear();
    }
    st.spent = st.spent.filter((ts) => t0 - ts < STICKY_MS);
    return st;
  }
  function startAccount(st, P, origin, active, byKey, map, rank, r) {
    const ok = (s) => !!s && usable(s, now()) && !isRefused(keyOf(s)) && !isBadFor(st, keyOf(s));
    const ak = keyOf(active);
    const inP = (s) => {
      const k = keyOf(s);
      return P === "k:" + k || isLabel(P) && panelOf(k, map) === P;
    };
    if (ok(active) && (origin === active || inP(active))) return { srv: active, id: r.id };
    if (ok(origin)) return { srv: origin, id: r.id };
    const pref = preferred.get(P);
    if (pref && fresh(pref.ts, REFUSED_MS) && ok(byKey.get(pref.k))) return { srv: byKey.get(pref.k), id: r.id };
    if (isLabel(P)) {
      const sure = membersOf(P, map, now(), VERIFIED_MS).filter((k) => k !== ak && fresh(verified.get(k + "|" + P), VERIFIED_MS)).map((k) => byKey.get(k)).filter(ok).sort(rank);
      if (sure.length) return { srv: sure[0], id: r.id };
    }
    return null;
  }
  async function failover2(ctx, st, P, r, active, byKey, map, rank, pkey, blamed) {
    if (isLabel(P)) {
      const cands = membersOf(P, map, now(), VERIFIED_MS).map((k) => byKey.get(k)).filter((s) => s && !st.tried.has(keyOf(s)) && usable(s, now()) && !isRefused(keyOf(s)) && !isBadFor(st, keyOf(s))).sort(rank).slice(0, 2);
      if (cands.length) {
        const results = await Promise.all(cands.map(async (s) => {
          const ok = await verify(ctx, s, r, P);
          return ok ? probe(ctx, s, r.id) : ok === null ? "skipped" : "unverified";
        }));
        for (let i = 0; i < cands.length; i++) {
          if (results[i] !== "skipped") st.tried.add(keyOf(cands[i]));
          if (isGood(results[i])) {
            if (blamed) preferred.set(P, { k: keyOf(cands[i]), ts: now() });
            return { srv: cands[i], id: r.id };
          }
        }
        return null;
      }
    }
    if (!r.tok || !r.catTok) return null;
    const hit = nameHits.get(pkey);
    const foreign = (s) => {
      const k = keyOf(s);
      if (st.tried.has(k) || !usable(s, now()) || isRefused(k) || isBadFor(st, k) || P === "k:" + k) return false;
      const pl = panelOf(k, map);
      return !(isLabel(P) && pl === P) && !(pl && st.triedPanels.has(pl));
    };
    let target = hit && fresh(hit.ts, NAME_MS) && byKey.get(hit.k) && foreign(byKey.get(hit.k)) ? byKey.get(hit.k) : null;
    if (!target) target = [...byKey.values()].filter(foreign).sort((a, b) => a === active ? -1 : b === active ? 1 : rank(a, b))[0];
    if (!target) return null;
    const tk = keyOf(target);
    st.tried.add(tk);
    st.triedPanels.add(panelOf(tk, map) || "k:" + tk);
    const m = hit && hit.k === tk && fresh(hit.ts, NAME_MS) ? hit : await byName(ctx, target, r);
    if (!m) return null;
    const v = await probe(ctx, target, m.id);
    if (!isGood(v)) return null;
    nameHits.set(pkey, { k: tk, id: m.id, catId: m.catId, catName: m.catName, ts: now() });
    trim(nameHits, 64);
    return { srv: target, id: m.id };
  }
  function alternatives(P, played, r, pkey, byKey, map, rank) {
    const out = [];
    const seen = /* @__PURE__ */ new Set([keyOf(played.srv)]);
    const add = (s, id) => {
      const k = keyOf(s);
      if (s && !seen.has(k)) {
        seen.add(k);
        out.push({ s, id });
      }
    };
    const online = deps.online();
    if (isLabel(P)) {
      membersOf(P, map, now()).map((k) => byKey.get(k)).filter((s) => s && usable(s, now()) && (!online || online.has(s.url))).sort(rank).forEach((s) => add(s, r.id));
    } else if (P.startsWith("k:") && keyOf(played.srv) !== P.slice(2)) add(byKey.get(P.slice(2)), r.id);
    const hit = nameHits.get(pkey);
    if (hit && fresh(hit.ts, NAME_MS) && byKey.get(hit.k) && usable(byKey.get(hit.k), now())) add(byKey.get(hit.k), hit.id);
    const countBy = {};
    for (const e of out) {
      const b = deps.label(e.s);
      countBy[b] = (countBy[b] || 0) + 1;
    }
    if (countBy[deps.label(played.srv)]) countBy[deps.label(played.srv)]++;
    return out.slice(0, 8).map((e) => {
      const b = deps.label(e.s);
      return { label: countBy[b] > 1 && deps.host(e.s) ? `${b} \xB7 ${deps.host(e.s)}` : b, ref: `at:${keyOf(e.s)}~l~${e.id}` };
    });
  }
  function answer(st, c, P, r, pkey, byKey, map, rank, movedFrom) {
    if (movedFrom) {
      st.moved = { k: keyOf(c.srv), id: c.id, a: movedFrom, at: now() };
      st.count = 1;
      put(STICKY_KEY, JSON.stringify({ p: pkey, ...st.moved }));
    }
    const out = { url: deps.playUrl(c.srv, c.id) };
    const alts = alternatives(P, c, r, pkey, byKey, map, rank);
    if (alts.length) {
      out.alternatives = alts;
      out.label = deps.label(c.srv);
    }
    return out;
  }
  async function resolve3(ref) {
    const t0 = now();
    let r = parseLiveRef(ref);
    if (!r) throw deps.notFound();
    const { list, idx } = await deps.servers();
    if (!Array.isArray(list) || !list.length) throw deps.unavailable();
    const active = list[idx] || list[0];
    const byKey = new Map(list.map((s) => [keyOf(s), s]));
    const map = readPanels();
    const rank = rankWith(active);
    const ctx = { left: MAX_PER_RESOLVE, until: t0 + DEADLINE_MS, probes: [], st: { spent: [] } };
    if (r.bare) {
      const P2 = panelOf(keyOf(active), map) || "k:" + keyOf(active);
      const st2 = chainState(P2 + "|" + r.id, t0);
      return answer(st2, { srv: active, id: r.id }, P2, r, P2 + "|" + r.id, byKey, map, rank, null);
    }
    let where = await originOf(ctx, r, active, list, map);
    if (where.foreign) {
      const fk = "f|" + keyOf(active) + "|" + r.catId + "|" + r.id;
      const hit = nameHits.get(fk);
      const m = hit && fresh(hit.ts, NAME_MS) ? hit : await byName(ctx, active, r);
      if (m) {
        nameHits.set(fk, { ...m, k: keyOf(active), ts: hit && hit.ts ? hit.ts : now() });
        r = { id: m.id, catId: m.catId, catTok: categoryTok(m.catName), tok: r.tok, bare: false };
      } else if (where.sure) throw deps.notFound();
      where = { srv: active };
    }
    const origin = where.srv;
    const ok = keyOf(origin);
    const P = panelOf(ok, map) || "k:" + ok;
    const pkey = P + "|" + r.id;
    const st = chainState(pkey, t0);
    st.spent.push(...ctx.st.spent);
    ctx.st = st;
    const sticky = st.moved && st.moved.a === keyOf(active) && fresh(st.moved.at, STICKY_MS) ? byKey.get(st.moved.k) : null;
    let cur = sticky && usable(sticky, now()) && !isRefused(st.moved.k) && !isBadFor(st, st.moved.k) ? { srv: sticky, id: st.moved.id } : null;
    if (!cur) cur = startAccount(st, P, origin, active, byKey, map, rank, r);
    if (!cur && usable(origin, now()) && !st.tried.has(ok)) cur = { srv: origin, id: r.id, recheck: true };
    const R = st.count;
    let curBad = !cur;
    let blamed = !cur && isRefused(ok);
    if (cur) {
      if (R === 1 && !cur.recheck) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
      if (R <= 2) {
        const v = await probe(ctx, cur.srv, cur.id);
        if (!isBad(v)) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
        curBad = true;
        blamed = v === "refused" || v === "dead";
      } else {
        st.bad.set(keyOf(cur.srv), now());
        trim(st.bad, 32);
      }
      st.tried.add(keyOf(cur.srv));
    }
    const next = await failover2(ctx, st, P, r, active, byKey, map, rank, pkey, blamed);
    if (next) return answer(st, next, P, r, pkey, byKey, map, rank, keyOf(active));
    if (curBad && ctx.probes.length && ctx.probes.every(isBad)) throw deps.unavailable();
    if (R >= 3) {
      st.tried.clear();
      st.triedPanels.clear();
      const again = startAccount(st, P, origin, active, byKey, map, rank, r);
      if (again) return answer(st, again, P, r, pkey, byKey, map, rank, null);
    }
    if (cur) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
    throw deps.unavailable();
  }
  return { resolve: resolve3 };
}

// src/channelTitle.js
var PANEL_BAR_CHARS = "\u2503\u2502\u258E\u258D\u258C\u258F\u2595\u2590\u2016\u254E\u254F\u2506\u2507\u250A\u250B\u2758\u2759";
var BAR_CHARS = "|\xA6\u2223\uFF5C" + PANEL_BAR_CHARS;
var BAR = "[" + BAR_CHARS + "]";
var PANEL_BAR = new RegExp("[" + PANEL_BAR_CHARS + "]");
var OPEN = "(?:" + BAR + "|\\[|\\(|!)";
var CLOSE = "(?:" + BAR + "|\\]|\\)|!)";
var TOK = "[A-Z0-9]{2,6}";
var BRACKET_TOKS = TOK + "(?:\\s*[/,+&-]\\s*" + TOK + ")*";
var SEP_TOKS = TOK + "(?:\\s*[/,]\\s*" + TOK + ")*";
var SEP = "(?:\\s*" + BAR + "+\\s*|\\s*:\\s*|\\s*[\u2022\xB7\u25CF\u25AA\u25BA\xBB\u27A4]\\s*|\\s+[-\u2013\u2014]+\\s*|[-\u2013\u2014]+\\s+)";
var LEAD_BRACKET = new RegExp("^\\s*" + OPEN + "\\s*(" + BRACKET_TOKS + ")\\s*" + CLOSE + "\\s*");
var LEAD_SEP = new RegExp("^\\s*(" + SEP_TOKS + ")" + SEP);
var TRAIL_BRACKET = new RegExp("\\s*" + OPEN + "\\s*(" + BRACKET_TOKS + ")\\s*" + CLOSE + "\\s*$");
var TRAIL_SEP = new RegExp("\\s*" + BAR + "+\\s*(" + SEP_TOKS + ")\\s*$");
var MID_BRACKET = new RegExp("\\s*" + BAR + "\\s*(" + BRACKET_TOKS + ")\\s*" + BAR + "\\s*", "g");
var BARS_LEFT = new RegExp("\\s*" + BAR + "+\\s*", "g");
var MAYBE_DECORATED = new RegExp("[" + BAR_CHARS + "\\[\\]()!:\u2022\xB7\u25CF\u25AA\u25BA\xBB\u27A4\u2013\u2014-]");
var JUNK = "[\\s" + BAR_CHARS + "\xB7\u2022\u25CF\u25AA\u25BA\xBB\u27A4:\u2013\u2014-]+";
var LEAD_JUNK = new RegExp("^" + JUNK);
var TRAIL_JUNK = new RegExp(JUNK + "$");
var HAS_TEXT = /[\p{L}\p{N}]/u;
var GROUP = /^[A-Z][A-Z0-9]{1,5}$/;
var NOT_GROUP = /* @__PURE__ */ new Set(["TV"]);
var TWO_LETTERS = /\p{L}{2}/u;
var OPENS_WRAP = new RegExp("^\\s*" + TOK + "\\s*" + BAR);
var COUNTRY = {
  es: "es",
  esp: "es",
  mx: "mx",
  mex: "mx",
  ar: "ar",
  arg: "ar",
  co: "co",
  col: "co",
  cl: "cl",
  pe: "pe",
  ve: "ve",
  ven: "ve",
  ec: "ec",
  ecu: "ec",
  uy: "uy",
  uru: "uy",
  py: "py",
  bo: "bo",
  cr: "cr",
  pa: "pa",
  gt: "gt",
  hn: "hn",
  sv: "sv",
  ni: "ni",
  do: "do",
  pr: "pr",
  cu: "cu",
  us: "us",
  usa: "us",
  ca: "ca",
  br: "br",
  bra: "br",
  pt: "pt",
  uk: "gb",
  gb: "gb",
  ie: "ie",
  sc: "sc",
  fr: "fr",
  fra: "fr",
  de: "de",
  ger: "de",
  it: "it",
  ita: "it",
  nl: "nl",
  be: "be",
  ch: "ch",
  at: "at",
  pl: "pl",
  ro: "ro",
  tr: "tr",
  tur: "tr",
  gr: "gr",
  al: "al",
  alb: "al",
  hr: "hr",
  rs: "rs",
  srb: "rs",
  se: "se",
  no: "no",
  dk: "dk",
  fi: "fi",
  au: "au",
  nz: "nz",
  in: "in",
  pk: "pk",
  sa: "sa",
  ksa: "sa",
  ma: "ma",
  ru: "ru",
  rus: "ru",
  bg: "bg",
  hu: "hu",
  cz: "cz",
  il: "il",
  ua: "ua",
  lu: "lu",
  jp: "jp",
  kr: "kr",
  cn: "cn",
  // the ex-Yugoslav panels' own spellings ("ARENA SPORT 1 HD (SR)", "(SL)", "(BIH)")
  sr: "rs",
  sl: "si",
  slo: "si",
  bih: "ba",
  ba: "ba",
  mkd: "mk",
  mk: "mk",
  mne: "me"
};
var REGION = {
  lat: "lat",
  latam: "lat",
  latino: "lat",
  latin: "lat",
  int: "int",
  multi: "multi",
  en: "en",
  eng: "en",
  exyu: "exyu",
  asia: "asia",
  afr: "afr",
  vip: "vip",
  ppv: "ppv"
};
var QUALITY2 = { "4k": "4K", "8k": "8K", uhd: "UHD", fhd: "FHD", hd: "HD", sd: "SD", hevc: "HEVC" };
var LABELS = {
  es: ["Espa\xF1a", "Spain"],
  mx: ["M\xE9xico", "Mexico"],
  ar: ["AR", "AR"],
  co: ["Colombia", "Colombia"],
  cl: ["Chile", "Chile"],
  pe: ["Per\xFA", "Peru"],
  ve: ["Venezuela", "Venezuela"],
  ec: ["Ecuador", "Ecuador"],
  uy: ["Uruguay", "Uruguay"],
  py: ["Paraguay", "Paraguay"],
  bo: ["Bolivia", "Bolivia"],
  cr: ["Costa Rica", "Costa Rica"],
  pa: ["Panam\xE1", "Panama"],
  gt: ["Guatemala", "Guatemala"],
  hn: ["Honduras", "Honduras"],
  sv: ["El Salvador", "El Salvador"],
  ni: ["Nicaragua", "Nicaragua"],
  do: ["Rep. Dominicana", "Dominican Rep."],
  pr: ["Puerto Rico", "Puerto Rico"],
  cu: ["Cuba", "Cuba"],
  us: ["EE. UU.", "USA"],
  ca: ["Canad\xE1", "Canada"],
  br: ["Brasil", "Brazil"],
  pt: ["Portugal", "Portugal"],
  gb: ["Reino Unido", "UK"],
  ie: ["Irlanda", "Ireland"],
  sc: ["Escocia", "Scotland"],
  fr: ["Francia", "France"],
  de: ["Alemania", "Germany"],
  it: ["Italia", "Italy"],
  nl: ["Pa\xEDses Bajos", "Netherlands"],
  be: ["B\xE9lgica", "Belgium"],
  ch: ["Suiza", "Switzerland"],
  at: ["Austria", "Austria"],
  pl: ["Polonia", "Poland"],
  ro: ["Rumania", "Romania"],
  tr: ["Turqu\xEDa", "Turkey"],
  gr: ["Grecia", "Greece"],
  al: ["Albania", "Albania"],
  hr: ["Croacia", "Croatia"],
  rs: ["Serbia", "Serbia"],
  se: ["Suecia", "Sweden"],
  no: ["Noruega", "Norway"],
  dk: ["Dinamarca", "Denmark"],
  fi: ["Finlandia", "Finland"],
  au: ["Australia", "Australia"],
  nz: ["Nueva Zelanda", "New Zealand"],
  in: ["India", "India"],
  pk: ["Pakist\xE1n", "Pakistan"],
  sa: ["Arabia Saudita", "Saudi Arabia"],
  ma: ["Marruecos", "Morocco"],
  ru: ["Rusia", "Russia"],
  bg: ["Bulgaria", "Bulgaria"],
  hu: ["Hungr\xEDa", "Hungary"],
  cz: ["Chequia", "Czechia"],
  il: ["Israel", "Israel"],
  ua: ["Ucrania", "Ukraine"],
  lu: ["Luxemburgo", "Luxembourg"],
  jp: ["Jap\xF3n", "Japan"],
  kr: ["Corea", "Korea"],
  cn: ["China", "China"],
  si: ["Eslovenia", "Slovenia"],
  ba: ["Bosnia", "Bosnia"],
  mk: ["Macedonia del Norte", "North Macedonia"],
  me: ["Montenegro", "Montenegro"],
  lat: ["Latino", "Latin"],
  int: ["Internacional", "International"],
  multi: ["Multi", "Multi"],
  en: ["Ingl\xE9s", "English"],
  exyu: ["Ex-Yu", "Ex-Yu"],
  asia: ["Asia", "Asia"],
  afr: ["\xC1frica", "Africa"],
  vip: ["VIP", "VIP"],
  ppv: ["PPV", "PPV"]
};
var labelOf = (key, lang) => {
  if (String(key).startsWith("=")) return String(key).slice(1);
  const l = LABELS[key];
  return l ? l[lang === "en" ? 1 : 0] : String(key).toUpperCase();
};
var NAME_SEP = "(?:\\s*" + BAR + "+\\s*|\\s*:\\s*|\\s*[\u2022\xB7\u25CF\u25AA\u25BA\xBB\u27A4]\\s*)";
var LEAD_NAME = new RegExp("^\\s*(?:" + OPEN + "\\s*([\\p{L} .'\u2019]{3,24}?)\\s*" + CLOSE + "\\s*|([\\p{L} .'\u2019]{3,24}?)" + NAME_SEP + ")", "u");
var fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
var COUNTRY_NAME = /* @__PURE__ */ new Map();
for (const [k, names] of Object.entries(LABELS)) if (k.length === 2) {
  for (const n of names) if (n.length > 3) COUNTRY_NAME.set(fold(n), k);
}
for (const [n, k] of [
  ["espana", "es"],
  ["argentina", "ar"],
  ["estados unidos", "us"],
  ["republica dominicana", "do"],
  ["dominicana", "do"],
  ["inglaterra", "gb"],
  ["england", "gb"],
  ["united kingdom", "gb"],
  ["portugal", "pt"]
]) COUNTRY_NAME.set(n, k);
var LATIN_TWO = /\p{Script=Latin}{2}/u;
var countryNamed = (text2) => COUNTRY_NAME.get(fold(text2)) || null;
var startsWithCountry = (rest) => {
  const words = fold(rest).split(" ");
  for (let n = Math.min(3, words.length); n >= 1; n--) if (COUNTRY_NAME.has(words.slice(0, n).join(" "))) return true;
  return false;
};
var ENTITY = /&(amp|quot|apos|lt|gt|nbsp|#\d{1,6}|#x[0-9a-f]{1,5});/gi;
var NAMED = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function decodeEntities(text2) {
  let s = text2;
  for (let i = 0; i < 3 && /&(?:[a-z]+|#x?[0-9a-f]+);/i.test(s); i++) {
    s = s.replace(ENTITY, (all, e) => {
      const k = e.toLowerCase();
      if (NAMED[k] != null) return NAMED[k];
      const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 31 && n < 1114112 && !(n >= 55296 && n <= 57343) ? String.fromCodePoint(n) : all;
    });
  }
  return s;
}
var normName2 = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
function codesOf(text2) {
  const marks = [];
  const quality = [];
  for (const t of String(text2).split(/[\s/,+&-]+/)) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (COUNTRY[k]) marks.push(COUNTRY[k]);
    else if (REGION[k]) marks.push(REGION[k]);
    else if (QUALITY2[k]) quality.push(QUALITY2[k]);
    else return null;
  }
  return marks.length || quality.length ? { marks, quality } : null;
}
var hasWord2 = (s, w) => (" " + s.toUpperCase().replace(/[^A-Z0-9]+/g, " ") + " ").includes(" " + w + " ");
var MEMO_MAX = 2e4;
var memo = /* @__PURE__ */ new Map();
function cleanChannelTitle(raw) {
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
  const take = (codes) => {
    marks.push(...codes.marks);
    quality.push(...codes.quality);
  };
  const trimmed = (t, re) => {
    const x = t.replace(re, "");
    return HAS_TEXT.test(x) ? x : t;
  };
  for (let i = 0; i < 6; i++) {
    const m = s.match(LEAD_BRACKET) || (s = trimmed(s, LEAD_JUNK)).match(LEAD_SEP);
    const codes = m && codesOf(m[1]);
    const rest = m ? s.slice(m[0].length) : "";
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
    if (m && !codes && PANEL_BAR.test(m[0]) && GROUP.test(m[1]) && !NOT_GROUP.has(m[1]) && TWO_LETTERS.test(rest) && !OPENS_WRAP.test(rest) && !codesOf(rest.replace(TRAIL_JUNK, ""))) {
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
  s = s.replace(MID_BRACKET, (all, text2, at, whole) => {
    const codes = codesOf(text2);
    if (!codes || !HAS_TEXT.test(whole.slice(0, at)) || !HAS_TEXT.test(whole.slice(at + all.length))) return all;
    take(codes);
    return " ";
  });
  s = trimmed(trimmed(s.replace(BARS_LEFT, " \xB7 "), LEAD_JUNK), TRAIL_JUNK).replace(/\s+/g, " ").trim();
  for (const q of quality) if (!hasWord2(s, q)) s += " " + q;
  if (!HAS_TEXT.test(s)) return { title: original, marks: [] };
  return { title: s, marks: [...new Set(marks)] };
}
function channelTitles(names, { cat = "", lang = "es" } = {}) {
  const list = Array.isArray(names) ? names : [];
  const parsed = list.map(cleanChannelTitle);
  const out = parsed.map((p) => p.title);
  const groups = /* @__PURE__ */ new Map();
  parsed.forEach((p, i) => {
    const k = normName2(p.title);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  });
  const own = String(cat || "").toLowerCase();
  for (const g of groups.values()) {
    if (g.length < 2 || new Set(g.map((i) => normName2(list[i]))).size < 2) continue;
    const common = new Set(parsed[g[0]].marks.filter((k) => g.every((i) => parsed[i].marks.includes(k))));
    const extra = (i) => parsed[i].marks.filter((k) => k !== own && !common.has(k));
    if (new Set(g.map((i) => extra(i).join("+"))).size < 2) continue;
    for (const i of g) {
      const e = extra(i);
      if (e.length) out[i] = parsed[i].title + " \xB7 " + e.map((k) => labelOf(k, lang)).join(" \xB7 ");
    }
  }
  return out;
}
var categoryKey = (name) => normCategory(name).cc;
function cleanCards(cards, opts) {
  if (!Array.isArray(cards) || !cards.length) return cards;
  const titles = channelTitles(cards.map((c) => c && typeof c.title === "string" ? c.title : ""), opts);
  return cards.map((c, i) => c && typeof c.title === "string" && titles[i] !== c.title ? { ...c, title: titles[i] } : c);
}
function cleanRails(rails, lang) {
  if (!Array.isArray(rails)) return rails;
  return rails.map((r) => r && Array.isArray(r.items) ? { ...r, items: cleanCards(r.items, { cat: categoryKey(r.title), lang }) } : r);
}

// src/catalog.js
var BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
var VEGETA_VERSION_CODE = "21";
var CACHE_TTL_MS = 6 * 60 * 60 * 1e3;
var SRVS_V = 2;
var PROBE = "get_vod_categories";
var PROBE_KIND = "vod";
var SRVCHOSEN_KEY = "srvChosen:v1";
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
async function fetchServerList(opts) {
  const t = opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {};
  let code = readVersionCode();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(BOOTSTRAP_URL + "?v=" + Date.now(), { headers: { ...vegetaHeaders(code), "Accept": "application/json" }, ...t });
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
      const r2 = await kino.fetch(data.servers_url, { headers: { ...vegetaHeaders(code), "Accept": "text/plain" }, ...t });
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
function migrate(st) {
  if (!st || !Array.isArray(st.list) || st.mig === 1) return st;
  let flag = null;
  try {
    flag = kino.storage.get(SRVCHOSEN_KEY);
  } catch (_) {
    flag = null;
  }
  if (st.chosen === void 0 && (st.pin || flag === "1") && st.list[st.idx]) st.chosen = keyOf(st.list[st.idx]);
  delete st.pin;
  st.mig = 1;
  writeSrvs(st);
  return st;
}
function carryOver(prev, st) {
  if (!prev) {
    st.idx = homeIdx(st);
    return st;
  }
  const keys = st.list.map(keyOf);
  const at = (k) => k ? keys.indexOf(k) : -1;
  if (prev.chosen) st.chosen = prev.chosen;
  if (prev.mig) st.mig = prev.mig;
  const c = at(prev.chosen);
  const a = at(keyOf(prev.list[prev.idx]));
  st.idx = c >= 0 && usable(st.list[c]) ? c : a >= 0 ? a : homeIdx(st);
  if (st.idx === a) {
    st.ok = !!prev.ok;
    st.okAt = prev.okAt;
    st.homeAt = prev.homeAt;
  }
  return st;
}
async function loadServers(force, opts) {
  const cached = migrate(readSrvs());
  const usableList = cached && Array.isArray(cached.list) && cached.list.length;
  if (!force && usableList && cached.ts && cached.v === SRVS_V && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  try {
    const list = await fetchServerList(opts);
    const st = carryOver(usableList ? cached : null, { ts: Date.now(), list, idx: 0, ok: false, v: SRVS_V });
    writeSrvs(st);
    return st;
  } catch (e) {
    lastErr = "lista: " + errText(e);
    if (usableList) return cached;
    throw e;
  }
}
function hasChosenServer() {
  const st = migrate(readSrvs());
  return !!(st && st.chosen);
}
function badAnswer(action3, data) {
  if (data === null || typeof data !== "object") return true;
  if (!Array.isArray(data)) {
    const auth = data.user_info && data.user_info.auth;
    return auth !== void 0 && String(auth) === "0";
  }
  return data.length === 0 && action3.endsWith("_categories");
}
var hostnameOf2 = (srv) => {
  try {
    return new URL(srv.url).hostname;
  } catch (_) {
    return "";
  }
};
var aliveAt = /* @__PURE__ */ new Map();
async function callServer(srv, action3, extra, opts) {
  const params = new URLSearchParams({ username: srv.username, password: srv.password, ...action3 ? { action: action3 } : {}, ...extra });
  let r;
  try {
    r = await kino.fetch(`${srv.url}/player_api.php?${params}`, {
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)"
      },
      ...opts && opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}
    });
  } catch (e) {
    if (e && e.code === "host_not_allowed" && e.host && e.host === hostnameOf2(srv)) noteBlocked(srv);
    throw e;
  }
  if (!r.ok) throw new Error("API " + r.status);
  let data;
  try {
    data = r.json();
  } catch (_) {
    throw new Error("respuesta inv\xE1lida");
  }
  if (accountVerdict(data) === "dead") {
    noteDead(srv);
    throw Object.assign(new Error("cuenta no v\xE1lida"), { dead: true });
  }
  if (action3 ? badAnswer(action3, data) : !(data && typeof data === "object" && !Array.isArray(data) && data.user_info)) throw new Error("respuesta inv\xE1lida");
  noteAlive(srv);
  aliveAt.set(keyOf(srv), Date.now());
  return data;
}
function rememberProbeCats(srv, data) {
  const k = keyOf(srv);
  if (!k || !Array.isArray(data) || !data.length) return;
  const list = data.map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  if (serverKey() === k) catMemo[PROBE_KIND] = { key: k, ts: Date.now(), list };
  putCats(PROBE_KIND, k, list);
}
var CATS_REWRITE_MS = 60 * 60 * 1e3;
function putCats(kind, k, list) {
  const l = list.map((c) => [c.category_id, c.category_name]);
  try {
    const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + k) || "null");
    if (o && Array.isArray(o.l) && Date.now() - o.ts < CATS_REWRITE_MS && JSON.stringify(o.l) === JSON.stringify(l)) return;
  } catch (_) {
  }
  put("cats:" + kind + ":" + k, JSON.stringify({ ts: Date.now(), l }));
}
function homeIdx(st) {
  const i = st.list.findIndex((s) => indexFitsServer(s.url));
  return i >= 0 ? i : 0;
}
function backTarget(st) {
  if (st.chosen) {
    const i = st.list.findIndex((s) => keyOf(s) === st.chosen);
    if (i >= 0) return i;
  }
  return homeIdx(st);
}
var BACK_HOME_TIMEOUT_MS = 4e3;
var backHomeRun = null;
function backHome() {
  if (!backHomeRun) backHomeRun = goBackHome().finally(() => {
    backHomeRun = null;
  });
  return backHomeRun;
}
async function goBackHome() {
  const st = await loadServers(false);
  const target = backTarget(st);
  if (st.idx === target || Date.now() - (st.homeAt || 0) < 3e5 || !usable(st.list[target])) return;
  st.homeAt = Date.now();
  try {
    const data = await callServer(st.list[target], PROBE, {}, { timeoutMs: BACK_HOME_TIMEOUT_MS });
    st.idx = target;
    st.ok = true;
    st.okAt = Date.now();
    rememberProbeCats(st.list[target], data);
  } catch (_) {
  }
  writeSrvs(st);
}
function walkOrder(st) {
  const n = st.list.length;
  const map = readPanels();
  const p = panelOf(keyOf(st.list[st.idx]), map);
  const ring = Array.from({ length: n }, (_, j) => (st.idx + j) % n);
  const same = p ? ring.filter((i) => i !== st.idx && panelOf(keyOf(st.list[i]), map) === p) : [];
  return [st.idx, ...same, ...ring.filter((i) => i !== st.idx && !same.includes(i))].filter((i) => usable(st.list[i]));
}
var OK_WRITE_MS = 10 * 60 * 1e3;
async function api(action3, extra = {}, opts = {}) {
  const until = opts.until || 0;
  let last = "";
  for (let pass = 0; pass < (until ? 1 : 2); pass++) {
    const st = await loadServers(pass === 1);
    if (pass === 0 && !until) await backHome();
    const st2 = readSrvs();
    if (st2 && pass === 0) {
      st.idx = st2.idx;
      st.ok = st2.ok;
      st.okAt = st2.okAt;
      st.homeAt = st2.homeAt;
    }
    for (const i of walkOrder(st)) {
      const left = until ? until - Date.now() : 0;
      if (until && left < 1e3) break;
      try {
        const data = await callServer(st.list[i], action3, extra, until ? { timeoutMs: left } : void 0);
        if (i !== st.idx || !st.ok || Date.now() - (st.okAt || 0) > OK_WRITE_MS) {
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
  throw kino.error("unavailable", "ning\xFAn servidor respondi\xF3 (" + action3 + "): " + last, { userMessage: "Error al contactar el servidor." });
}
async function activeServer() {
  let st = await loadServers(false);
  if (!st.ok) {
    await api(PROBE);
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
var labelOf2 = (srv) => srv && srv.name ? srv.name : hostOf(srv);
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
  const fi = flagInfo(labelOf2(srv));
  return fi ? fi.code ? `${fi.code.toUpperCase()} \xB7 ${fi.name}` : fi.name : labelOf2(srv);
};
var okAtOf = (st) => Math.max(Number(st && st.okAt) || 0, st && st.list && aliveAt.get(keyOf(st.list[st.idx])) || 0);
async function serverStatus() {
  const cached = readSrvs();
  if (cached && cached.ok && cached.list && cached.list[cached.idx] && Date.now() - okAtOf(cached) < 2e4) return { ok: true, host: hostOf(cached.list[cached.idx]), index: cached.idx + 1, total: cached.list.length, at: okAtOf(cached) };
  try {
    await api(PROBE);
    const st = readSrvs();
    return { ok: true, host: hostOf(st.list[st.idx]), index: st.idx + 1, total: st.list.length, at: okAtOf(st) };
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
    if (!usable(st.list[i])) continue;
    try {
      const data = await callServer(st.list[i], PROBE, {});
      st.idx = i;
      st.ok = true;
      st.okAt = Date.now();
      st.chosen = keyOf(st.list[i]);
      writeSrvs(st);
      rememberProbeCats(st.list[i], data);
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
var LATAM = /* @__PURE__ */ new Set(["ar", "bo", "cl", "co", "cr", "cu", "do", "ec", "gt", "hn", "ni", "pa", "pe", "pr", "py", "sv", "uy", "ve"]);
function srvPriority(x) {
  const code = (x.flag || "").toLowerCase();
  if (code === "es" || code === "mx" || /latino|latam/.test(String(x.label || "").toLowerCase())) return 0;
  if (LATAM.has(code)) return 1;
  if (!code) return 2;
  return 3;
}
var flagOf = (srv) => {
  const fi = flagInfo(labelOf2(srv));
  return fi ? fi.code : "";
};
var priorityOf = (srv) => srvPriority({ flag: flagOf(srv), label: niceLabel(srv) });
function itemsWithHealth(st) {
  const h = healthFresh();
  const online = h ? new Set(h.online) : null;
  let items = (st.list || []).map((s, i) => ({ s, i })).filter(({ s }) => usable(s)).map(({ s, i }) => {
    const fi = flagInfo(labelOf2(s));
    const flag = fi ? fi.code : "";
    const label = niceLabel(s);
    return { i, label, host: hostOf(s), https: String(s.url).startsWith("https://"), flag, es: srvPriority({ flag, label }) <= 1, online: online ? online.has(s.url) : true };
  });
  if (online && online.size > 0) items = items.filter((x) => x.online);
  items.sort((a, b) => srvPriority(a) - srvPriority(b) || a.i - b.i);
  return items;
}
async function selectServer(i) {
  const st = await loadServers(false);
  const n = st.list.length;
  const start = parseInt(i, 10);
  if (!(start >= 0 && start < n)) return { ok: false };
  const wantLabel = labelOf2(st.list[start]);
  const all = Array.from({ length: n }, (_, k) => k);
  const order = [start, ...all.filter((k) => k !== start && labelOf2(st.list[k]) === wantLabel && usable(st.list[k]))].slice(0, 5);
  for (const idx of order) {
    try {
      const data = await callServer(st.list[idx], PROBE, {});
      st.idx = idx;
      st.ok = true;
      st.okAt = Date.now();
      st.chosen = keyOf(st.list[idx]);
      writeSrvs(st);
      rememberProbeCats(st.list[idx], data);
      return { ok: true, host: hostOf(st.list[idx]), label: labelOf2(st.list[idx]), index: idx + 1, total: n, exact: idx === start };
    } catch (e) {
      lastErr = errText(e);
    }
  }
  return { ok: false, host: hostOf(st.list[start]), label: labelOf2(st.list[start]), index: start + 1, total: n };
}
var RACE_PARALLEL = 3;
var RACE_TIMEOUT_MS = 2500;
var RACE_WINDOW_MS = 9e3;
var RACE_RESERVE_MS = 4e3;
var RACE_MIN_MS = 1500;
var RACE_MAX_PROBES = 20;
var PICK_ANSWERS_MS = 2 * 60 * 1e3;
var HOST_SILENT = /* @__PURE__ */ new Set(["timeout", "network", "host_not_allowed"]);
var CALL_SPENT = /* @__PURE__ */ new Set(["rate_limited", "invalid_request"]);
function spreadHosts(items) {
  const seen = /* @__PURE__ */ new Set();
  const first = [];
  const rest = [];
  for (const x of items) {
    if (seen.has(x.host)) rest.push(x);
    else {
      seen.add(x.host);
      first.push(x);
    }
  }
  return [...first, ...rest];
}
function takePick(st, it, data) {
  const srv = st.list[it.i];
  try {
    st.idx = it.i;
    st.ok = true;
    st.okAt = Date.now();
    st.chosen = keyOf(srv);
    writeSrvs(st);
    rememberProbeCats(srv, data);
  } catch (_) {
  }
  return { ok: true, host: hostOf(srv), label: labelOf2(srv), index: it.i + 1, total: st.list.length };
}
function keptPick(st) {
  const srv = st.list[st.idx];
  return { ok: true, kept: true, host: hostOf(srv), label: labelOf2(srv), index: st.idx + 1, total: st.list.length };
}
async function raceFirstServer(opts = {}) {
  const until = opts.until || Date.now() + HEALTH_DEADLINE_MS;
  let st;
  try {
    st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
  } catch (e) {
    lastErr = errText(e);
    return { ok: false };
  }
  if (st.chosen) return keptPick(st);
  const end = Math.min(Date.now() + RACE_WINDOW_MS, until - RACE_RESERVE_MS);
  if (end - Date.now() < RACE_MIN_MS) return { ok: false, late: true };
  const items = itemsWithHealth(st);
  const queue = [...spreadHosts(items.filter((x) => x.es)), ...spreadHosts(items.filter((x) => !x.es))];
  if (!queue.length) return { ok: false };
  const hostname = (it) => hostnameOf2(st.list[it.i]) || it.host;
  return new Promise((done) => {
    const flying = /* @__PURE__ */ new Map();
    const silent = /* @__PURE__ */ new Set();
    let sent = 0;
    let best = null;
    let over = false;
    let spent = false;
    const finish = (out) => {
      over = true;
      done(out);
    };
    const esFlying = () => [...flying.values()].some((x) => x.es);
    const step2 = () => {
      if (over) return;
      if (best && best.it.es) return finish(takePick(st, best.it, best.data));
      while (!spent && flying.size < RACE_PARALLEL && sent < RACE_MAX_PROBES && end - Date.now() >= RACE_MIN_MS) {
        const k = queue.findIndex((x) => (!best || x.es) && !flying.has(hostname(x)) && !silent.has(hostname(x)));
        if (k < 0) break;
        start(queue.splice(k, 1)[0]);
      }
      if (best && !esFlying()) return finish(takePick(st, best.it, best.data));
      if (!flying.size) finish({ ok: false });
    };
    const start = (it) => {
      const h = hostname(it);
      flying.set(h, it);
      sent++;
      callServer(st.list[it.i], PROBE, {}, { timeoutMs: Math.min(RACE_TIMEOUT_MS, end - Date.now()) }).then((data) => {
        flying.delete(h);
        if (over) return;
        if (!best || it.es && !best.it.es) best = { it, data };
        step2();
      }, (e) => {
        flying.delete(h);
        if (over) return;
        lastErr = errText(e);
        const code = e && e.code;
        if (CALL_SPENT.has(code)) spent = true;
        else if (HOST_SILENT.has(code)) silent.add(h);
        step2();
      });
    };
    step2();
  });
}
var pickAnswers = null;
async function autoPickServer(opts = {}) {
  const memo3 = pickAnswers && Date.now() - pickAnswers.at < PICK_ANSWERS_MS ? pickAnswers : null;
  pickAnswers = null;
  if (memo3 && !memo3.answers.size) return { ok: false };
  let st;
  try {
    st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
  } catch (e) {
    lastErr = errText(e);
    return { ok: false };
  }
  if (st.chosen) return keptPick(st);
  if (memo3) {
    const it = itemsWithHealth(st).find((x) => memo3.answers.has(keyOf(st.list[x.i])));
    return it ? takePick(st, it, memo3.answers.get(keyOf(st.list[it.i]))) : { ok: false };
  }
  return raceFirstServer(opts);
}
function serverListFresh() {
  const st = readSrvs();
  return !!(st && Array.isArray(st.list) && st.list.length && st.ts && st.v === SRVS_V && Date.now() - st.ts < CACHE_TTL_MS);
}
var HEALTH_KEY = "health:v1";
var HEALTH_TTL_MS = 6 * 60 * 60 * 1e3;
var HEALTH_TIMEOUT_MS = 1e4;
var HEALTH_DEADLINE_MS = 15e3;
var HEALTH_PARALLEL = 6;
var LIST_TIMEOUT_MS = 4e3;
var PANELS_STALE_MS = 20 * 60 * 60 * 1e3;
var healthRunning = false;
function readHealth() {
  try {
    const o = JSON.parse(kino.storage.get(HEALTH_KEY) || "null");
    return o && Array.isArray(o.online) && typeof o.ts === "number" ? o : null;
  } catch (_) {
    return null;
  }
}
var HEALTH_EMPTY_TTL_MS = 30 * 60 * 1e3;
var healthFresh = () => {
  const h = readHealth();
  return h && Date.now() - h.ts < (h.online.length ? HEALTH_TTL_MS : HEALTH_EMPTY_TTL_MS) ? h : null;
};
var healthReady = () => !!healthFresh();
var panelsStale = () => {
  const m = readPanels();
  return !m || Date.now() - (Number(m.at) || 0) > PANELS_STALE_MS;
};
var ACTIVE_FRESH_MS = 5 * 60 * 1e3;
function activeConfirmed() {
  const k = serverKey();
  if (!k) return false;
  const at = aliveAt.get(k);
  return typeof at === "number" && Date.now() - at < ACTIVE_FRESH_MS || healthReady();
}
var FIT_MIN = 0.8;
var INDEX_NAMES_TIMEOUT_MS = 4e3;
var sameIndexName = (name, e) => !!name && Array.isArray(e) && normKey(cleanCategoryName(name).title) === normKey(e[0]);
async function indexFitsFrom(answers, list, prevIx, until) {
  const src = indexSource();
  if (!src) return null;
  const left = until - Date.now();
  const names = left >= 1e3 ? await indexCategoryNames({ timeoutMs: Math.min(INDEX_NAMES_TIMEOUT_MS, left), cacheMiss: false }).catch(() => null) : null;
  const entries2 = Object.entries(names && names.vod || {});
  if (!entries2.length) return prevIx && prevIx.src === src ? prevIx : null;
  const idxKey = keyOf(list.find((s) => indexFitsServer(s.url)));
  const scored = [];
  list.forEach((s, i) => {
    const data = answers.get(keyOf(s));
    if (!Array.isArray(data)) return;
    const byId = new Map(data.map((c) => [String(c.category_id || ""), String(c.category_name || "")]));
    let n = 0;
    for (const [id, e] of entries2) if (sameIndexName(byId.get(id), e)) n++;
    if (n / entries2.length >= FIT_MIN) scored.push({ k: keyOf(s), fit: n / entries2.length, full: n === entries2.length, i });
  });
  const seed = installSeed();
  const tie = (k) => {
    let h = 2166136261;
    const t = seed + k;
    for (let j = 0; j < t.length; j++) {
      h ^= t.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const others = scored.filter((x) => x.k !== idxKey).sort((a, b) => b.fit - a.fit || tie(a.k) - tie(b.k));
  return { src, fits: scored.map((x) => x.k), full: scored.filter((x) => x.full).map((x) => x.k), ...others.length ? { home: others[0].k } : {} };
}
var ixOf = (map) => map && map.ix && map.ix.src && map.ix.src === indexSource() ? map.ix : null;
function fitsIndex(srv, map) {
  if (!srv) return false;
  if (indexFitsServer(srv.url)) return true;
  const ix = ixOf(map);
  return !!ix && Array.isArray(ix.fits) && ix.fits.includes(keyOf(srv));
}
function fullyFitsIndex(srv, map) {
  const ix = ixOf(map);
  return !!srv && !!ix && Array.isArray(ix.full) && ix.full.includes(keyOf(srv));
}
function storedCats(kind, srv) {
  const k = keyOf(srv);
  const m = catMemo[kind];
  if (k && m && m.key === k && Array.isArray(m.list)) return m.list;
  try {
    const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + k) || "null");
    return o && Array.isArray(o.l) ? o.l.map(([category_id, category_name]) => ({ category_id: String(category_id), category_name: String(category_name) })) : null;
  } catch (_) {
    return null;
  }
}
async function carriesIndexCats(srv, p) {
  if (!p || !p.cats.length) return null;
  const kind = p.kind === "movies" ? "vod" : "series";
  const names = await indexCategoryNames({ timeoutMs: INDEX_NAMES_TIMEOUT_MS }).catch(() => null);
  const idx = names && names[kind] || {};
  const cats = storedCats(kind, srv);
  const ids = p.cats.map(String).filter((id) => idx[id]);
  if (!cats || !ids.length) return null;
  const byId = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
  return ids.every((id) => sameIndexName(byId.get(id), idx[id]));
}
function indexHomeIdx(st, map) {
  const i = st.list.findIndex((s) => indexFitsServer(s.url));
  if (!indexSource()) return i;
  const h = healthFresh();
  const up = (s) => usable(s) && (!h || h.online.includes(s.url));
  if (i >= 0 && up(st.list[i])) return i;
  const ix = ixOf(map);
  if (ix && ix.home) {
    const j = st.list.findIndex((s) => keyOf(s) === ix.home);
    if (j >= 0 && up(st.list[j])) return j;
  }
  return i >= 0 && usable(st.list[i]) ? i : -1;
}
async function healthCheck(opts = {}) {
  if (healthRunning) return 0;
  healthRunning = true;
  const until = Math.min(Date.now() + HEALTH_DEADLINE_MS, opts.until || Infinity);
  try {
    const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
    const list = st.list || [];
    const sets = /* @__PURE__ */ new Map();
    const answers = /* @__PURE__ */ new Map();
    const answered = /* @__PURE__ */ new Set();
    const unprobed = /* @__PURE__ */ new Set();
    await pool(checkOrder(st), HEALTH_PARALLEL, async (s) => {
      if (!usable(s)) return;
      const left = until - Date.now();
      if (left < 1500) {
        unprobed.add(s.url);
        return;
      }
      try {
        const data = await callServer(s, PROBE, {}, { timeoutMs: Math.min(HEALTH_TIMEOUT_MS, left - 500) });
        sets.set(keyOf(s), pairHashes(data));
        answers.set(keyOf(s), data);
        answered.add(s.url);
      } catch (_) {
      }
    });
    pickAnswers = st.chosen ? null : { at: Date.now(), answers };
    return await afterCheck(st, list, { sets, answers, answered, unprobed, until });
  } catch (_) {
    try {
      put(HEALTH_KEY, JSON.stringify({ ts: Date.now(), online: [] }));
    } catch (__) {
    }
    const prev = readSrvs();
    pickAnswers = prev && prev.chosen ? null : { at: Date.now(), answers: /* @__PURE__ */ new Map() };
    return 0;
  } finally {
    healthRunning = false;
  }
}
function checkOrder(st) {
  const list = st.list || [];
  const first = new Set([keyOf(list[st.idx]), st.chosen].filter(Boolean));
  return [...list.filter((s) => first.has(keyOf(s))), ...list.filter((s) => !first.has(keyOf(s)))];
}
async function afterCheck(st, list, { sets, answers, answered, unprobed, until }) {
  const online = list.filter((s) => answered.has(s.url)).map((s) => s.url);
  const now = Date.now();
  put(HEALTH_KEY, JSON.stringify({ ts: now, online: list.filter((s) => answered.has(s.url) || unprobed.has(s.url)).map((s) => s.url) }));
  let map = readPanels();
  if (sets) {
    const prev = map;
    map = groupPanels(sets, prev, now);
    const ix = await indexFitsFrom(answers, list, prev && prev.ix, until);
    if (ix) map.ix = ix;
    writePanels(map);
    const ixHome = ix && ix.home ? list.find((s) => keyOf(s) === ix.home) : null;
    if (ixHome && answers.has(ix.home)) rememberProbeCats(ixHome, answers.get(ix.home));
  }
  const fresh = readSrvs() || st;
  const cur = fresh.list && fresh.list[fresh.idx];
  if (cur && online.length && !online.includes(cur.url)) {
    const p = panelOf(keyOf(cur), map);
    const flag = flagOf(cur);
    const score = (s) => [p && panelOf(keyOf(s), map) === p ? 0 : 1, flagOf(s) === flag ? 0 : 1, priorityOf(s)];
    const cands = fresh.list.map((s, i) => ({ s, i, sc: score(s) })).filter((x) => online.includes(x.s.url)).sort((a, b) => a.sc[0] - b.sc[0] || a.sc[1] - b.sc[1] || a.sc[2] - b.sc[2] || a.i - b.i);
    if (cands.length) {
      fresh.idx = cands[0].i;
      fresh.ok = true;
      fresh.okAt = now;
      writeSrvs(fresh);
    }
  }
  return online.length;
}
var LIVE_PROBE_TIMEOUT_MS = 3e3;
var FULL_PROBE_TIMEOUT_MS = 4e3;
var STEP_START_MS = 700;
var ROUND_MAX_MS = 10 * 60 * 1e3;
var round = null;
async function healthStep({ kind = "live" } = {}) {
  if (healthRunning) return "more";
  healthRunning = true;
  try {
    if (!round || Date.now() - round.ts > ROUND_MAX_MS || round.kind !== kind && round.kind !== "full") {
      const st = await loadServers(false, { timeoutMs: LIST_TIMEOUT_MS });
      const order = checkOrder(st).filter((s) => usable(s));
      const head = new Set([keyOf(st.list[st.idx]), st.chosen].filter(Boolean));
      round = { kind, ts: Date.now(), st, order, next: 0, head: order.filter((s) => head.has(keyOf(s))).length, sets: /* @__PURE__ */ new Map(), answers: /* @__PURE__ */ new Map(), answered: /* @__PURE__ */ new Set() };
    }
    const r = round;
    const full = r.kind === "full";
    const stop = r.next === 0 && r.head > 0 ? r.head : r.order.length;
    const startUntil = Date.now() + STEP_START_MS;
    await Promise.all(Array.from({ length: HEALTH_PARALLEL }, async () => {
      while (r.next < stop && Date.now() < startUntil) {
        const s = r.order[r.next++];
        try {
          const data = full ? await callServer(s, PROBE, {}, { timeoutMs: FULL_PROBE_TIMEOUT_MS }) : await callServer(s, null, {}, { timeoutMs: LIVE_PROBE_TIMEOUT_MS });
          r.answered.add(s.url);
          if (full) {
            r.sets.set(keyOf(s), pairHashes(data));
            r.answers.set(keyOf(s), data);
          }
        } catch (_) {
        }
      }
    }));
    if (r.next < r.order.length) return "more";
    round = null;
    const list = r.st.list || [];
    await afterCheck(r.st, list, { sets: full ? r.sets : null, answers: r.answers, answered: r.answered, unprobed: /* @__PURE__ */ new Set(), until: Date.now() + INDEX_NAMES_TIMEOUT_MS });
    return "done";
  } catch (_) {
    round = null;
    return "failed";
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
      await api(PROBE);
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
  infoCache()[itemId] = ficha;
}
function writeFichas() {
  const map = infoCache();
  const ids = Object.keys(map);
  if (ids.length > INFO_MAX) for (const old of ids.slice(0, ids.length - INFO_MAX)) delete map[old];
  let text2 = JSON.stringify(map);
  while (jsonSize(text2) > 26 * 1024 && Object.keys(map).length > 1) {
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
  if (f.overview) out.overview = f.overview;
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
  if (info.plot) ficha.overview = String(info.plot).slice(0, 500);
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
  if (saved) writeFichas();
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
var LIST_MEMO_MS = 3 * 60 * 1e3;
var LIST_MEMO_ITEMS = 8e3;
var listMemo = /* @__PURE__ */ new Map();
function memoList(k, action3, categoryId) {
  const id = k + "|" + action3 + "|" + categoryId;
  const m = listMemo.get(id);
  if (!m) return null;
  if (Date.now() - m.ts >= LIST_MEMO_MS) {
    listMemo.delete(id);
    return null;
  }
  return m.data;
}
function keepList(k, action3, categoryId, data) {
  if (!k || !Array.isArray(data) || data.length > LIST_MEMO_ITEMS) return;
  const id = k + "|" + action3 + "|" + categoryId;
  listMemo.delete(id);
  listMemo.set(id, { ts: Date.now(), data });
  let n = 0;
  for (const m of listMemo.values()) n += m.data.length;
  for (const [key, m] of listMemo) {
    if (n <= LIST_MEMO_ITEMS) break;
    n -= m.data.length;
    listMemo.delete(key);
  }
}
var EXPLICIT_TIMEOUT_MS = 4e3;
async function fetchCategory(action3, categoryId, srv, opts) {
  const extra = { category_id: String(categoryId) };
  const cached = memoList(srv ? keyOf(srv) : serverKey(), action3, String(categoryId));
  if (cached) return cached;
  if (srv) {
    const data = await callServer(srv, action3, extra, { timeoutMs: opts && opts.timeoutMs || EXPLICIT_TIMEOUT_MS });
    if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
    keepList(keyOf(srv), action3, String(categoryId), data);
    return data;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api(action3, extra, opts);
      if (!Array.isArray(data)) throw new Error("respuesta que no es lista");
      keepList(serverKey(), action3, String(categoryId), data);
      return data;
    } catch (e) {
      if (attempt >= 1 || opts && opts.until || e && (e.code === "rate_limited" || e.dead)) throw e;
    }
  }
}
var byAddedDesc = (a, b) => num(b.added) - num(a.added);
var CAT_ACTIONS = { vod: "get_vod_categories", series: "get_series_categories", live: "get_live_categories" };
var catMemo = {};
async function categoryList(kind, srv, opts) {
  const key = srv ? keyOf(srv) : serverKey();
  const m = catMemo[kind];
  if (!srv && key && m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return m.list;
  if (key) {
    try {
      const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
      if (o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS) {
        const list2 = o.l.map(([category_id, category_name]) => ({ category_id, category_name }));
        if (!srv) catMemo[kind] = { key, ts: o.ts, list: list2 };
        return list2;
      }
    } catch (_) {
    }
  }
  const data = srv ? await callServer(srv, CAT_ACTIONS[kind], {}, { timeoutMs: opts && opts.timeoutMs || EXPLICIT_TIMEOUT_MS }) : await api(CAT_ACTIONS[kind], {}, opts);
  const list = (Array.isArray(data) ? data : []).map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  const now = srv ? key : serverKey();
  if (!srv) catMemo[kind] = { key: now, ts: Date.now(), list };
  putCats(kind, now, list);
  return list;
}
function categoriesCached(kind) {
  const key = serverKey();
  const m = catMemo[kind];
  if (!key) return false;
  if (m && m.key === key && Date.now() - m.ts < CACHE_TTL_MS) return true;
  try {
    const o = JSON.parse(kino.storage.get("cats:" + kind + ":" + key) || "null");
    return !!(o && Array.isArray(o.l) && Date.now() - o.ts < CACHE_TTL_MS);
  } catch (_) {
    return false;
  }
}
var mergedVod = async (kind, srv, opts) => mergeVod(kind, await categoryList(kind, srv, opts), { showAdult: showAdult() });
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
  if (!opts.noEnrich) await enrichTmdb(rails.slice(0, vod ? 2 : 1).flatMap((r) => r.items.slice(0, 8)), { max: vod ? 16 : 8, budgetMs: 2500 });
  return { rails, langs, lang, failed, hasMore, next: offset + maxRails, cats: catsList };
}
async function homeRailPlan(kind, max, wantLang) {
  const cats = await mergedVod(kind);
  const hasEs = cats.some((c) => c.lang === "es-419" || c.lang === "es-ES");
  const extra = [...new Set(cats.map((c) => c.lang).filter((l) => /^x-/.test(l)))].sort((a, b) => langLabel(a)[0].localeCompare(langLabel(b)[0]));
  const langs = [...LANG_ORDER.filter((l) => l === "es" ? hasEs : cats.some((c) => c.lang === l)), ...extra];
  const lang = wantLang && langs.includes(wantLang) ? wantLang : langs[0] || null;
  let inLang = cats;
  if (lang === "es") {
    const seen = /* @__PURE__ */ new Set();
    inLang = cats.filter((c) => (c.lang === "es-419" || c.lang === "es-ES") && !seen.has(c.title.toLowerCase()) && seen.add(c.title.toLowerCase()));
  } else if (lang) inLang = cats.filter((c) => c.lang === lang);
  const ordered = homeOrder(inLang);
  return { lang, langs, cats: ordered.slice(0, max).map((c) => ({ id: c.id, title: c.title })) };
}
async function oneRail(kind, catId, perRail, lang) {
  try {
    const info = await loadRailsInfo(kind, 1, perRail, { lang, only: catId, noEnrich: true });
    return info.rails[0] || null;
  } catch (_) {
    return null;
  }
}
var COUNTRY_ROW_MS = 3e3;
async function home() {
  const dbgT = Date.now();
  console.log("[dbg] home() de Kino: inicio server=" + serverKey());
  try {
    const feed = await fetchHomeFeed(serverKey(), null);
    if (feed && feed.rows.length) {
      const rows2 = feed.rows.map((r) => ({ id: r.id, title: r.title, ref: r.ref, items: r.items }));
      const live2 = isCountryCode(homeCountry()) ? await countryRow(20, { until: Date.now() + COUNTRY_ROW_MS }).catch(() => null) : null;
      if (live2) rows2.push({ id: live2.id, title: live2.title, genre: "tv", items: live2.items });
      indexStep({ budgetMs: 1500 }).catch(() => {
      });
      console.log("[dbg] home() de Kino: DESDE EL FEED rows=" + rows2.length + " " + (Date.now() - dbgT) + "ms");
      return rows2;
    }
  } catch (_) {
  }
  console.log("[dbg] home() de Kino: sin feed, carga EN VIVO del IPTV");
  const indexing = indexStep({ budgetMs: 1500 });
  const vod = await loadRailsInfo("vod", 7, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const series = await loadRailsInfo("series", 4, HOME_PREVIEW, { home: true }).catch(() => ({ rails: [] }));
  const live = await countryRow().catch(() => null);
  await indexing;
  const rows = [...vod.rails, ...series.rails].map(({ lang, ...r }) => r);
  if (!rows.length) throw kino.error("unavailable", "sin contenido", { userMessage: "Sin contenido disponible por ahora." });
  if (live) rows.push({ id: live.id, title: live.title, genre: "tv", items: live.items });
  console.log("[dbg] home() de Kino: fin rows=" + rows.length + " " + (Date.now() - dbgT) + "ms");
  return rows;
}
async function browse(ref, cursor) {
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const start = (page - 1) * PER_PAGE;
  const [kindPrefix, catId, flag] = String(ref || "").split(":");
  if (kindPrefix === "lcat" && /^\d+$/.test(catId || "")) {
    const out = await liveChannels({ categoryId: catId, cursor: String(start) });
    const all2 = out.items.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} }));
    return { items: all2.slice(0, PER_PAGE), next: all2.length > PER_PAGE || out.next ? String(page + 1) : void 0 };
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
  const action3 = kind === "vod" ? "get_vod_streams" : "get_series";
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
        const data = await fetchCategory(action3, cat.id);
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
var serverCats = async (kind, wanted = [], srv, opts) => {
  const all = searchOrder(await mergedVod(kind === "movies" ? "vod" : "series", srv, opts));
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
var LIVE_PAGE = 500;
var LIVE_CATS_TTL_MS = 10 * 60 * 1e3;
var liveCatsMemo = null;
async function liveCats(opts) {
  const key = serverKey();
  if (liveCatsMemo && key && liveCatsMemo.key === key && Date.now() - liveCatsMemo.ts < LIVE_CATS_TTL_MS) return liveCatsMemo.list;
  const merged = mergeLive(await categoryList("live", null, opts), { showAdult: true });
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
var catNames2 = { list: null, map: null };
function catNameOf(catId) {
  const m = catMemo.live;
  if (!m || !Array.isArray(m.list)) return "";
  if (catNames2.list !== m.list) catNames2 = { list: m.list, map: new Map(m.list.map((c) => [String(c.category_id), c.category_name])) };
  return catNames2.map.get(String(catId)) || "";
}
function liveItem(s, categoryId, adult, shown) {
  const id = String(s.stream_id || "");
  const raw = String(s.name || "").trim();
  if (!id || !raw) return null;
  const catId = String(categoryId || s.category_id || "");
  return {
    id: "live-" + id,
    title: shown || raw,
    ref: liveRef(id, catId, categoryTok(catNameOf(catId)), channelTok(raw)),
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
  const catKey = categoryKey(catNameOf(categoryId));
  const seen = shownMemo.get(all);
  const shown = seen && seen.cat === catKey && seen.lang === langNow() ? seen.shown : shownTitles(all, catKey);
  if (!seen || seen.shown !== shown) shownMemo.set(all, { cat: catKey, lang: langNow(), shown });
  const items = [];
  for (let i = start; i < Math.min(all.length, start + LIVE_PAGE); i++) {
    const it = liveItem(all[i], categoryId, adult, shown[i]);
    if (it) items.push(it);
  }
  return { items, next: all.length > start + LIVE_PAGE ? String(start + LIVE_PAGE) : void 0 };
}
var shownMemo = /* @__PURE__ */ new WeakMap();
var shownTitles = (streams, catKey) => channelTitles(streams.map((s) => s && s.name || ""), { cat: catKey, lang: langNow() });
var SHOWN_ONLY = /·|\b(?:4k|8k|uhd|fhd|hd|sd|hevc)\b/;
var nameHas = (s, q) => {
  const raw = String(s && s.name || "");
  return raw.toLowerCase().replace(/\s+/g, " ").includes(q) || SHOWN_ONLY.test(q) && cleanChannelTitle(raw).title.toLowerCase().includes(q);
};
async function liveSearchDetailed({ query }, { budgetMs = 11e3 } = {}) {
  const q = String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
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
        return data.filter((s) => nameHas(s, q)).map((s) => liveItem(s, cat.id, cat.adult)).filter(Boolean).map((it) => ({ ...it, adult: cat.adult === true }));
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
  const shown = shownTitles(items.map((it) => ({ name: it.title })), "");
  const asked = normName2(query);
  items.forEach((it, i) => {
    if (normName2(it.title) !== asked) it.title = shown[i];
  });
  return { items, partial: failed > 0 || capped };
}
async function liveSearch(args) {
  const { items } = await liveSearchDetailed(args);
  return { items };
}
var isCountryCode = (cc) => COUNTRY_PHRASES.some(([, code]) => code === cc);
async function countryRow(limit = 20, opts = {}) {
  const cc = homeCountry();
  if (!isCountryCode(cc)) return null;
  const ranked = visibleLive(await liveCats(opts)).filter((c) => c.country === cc).map((c) => ({ c, m: countryMatch(c.title) })).sort((a, b) => (a.m && a.m.exact ? 0 : a.m && a.m.starts ? 1 : 2) - (b.m && b.m.exact ? 0 : b.m && b.m.starts ? 1 : 2) || a.c.order - b.c.order).slice(0, 3);
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { c } of ranked) {
    if (items.length >= limit) break;
    if (opts.until && opts.until - Date.now() < 1e3) break;
    const data = await fetchCategory("get_live_streams", c.id, null, opts).catch(() => []);
    for (const s of data) {
      const it = liveItem(s, c.id, c.adult);
      if (!it || items.length >= limit || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, ref: it.ref, title: it.title, kind: "live", poster: it.logo, ...c.adult ? { adult: true } : {} });
    }
  }
  const shown = shownTitles(items.map((it) => ({ name: it.title })), cc.toLowerCase());
  items.forEach((it, i) => {
    it.title = shown[i];
  });
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
var GUIDE_MAX = 12;
var GUIDE_PARALLEL = 4;
var GUIDE_TIMEOUT_MS = 3e3;
async function guide({ channelIds, from, to }) {
  const ids = (Array.isArray(channelIds) ? channelIds : []).slice(0, GUIDE_MAX);
  const st = readSrvs();
  const srv = st && Array.isArray(st.list) ? st.list[st.idx] : null;
  if (!srv || !usable(srv)) return [];
  const lists = await pool(ids, GUIDE_PARALLEL, async (cid) => {
    const streamId = String(cid).replace(/^live-/, "");
    if (!/^\d+$/.test(streamId)) return [];
    try {
      const data = await callServer(srv, "get_short_epg", { stream_id: streamId, limit: "20" }, { timeoutMs: GUIDE_TIMEOUT_MS });
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
  });
  return lists.flat();
}
var AVAIL_KEY = "avail:v1";
var AVAIL_TTL_MS = 36 * 60 * 60 * 1e3;
var AVAIL_MAX_BYTES = 15 * 1024;
function readAvail() {
  try {
    const o = JSON.parse(kino.storage.get(AVAIL_KEY) || "{}");
    return o && typeof o === "object" ? o : {};
  } catch (_) {
    return {};
  }
}
var AVAIL_SAME_MS = 60 * 60 * 1e3;
function recordAvail(id, k, ext) {
  if (!id || !k) return;
  const all = readAvail();
  const t = all[id] && typeof all[id] === "object" ? all[id] : {};
  const was = t[k];
  if (was && Date.now() - (was.ts || 0) < AVAIL_SAME_MS && (ext ? was.has === 1 && was.ext === ext : was.has === 0)) return;
  t[k] = ext ? { has: 1, ext, ts: Date.now() } : { has: 0, ts: Date.now() };
  t._ts = Date.now();
  all[id] = t;
  const keys = Object.keys(all).sort((a, b) => (all[a]._ts || 0) - (all[b]._ts || 0));
  let drop = 0;
  let text2 = JSON.stringify(all);
  while (jsonSize(text2) > AVAIL_MAX_BYTES && drop < keys.length - 1) {
    const cut = Math.max(1, Math.ceil((keys.length - drop) / 10));
    for (const old of keys.slice(drop, drop + cut)) delete all[old];
    drop += cut;
    text2 = JSON.stringify(all);
  }
  try {
    put(AVAIL_KEY, text2);
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
    if (!usable(srv)) continue;
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
  if (kind === "l") {
    const id = segs[2] || "";
    if (!/^\d+$/.test(id)) throw kino.error("not_found", "fuente desconocida");
    return { url: `${srv.url}/live/${srv.username}/${srv.password}/${id}.${liveFormat()}` };
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
function cachedLive(srv) {
  const k = keyOf(srv);
  if (!k) return null;
  const m = catMemo.live;
  if (m && m.key === k && Array.isArray(m.list)) return { ts: m.ts, list: m.list };
  try {
    const o = JSON.parse(kino.storage.get("cats:live:" + k) || "null");
    if (o && Array.isArray(o.l)) return { ts: o.ts, list: o.l.map(([category_id, category_name]) => ({ category_id: String(category_id), category_name: String(category_name) })) };
  } catch (_) {
  }
  return null;
}
var cachedCats = (srv) => {
  const c = cachedLive(srv);
  return c ? c.list : null;
};
var cachedCatsAt = (srv) => {
  const c = cachedLive(srv);
  return c && typeof c.ts === "number" ? c.ts : null;
};
function rememberLiveCats(srv, data) {
  const k = keyOf(srv);
  if (!k || !Array.isArray(data) || !data.length) return;
  const list = data.map((c) => ({ category_id: String(c.category_id || ""), category_name: String(c.category_name || "").trim() }));
  if (serverKey() === k) catMemo.live = { key: k, ts: Date.now(), list };
  putCats("live", k, list);
}
async function liveServers() {
  const st = readSrvs();
  if (st && Array.isArray(st.list) && st.list.length) return st;
  return loadServers(false, { timeoutMs: 4e3 });
}
var seedMemo = "";
function installSeed() {
  if (seedMemo) return seedMemo;
  let v = null;
  try {
    v = kino.storage.get("seed:v1");
  } catch (_) {
    v = null;
  }
  if (!v || !/^\d+$/.test(v)) {
    v = String(Math.floor(Math.random() * 1e9));
    put("seed:v1", v);
  }
  seedMemo = v;
  return v;
}
var langNow = () => {
  try {
    return /^en/i.test(String(kino.lang || "")) ? "en" : "es";
  } catch (_) {
    return "es";
  }
};
var failover = createLiveFailover({
  servers: liveServers,
  cachedCats,
  catsAt: cachedCatsAt,
  storeCats: rememberLiveCats,
  // The category lists of the last minutes (listMemo), shared with the screen's and Kino's listings.
  cachedList: (srv, catId) => memoList(keyOf(srv), "get_live_streams", String(catId)),
  keepList: (srv, catId, data) => keepList(keyOf(srv), "get_live_streams", String(catId), data),
  callServer,
  playUrl: (srv, id, format) => `${srv.url}/live/${srv.username}/${srv.password}/${id}.${format || liveFormat()}`,
  label: niceLabel,
  host: hostOf,
  online: () => {
    const h = healthFresh();
    return h ? new Set(h.online) : null;
  },
  flag: flagOf,
  priority: priorityOf,
  seed: installSeed,
  now: () => Date.now(),
  unavailable: () => kino.error("unavailable", "no account plays this channel now", { userMessage: say("liveNoServer", langNow()) }),
  notFound: () => kino.error("not_found", "channel not found")
});
var IDX_HOME_DEADLINE_MS = 1e4;
var IDX_RESOLVE_BUDGET_MS = 19e3;
async function resolveIdxOnHome(idxRef, { force = false, until = Date.now() + IDX_HOME_DEADLINE_MS } = {}) {
  const st = readSrvs();
  if (!st || !Array.isArray(st.list)) return null;
  const map = readPanels();
  const active = st.list[st.idx];
  if (!force && indexSource() && usable(active) && fitsIndex(active, map)) {
    if (indexFitsServer(active.url)) return { skipped: true };
    const carries = await carriesIndexCats(active, parseIdxRef(idxRef));
    if (carries === true || carries === null && fullyFitsIndex(active, map)) return { skipped: true };
  }
  const homeI = indexHomeIdx(st, map);
  if (homeI < 0 || homeI === st.idx) return null;
  const home3 = st.list[homeI];
  let down = false;
  const onHome = async (ask) => {
    const left = until - Date.now();
    if (down || left < 1e3) throw new Error("index server not answering");
    try {
      return await ask({ timeoutMs: Math.min(EXPLICIT_TIMEOUT_MS, left) });
    } catch (e) {
      if (e && (e.code === "timeout" || e.code === "network" || e.code === "host_not_allowed" || e.dead)) down = true;
      throw e;
    }
  };
  try {
    const direct = await resolveIdxRef(
      idxRef,
      (action3, cat) => onHome((o) => fetchCategory(action3, cat, home3, o)),
      (kind, wanted) => onHome((o) => serverCats(kind, wanted, home3, o))
    );
    return direct ? { srv: home3, direct } : null;
  } catch (_) {
    return null;
  }
}
async function resolve(ref) {
  let s = String(ref || "");
  if (s.startsWith("at:")) return await resolveAlt(s);
  if (s.startsWith("live:")) return failover.resolve(s);
  const t0 = Date.now();
  const active = await activeServer();
  const { url, username, password } = active;
  if (s.startsWith("idx:m:")) {
    const p = parseIdxRef(s);
    const tok = p && p.find || "";
    await indexCategoryNames({ timeoutMs: INDEX_NAMES_TIMEOUT_MS }).catch(() => null);
    let onHome = await resolveIdxOnHome(s);
    if (!onHome || !onHome.direct) {
      try {
        s = await resolveIdxRef(s, fetchCategory, serverCats) + (tok ? "~" + tok : "");
        onHome = null;
      } catch (e) {
        const until = Math.min(Date.now() + IDX_HOME_DEADLINE_MS, t0 + IDX_RESOLVE_BUDGET_MS);
        if (!onHome || !onHome.skipped || !e || e.code !== "not_found" || until - Date.now() < 3e3) throw e;
        onHome = await resolveIdxOnHome(s, { force: true, until });
        if (!onHome || !onHome.direct) throw e;
      }
    }
    const mv = onHome && /^vod:(\d+):(.+)$/.exec(onHome.direct);
    if (mv) {
      const [, id, ext] = mv, srv = onHome.srv, key = keyOf(srv);
      noteRecent(id, ext, key);
      recordAvail("m:" + id, key, ext);
      const out = { url: `${srv.url}/movie/${srv.username}/${srv.password}/${id}.${ext}` };
      const alts = buildAlternatives("m:" + id, key, (k) => `at:${k}~m~${id}~${ext}~${tok}`);
      if (alts.length) {
        out.alternatives = alts;
        out.label = niceLabel(srv);
      }
      return out;
    }
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
  if (!out.overview && e.overview) out.overview = e.overview;
  if (!out.ids && e.ids) out.ids = e.ids;
  if (!out.runtimeMinutes && e.runtimeMinutes) out.runtimeMinutes = e.runtimeMinutes;
  if (!out.genres && e.genres) out.genres = e.genres;
  return out;
}

// src/logo.js
var LOGO_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABV0lEQVR4nO3dQZKCMBgFYddzBK/o/dczaxGTAdFuyv7rbQRJvXwHSC7XXfN7u5wu+3b638/w7VFek//h28ClRq/x6gaj9Xd4Yw/TylO8qMpo+QiviGcEhJeTJKBdQHgtVZZAeCFhAgroKCC8ijYBBRRQQDQQXkIevoE8fAN5+Aby8A3k4RvIwzeQh28gD99AHr6BPHwDefgG8ix//9zPprXG335s5U0TUEABBRTQaVcOKKCAAgpIvHJAAQUU0LcCvTIBBRRQQAG9GegUKwcUUEABBSReOaCAAgpIBjT+fjwvVjkK6MDOAQUUUEBuoMI3kIdvIA/fQB6+gTx8A3n4BvLwDeThG8jDN5CHbyAP30AevoE8HW4ySqe/BBRQQAKgjJ7pBBTQUUAZrep0XPJEJ6CNQBlNjmzP6FGjayNGOl08MqKZA32J0Vigy48ms/NSKXx77xNZzB/7TgYOhL71YQAAAABJRU5ErkJggg==";

// src/screenView.js
var TAB_IDS = ["home", "movies", "series", "live"];
var TAB_KEYS = { home: "tabHome", movies: "tabMovies", series: "tabSeries", live: "tabLive" };
var POLL_MS = 1e3;
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
var REFRESH_MS = 30 * 60 * 1e3;
function browseView({ tab, data, recent, country, loading, failed, refresh = false, device = "phone" }) {
  const tv = device === "tv";
  const active = TAB_IDS.includes(tab) ? tab : TAB_IDS[0];
  const body = [];
  const chips = data && data.langs && data.langs.length > 1 && active !== "live" ? langChips(data.langs, data.lang) : null;
  const hasCats = !!(data && data.cats && data.cats.length > 1 && active !== "live" && active !== "home");
  const catSheet = hasCats ? {
    type: "BottomSheet",
    key: "catSheet",
    ...twin("category", "title"),
    children: [{ type: "ListView", key: "catList", items: [{ id: "all", title: null }, ...data.cats.slice(0, 200)].map((c) => {
      const val = c.id === "all" ? "all" : String(c.id);
      const sel = val === (data.catSel || "all");
      return {
        type: "ListTile",
        key: "cat-" + val,
        dense: true,
        ...c.id === "all" ? twin("allCats", "title") : { title: c.title, titleEn: c.title },
        ...sel ? { selected: true, trailing: { type: "Icon", name: "check" } } : {},
        onTap: { ui: [{ close: "catSheet" }], event: "vcat", arg: val }
      };
    }) }]
  } : null;
  const clip = (t) => String(t).length > 22 ? String(t).slice(0, 21) + "\u2026" : String(t);
  const curCat = hasCats && data.catSel ? data.cats.find((c) => String(c.id) === String(data.catSel)) : null;
  const catBtn = hasCats ? {
    type: curCat ? "ElevatedButton" : "TextButton",
    key: "catButton",
    radius: "full",
    icon: "filter_list",
    ...curCat ? { labelText: clip(curCat.title), labelTextEn: clip(curCat.title) } : twin("category", "labelText"),
    onPressed: { ui: [{ open: "catSheet" }] }
  } : null;
  if (catBtn) {
    body.push({
      type: "Row",
      key: "chipsCat",
      gap: 16,
      crossAxisAlignment: "center",
      stackOnNarrow: true,
      ...chips ? {} : { mainAxisAlignment: "end" },
      children: [chips ? { ...chips, flex: 1 } : { type: "Spacer" }, catBtn]
    });
  } else if (chips) body.push(chips);
  if (catSheet) body.push(catSheet);
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
    ...loading ? { every: { ms: POLL_MS, event: "tick" } } : refresh ? { every: { ms: REFRESH_MS, event: "hrefresh" } } : {}
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
function firstPickView({ servers, failed = false, device } = {}) {
  const appBar = {
    type: "AppBar",
    divider: false,
    mergeWithKinoBar: true,
    dense: true,
    leading: barButton("close", "close", "close", { go: { close: true } }),
    title: title()
  };
  if (!servers) {
    return {
      type: "Scaffold",
      appBar,
      body: { type: "Column", key: "fpLoad", flex: 1, mainAxisAlignment: "center", crossAxisAlignment: "center", gap: 16, padding: { compact: 24, expanded: 48 }, children: failed ? [{ type: "MaterialBanner", key: "fpFail", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "retry" } }] : [{ type: "CircularProgressIndicator", key: "fpSpin" }, { type: "Text", ...twin("verifying", "text"), textAlign: "center", color: "muted" }] },
      ...failed ? {} : { every: { ms: POLL_MS, event: "tick" } }
    };
  }
  const items = (servers.items || []).slice(0, 60);
  const rows = items.map((s, idx) => {
    const hasCountry = s.label !== s.host;
    const ttl = hasCountry ? s.label : s.host;
    const sub = hasCountry ? s.https ? s.host : `${s.host} \xB7 http` : s.https ? "" : "http";
    const leading = s.flag ? { type: "Image", key: "fpflag-" + s.i, url: `https://flagcdn.com/w40/${s.flag}.png`, w: 32, h: 24 } : { type: "Icon", name: "language" };
    return {
      type: "ListTile",
      key: "fprow-" + s.i,
      title: ttl,
      titleEn: ttl,
      selected: idx === 0,
      leading,
      ...sub ? { subtitle: sub, subtitleEn: sub } : {},
      ...idx === 0 ? { trailing: { type: "Icon", name: "check" } } : {},
      onTap: { event: "srv.first", arg: String(s.i) }
    };
  });
  const list = items.length ? rows : [{ type: "Text", key: "fpEmpty", ...twin("setServerNone", "text"), color: "muted" }];
  return {
    type: "Scaffold",
    appBar,
    body: { type: "Column", key: "fpPage", flex: 1, children: [
      { type: "SingleChildScrollView", key: "fpScroll", flex: 1, children: [{ type: "Column", padding: { compact: 16, expanded: 24 }, gap: 12, children: [
        { type: "Text", ...twin("firstPickTitle", "text"), style: "h4" },
        { type: "Text", ...twin("firstPickHint", "text"), color: "muted" },
        ...list
      ] }] }
    ] }
  };
}

// src/screen.js
var dbgUrl = (u) => {
  try {
    const m = /^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/.exec(String(u));
    if (!m) return "?";
    const host = m[1].replace(/^[^@]*@/, "");
    if (host === "raw.githubusercontent.com") return host + m[2];
    const seg0 = m[2].split("/").filter(Boolean)[0] || "";
    const seg = /^(player_api\.php|get\.php|panel_api\.php|xmltv\.php|enigma2\.php|movie|series|live|timeshift)$/.test(seg0) ? seg0 : "*";
    const act = /[?&]action=([a-z_]+)/.exec(m[3] || "");
    return host + "/" + seg + (act ? "?action=" + act[1] : "");
  } catch (_) {
    return "?";
  }
};
try {
  if (!globalThis.__uhdDbgFetch && kino && typeof kino.fetch === "function") {
    globalThis.__uhdDbgFetch = true;
    const origFetch = kino.fetch;
    kino.fetch = async function(u, o) {
      const t = Date.now();
      try {
        const r = await origFetch.call(kino, u, o);
        console.log("[dbg] http " + dbgUrl(u) + " -> " + (r && r.status) + " " + (Date.now() - t) + "ms");
        return r;
      } catch (e) {
        console.log("[dbg] http " + dbgUrl(u) + " -> EXC " + (e && e.code || e && e.message) + " " + (Date.now() - t) + "ms");
        throw e;
      }
    };
  }
} catch (_) {
}
var TAB_KEY = "browseTab";
var LANG_KEY = "browseLang";
var HIST_KEY = "searchHist:v1";
var HIST_MAX = 24;
var HIST_MAX_BYTES = 10 * 1024 - 100;
var CHANNELS_CAP = 60;
var RAILS_PER_TAB = 12;
var RAIL_ITEMS = 20;
var FEATURED = 6;
var SCREEN_ROUTES = ["main", "search", "live", "settings"];
var memo2 = /* @__PURE__ */ new Map();
var liveChans = /* @__PURE__ */ new Map();
var homePlan = /* @__PURE__ */ new Map();
var homeRails = /* @__PURE__ */ new Map();
var homeSlides = /* @__PURE__ */ new Map();
var homeHeroDone = /* @__PURE__ */ new Set();
var homeFeedData = /* @__PURE__ */ new Map();
var homeFeedTried = /* @__PURE__ */ new Set();
var liveFeedData = null;
var liveFeedTried = false;
var homeLangsList = null;
var countryCards = null;
var recentCards = null;
var liveCats2 = null;
var found = null;
var liveFound = null;
var pickServers = null;
var cacheKey = null;
var raceTried = false;
var deferred = /* @__PURE__ */ new Set();
var autoPickTried = false;
var pickedNow = false;
var SRVCHOSEN_KEY2 = "srvChosen:v1";
var markServerChosen = () => {
  try {
    put(SRVCHOSEN_KEY2, "1");
  } catch (_) {
  }
};
function serverChosen() {
  let flag = null;
  try {
    flag = kino.storage.get(SRVCHOSEN_KEY2);
  } catch (_) {
    flag = null;
  }
  if (flag === "1") return true;
  if (!hasChosenServer()) return false;
  markServerChosen();
  return true;
}
function resetCaches() {
  memo2.clear();
  liveChans.clear();
  homePlan.clear();
  homeRails.clear();
  homeSlides.clear();
  homeHeroDone.clear();
  homeFeedData.clear();
  homeFeedTried.clear();
  liveFeedData = null;
  liveFeedTried = false;
  homeLangsList = null;
  countryCards = null;
  recentCards = null;
  liveCats2 = null;
  found = null;
  liveFound = null;
}
var HOME_SNAP_PREFIX = "homeSnap:";
var SNAP_V = 3;
var SNAP_MAX = 10 * 1024 - 100;
var slimCard = (c) => ({ id: c.id, ref: c.ref, title: c.title, ...c.kind ? { kind: c.kind } : {}, ...c.poster ? { poster: c.poster } : {} });
var snapKey = (tab, lang) => HOME_SNAP_PREFIX + "v" + SNAP_V + ":" + serverKey() + ":" + tab + ":" + (lang || "-");
var slimRail = (r, per) => ({ id: r.id, title: r.title, ref: r.ref, items: (r.items || []).slice(0, per).map(slimCard) });
function writeTabSnap(tab, lang, slides, rails) {
  try {
    if (!rails || !rails.length) return;
    for (const maxRails of [rails.length, 10, 8, 6]) {
      for (let per = 10; per >= 5; per -= 2) {
        const slim2 = { v: SNAP_V, slides: (slides || []).slice(0, FEATURED).map(slimCard), rails: rails.slice(0, maxRails).map((r) => slimRail(r, per)) };
        const text2 = JSON.stringify(slim2);
        if (jsonSize(text2) <= SNAP_MAX) {
          put(snapKey(tab, lang), text2);
          return;
        }
      }
    }
  } catch (_) {
  }
}
function readSnap(tab, lang) {
  try {
    const o = JSON.parse(kino.storage.get(snapKey(tab, lang)) || "null");
    return o && o.v === SNAP_V && Array.isArray(o.rails) && o.rails.length ? o : null;
  } catch (_) {
    return null;
  }
}
function writeHomeSnap(lang) {
  const m = homeRails.get(lang);
  if (!m) return;
  const plan = homePlan.get(lang) || [];
  const rails = plan.map((p) => m.get(`${p.kind}:${p.id}`)).filter((e) => e && e.card).map((e) => e.card);
  writeTabSnap("home", lang, homeSlides.get(lang) || [], rails);
}
var readHomeSnap = (lang) => readSnap("home", lang);
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
    let e = [...slimmed, ...readHistory().filter((c) => !ids.has(c.id))].slice(0, HIST_MAX);
    let text2 = JSON.stringify({ v: 1, e });
    while (jsonSize(text2) > HIST_MAX_BYTES && e.length > 1) {
      e = e.slice(0, -1);
      text2 = JSON.stringify({ v: 1, e });
    }
    put(histKey(), text2);
  } catch (_) {
  }
}
var railCards = (rails) => rails.map((r) => ({ id: r.id, title: r.title, ref: r.ref, items: r.items.map(cardOf) }));
var channelCard = (i) => ({ id: i.id, ref: i.ref, title: i.title, kind: "live", poster: i.logo, ...i.adult ? { adult: true } : {} });
async function loadVodTab(tab, lang, { home: home3 = false, offset = 0 } = {}) {
  const kind = tab === "movies" ? "vod" : "series";
  const maxRails = home3 ? tab === "movies" ? 7 : 4 : RAILS_PER_TAB;
  const info = await loadRailsInfo(kind, maxRails, RAIL_ITEMS, { lang, home: home3, offset });
  const wantFeatured = home3 && tab === "series" ? 0 : FEATURED;
  const featured = info.rails.flatMap((r) => r.items).filter((i) => i.overview).slice(0, wantFeatured);
  if (featured.length) await enrichFeatured(kind, featured, wantFeatured);
  const rails = info.rails.map((r) => ({ ...r, items: r.items.map(withFicha) }));
  const key = `${home3 ? "home-" : ""}${tab}:${lang}`;
  const prev = offset > 0 ? memo2.get(key) : null;
  const have = new Set(prev ? prev.rails.map((r) => r.id) : []);
  const fresh = railCards(rails).filter((r) => !have.has(r.id));
  memo2.set(key, { slides: prev ? prev.slides : slidesOf(rails), rails: prev ? [...prev.rails, ...fresh] : fresh, langs: info.langs, lang: info.lang, partial: info.failed > 0, hasMore: !home3 && !!info.hasMore, next: info.next, cats: prev ? prev.cats : info.cats });
}
var HOME_MOVIES = 7;
var HOME_SERIES = 4;
async function loadHomeFeed(lang, opts) {
  homeFeedTried.add(lang);
  let feed = null;
  try {
    feed = await fetchHomeFeed(serverKey(), lang, opts);
  } catch (_) {
    feed = null;
  }
  if (!feed || !feed.rows.length) return;
  const key = feed.lang && isLang(feed.lang) ? feed.lang : lang;
  const entry = { slides: feed.slides || [], rows: feed.rows, langs: feed.langs || [], movies: feed.movies || null, series: feed.series || null };
  homeFeedData.set(key, entry);
  console.log("[dbg] feed ok wanted=" + lang + " feed.lang=" + feed.lang + " storedUnder=" + key + (key !== lang ? " MISMATCH(wanted!=feed)" : "") + " movies=" + (feed.movies ? feed.movies.rows.length : 0));
  if (Array.isArray(feed.langs) && feed.langs.length) homeLangsList = feed.langs;
  writeTabSnap("home", key, feed.slides, feed.rows);
  if (feed.movies) writeTabSnap("movies", key, feed.movies.slides, feed.movies.rows);
  if (feed.series) writeTabSnap("series", key, feed.series.slides, feed.series.rows);
}
async function loadLiveFeed(opts) {
  liveFeedTried = true;
  let f = null;
  try {
    f = await fetchLiveFeed(serverKey(), opts);
  } catch (_) {
    f = null;
  }
  if (!f || !f.rails || !f.rails.length) return;
  const rails = cleanRails(f.rails, langNow());
  liveFeedData = { slides: [], rails, langs: [], lang: null, partial: false };
  writeTabSnap("live", "-", [], rails);
}
async function loadHomePlan(lang) {
  const [mv, sr] = await Promise.all([
    homeRailPlan("vod", HOME_MOVIES, lang).catch(() => ({ cats: [] })),
    homeRailPlan("series", HOME_SERIES, lang).catch(() => ({ cats: [] }))
  ]);
  const plan = [
    ...mv.cats.map((c) => ({ kind: "movies", id: c.id, title: c.title })),
    ...sr.cats.map((c) => ({ kind: "series", id: c.id, title: c.title }))
  ];
  homePlan.set(lang, plan);
  if (Array.isArray(mv.langs) && mv.langs.length) homeLangsList = mv.langs;
  if (!homeRails.has(lang)) homeRails.set(lang, /* @__PURE__ */ new Map());
}
async function loadHomeRail(kindTab, lang, catId) {
  const kind = kindTab === "movies" ? "vod" : "series";
  const rail2 = await oneRail(kind, catId, RAIL_ITEMS, lang);
  if (!homeRails.has(lang)) homeRails.set(lang, /* @__PURE__ */ new Map());
  const slot = `${kindTab}:${catId}`;
  if (!rail2 || !rail2.items || !rail2.items.length) {
    homeRails.get(lang).set(slot, null);
    return;
  }
  const full = { ...rail2, items: rail2.items.map(withFicha) };
  homeRails.get(lang).set(slot, { rail: full, card: railCards([full])[0] });
  writeHomeSnap(lang);
}
async function loadHomeHero(lang) {
  const m = homeRails.get(lang);
  if (!m) return;
  const plan = homePlan.get(lang) || [];
  const loaded = plan.map((p) => m.get(`${p.kind}:${p.id}`)).filter((e) => e && e.rail);
  const oneEachVod = loaded.filter((e) => e.rail.id.startsWith("vod-")).map((e) => e.rail.items[0]).filter(Boolean);
  const oneEachSr = loaded.filter((e) => e.rail.id.startsWith("series-")).map((e) => e.rail.items[0]).filter(Boolean);
  if (oneEachVod.length) await enrichFeatured("vod", oneEachVod, 10).catch(() => {
  });
  if (oneEachSr.length) await enrichFeatured("series", oneEachSr, 6).catch(() => {
  });
  const slides = [];
  for (const p of plan) {
    const e = m.get(`${p.kind}:${p.id}`);
    if (!e || !e.rail) continue;
    const refreshed = { ...e.rail, items: e.rail.items.map(withFicha) };
    for (const s of slidesOf([refreshed])) if (slides.length < FEATURED && !slides.some((x) => x.id === s.id)) slides.push(s);
  }
  if (slides.length) {
    homeSlides.set(lang, slides);
    writeHomeSnap(lang);
  }
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
  memo2.set("live", { slides: [], rails: railCards(rails), langs: [], lang: null, partial: failed > 0 });
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
function feedTabFor(tab, lang) {
  const f = homeFeedData.get(lang);
  if (!f) return null;
  const t = tab === "movies" ? f.movies : tab === "series" ? f.series : null;
  return t && Array.isArray(t.rows) && t.rows.length ? t : null;
}
async function race(opts) {
  const r = await raceFirstServer(opts).catch(() => ({ ok: false }));
  if (r && r.late && !deferred.has("race")) {
    deferred.add("race");
    return;
  }
  raceTried = true;
  if (r && r.ok) {
    pickedNow = !r.kept;
    markServerChosen();
    cacheKey = serverKey();
  }
}
async function autoPick(opts) {
  const r = await autoPickServer(opts).catch(() => ({ ok: false }));
  if (r && r.late && !deferred.has("autopick")) {
    deferred.add("autopick");
    return;
  }
  autoPickTried = true;
  if (r && r.ok) {
    markServerChosen();
    cacheKey = serverKey();
  }
}
var dailyHealth = () => panelsStale() ? ["panels"] : [];
var checkKind = (unit) => unit === "panels" || panelsStale() ? "full" : "live";
function unitsFor(tab, lang) {
  if (!serverChosen()) return raceTried ? ["health", "autopick", "pick"] : ["race"];
  const hBefore = pickedNow ? [] : ["hcheck"];
  const hAfter = ["health", ...dailyHealth()];
  if (tab === "home") {
    if (homeFeedData.has(lang)) return [`hfeed:${lang}`, ...countryOn() ? ["country"] : [], "recent", "index", ...dailyHealth()];
    const plan = homePlan.get(lang) || [];
    const railUnits = plan.map((p) => `hrail:${p.kind}:${lang}:${p.id}`);
    const heroUnit = railUnits.length ? [`hhero:${lang}`] : [];
    return [`hfeed:${lang}`, ...hBefore, `hplan:${lang}`, ...railUnits, ...heroUnit, ...countryOn() ? ["country"] : [], "recent", "index", ...hAfter];
  }
  if (tab === "movies" || tab === "series") {
    if (feedTabFor(tab, lang)) return [`hfeed:${lang}`, ...dailyHealth()];
    if (!homeFeedTried.has(lang)) return [`hfeed:${lang}`, ...hBefore, `tab:${tab}:${lang}`, ...hAfter];
    return [...hBefore, `tab:${tab}:${lang}`, ...hAfter];
  }
  if (tab === "live") {
    if (liveFeedData) return ["lfeed", ...dailyHealth()];
    if (!liveFeedTried) return ["lfeed", ...hBefore, "tab:live", ...hAfter];
    return [...hBefore, "tab:live", ...hAfter];
  }
  return [...hBefore, `tab:${tab}:${lang}`, ...hAfter];
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
  if (unit === "hcheck") return activeConfirmed();
  if (unit === "panels") return !panelsStale();
  if (unit === "race") return raceTried;
  if (unit === "autopick") return autoPickTried;
  if (unit === "pick") return pickServers !== null;
  if (unit === "lfeed") return liveFeedTried;
  if (unit.startsWith("hfeed:")) return homeFeedTried.has(unit.slice("hfeed:".length));
  if (unit.startsWith("hplan:")) return homePlan.has(unit.slice("hplan:".length));
  if (unit.startsWith("hhero:")) return homeHeroDone.has(unit.slice("hhero:".length));
  if (unit.startsWith("hrail:")) {
    const [, kind, lang, id] = unit.split(":");
    const m = homeRails.get(lang);
    return !!m && m.has(`${kind}:${id}`);
  }
  return memo2.has(memoKey(unit));
}
function pendingUnit(state, tab, device) {
  const failed = state.failed || {};
  const lang = wantedLang(state);
  return unitsFor(tab, lang).find((u) => !isDone(u) && !failed[u]) || null;
}
async function runUnit(unit, opts) {
  const until = opts && opts.until || 0;
  if (unit === "country") {
    const row = await countryRow(20);
    countryCards = row ? row.items.map(cardOf) : [];
  } else if (unit === "recent") await loadRecent();
  else if (unit === "index") {
    const out = await indexStep({ budgetMs: INDEX_STEP_MS });
    console.log("[dbg] index step -> " + out);
    if (out === "error" || out === "wait") throw new Error("\xEDndice: " + out);
  } else if (unit === "health" && !serverChosen()) {
    const n = await healthCheck(until ? { until: until - FIRST_FEED_RESERVE_MS } : {});
    console.log("[dbg] health online=" + n);
  } else if (unit === "health" || unit === "hcheck" || unit === "panels") {
    const out = await healthStep({ kind: checkKind(unit) });
    console.log("[dbg] " + unit + " step -> " + out);
    if (out === "failed") throw new Error("health");
    if (out === "done") pickedNow = false;
  } else if (unit === "race") await race(opts);
  else if (unit === "autopick") await autoPick(opts);
  else if (unit === "pick") pickServers = await serverList();
  else if (unit === "lfeed") await loadLiveFeed(opts);
  else if (unit.startsWith("hfeed:")) await loadHomeFeed(unit.slice("hfeed:".length), opts);
  else if (unit.startsWith("hplan:")) await loadHomePlan(unit.slice("hplan:".length));
  else if (unit.startsWith("hhero:")) {
    await loadHomeHero(unit.slice("hhero:".length));
    homeHeroDone.add(unit.slice("hhero:".length));
  } else if (unit.startsWith("hrail:")) {
    const [, kind, lang, id] = unit.split(":");
    await loadHomeRail(kind, lang, id);
  } else {
    const [prefix, tab, lang] = unit.split(":");
    if (tab === "live") await loadLiveTab();
    else await loadVodTab(tab, lang, { home: prefix === "home" });
  }
}
function tabData(tab, lang, state = {}) {
  if (tab === "live") {
    if (liveFeedData) return liveFeedData;
    const m2 = memo2.get("live");
    if (m2) return m2;
    const snap2 = readSnap("live", "-");
    return snap2 ? { slides: [], rails: cleanRails(snap2.rails, langNow()), langs: [], lang: null, partial: false, stale: true } : null;
  }
  if (tab !== "home") {
    const feedTab = feedTabFor(tab, lang);
    const fromFeed = feedTab ? { slides: (feedTab.slides || []).slice(0, FEATURED), rails: feedTab.rows, cats: feedTab.cats || [], langs: homeLangsList, lang, partial: false, hasMore: false } : null;
    const snap2 = !memo2.get(`${tab}:${lang}`) && !fromFeed ? readSnap(tab, lang) : null;
    const fromSnap = snap2 ? { slides: (snap2.slides || []).slice(0, FEATURED), rails: snap2.rails, cats: [], langs: homeLangsList, lang, partial: false, hasMore: false, stale: true } : null;
    const base = memo2.get(`${tab}:${lang}`) || fromFeed || fromSnap;
    const one = base && state.cat ? onlyCat.get(`${tab}:${lang}:${state.cat}`) : null;
    return one ? { ...base, rails: one.rails, hasMore: false, catSel: state.cat } : base ? { ...base, catSel: "" } : null;
  }
  const rnd = (rows) => randomizeHome(rows, homeSeed);
  const feed = homeFeedData.get(lang);
  if (feed) return { slides: (feed.slides || []).slice(0, FEATURED), rails: rnd(feed.rows), langs: homeLangsList || feed.langs, lang, partial: false };
  const plan = homePlan.get(lang) || [];
  const m = homeRails.get(lang);
  const freshRails = m ? plan.map((p) => m.get(`${p.kind}:${p.id}`)).filter((e) => e && e.card).map((e) => e.card) : [];
  const allDone = homePlan.has(lang) && plan.length > 0 && m && m.size >= plan.length;
  const fresh = () => ({ slides: (homeSlides.get(lang) || []).slice(0, FEATURED), rails: allDone ? rnd(freshRails) : freshRails, langs: homeLangsList, lang, partial: false });
  const snap = readHomeSnap(lang);
  if (snap && !allDone) return { slides: (snap.slides || []).slice(0, FEATURED), rails: rnd(snap.rails), langs: homeLangsList, lang, partial: false, stale: true };
  if (freshRails.length) return fresh();
  if (snap) return { slides: (snap.slides || []).slice(0, FEATURED), rails: rnd(snap.rails), langs: homeLangsList, lang, partial: false, stale: true };
  return null;
}
var tabOf2 = (state, route) => {
  const a = route && route.args && typeof route.args === "object" ? route.args : {};
  return TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS.includes(a.tab) ? a.tab : storedTab() || TAB_IDS[0];
};
var dbgLastView = "";
function mainView(ctx) {
  const state = ctx.state || {};
  if (!serverChosen()) {
    const f = state.failed || {};
    if (!raceTried) return verifyingView({ device: ctx.device });
    if (!healthReady() && !f.health) return verifyingView({ device: ctx.device });
    if (!autoPickTried && !f.autopick) return verifyingView({ device: ctx.device });
    return firstPickView({ servers: pickServers, failed: !!f.pick, device: ctx.device });
  }
  const tab = tabOf2(state, ctx.route);
  const lang = wantedLang(state);
  const data = tabData(tab, lang, state);
  {
    const sig = tab + "|" + lang + "|" + (data ? data.stale ? "snap" : "data:" + (data.rails || []).length : "null") + "|" + (homeFeedData.has(lang) ? "feed" : "nofeed");
    if (sig !== dbgLastView) {
      dbgLastView = sig;
      console.log("[dbg] view tab=" + tab + " lang=" + lang + " data=" + (data ? data.stale ? "SNAPSHOT" : "rails=" + (data.rails || []).length : "NULL(skeleton)") + " feedForLang=" + homeFeedData.has(lang) + " movieFeedTab=" + !!feedTabFor("movies", lang));
    }
  }
  if (!data && !pickedNow && unitsFor(tab, lang).includes("hcheck") && !isDone("hcheck") && !(state.failed && state.failed.hcheck)) return verifyingView({ device: ctx.device });
  const failed = unitsFor(tab, lang).some((u) => state.failed && state.failed[u]);
  return browseView({
    tab,
    data,
    recent: recentCards || [],
    country: countryCards || [],
    loading: pendingUnit(state, tab, ctx.device) !== null,
    failed: !data && failed,
    // Con una pestaña del feed a la vista (Inicio/Películas/Series), se re-baja cada 30 min por si el Action publicó uno nuevo.
    refresh: tab !== "live" && homeFeedData.has(lang),
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
var TICK_BUDGET_MS = 1200;
var CHEAP_MS = 600;
var INDEX_STEP_MS = 900;
function unitCost(unit) {
  if (unit === "recent") return recentLookups() * 300;
  if (unit === "lfeed" || unit.startsWith("hfeed:")) return 300;
  if (unit === "hcheck") return 400;
  if (unit.startsWith("hplan:")) return categoriesCached("vod") && categoriesCached("series") ? 0 : 600;
  if (unit.startsWith("hrail:")) return 600;
  return 1e3;
}
function recentLookups() {
  const key = serverKey();
  let n = 0;
  for (const e of recentEntriesAll()) if (!e.card && e.srv === key) n++;
  return Math.min(n, 6);
}
var FIRST_RUN_BUDGET_MS = 16e3;
var FIRST_FEED_RESERVE_MS = 4e3;
var FIRST_FEED_MIN_MS = 2500;
var FIRST_HEALTH_MIN_MS = 1e4;
function fitsFirstRun(unit, until) {
  const left = until - Date.now();
  if (serverChosen()) return (unit === "lfeed" || unit.startsWith("hfeed:")) && left >= FIRST_FEED_MIN_MS;
  if (unit === "health") return left >= FIRST_HEALTH_MIN_MS;
  if (unit === "autopick") return true;
  if (unit === "pick") return serverListFresh();
  return false;
}
var cardsOf = (items) => (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === "string" && typeof i.ref === "string").slice(0, CHANNELS_CAP).map(cardOf);
var bump = (state) => ({ n: (state.n || 0) + 1 });
var homeSeed = Math.random() * 2147483647 | 0;
var newHomeSeed = () => {
  homeSeed = Math.random() * 2147483647 | 0;
};
function mulberry32(a) {
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffleSeeded(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
function randomizeHome(rows, seed) {
  return shuffleSeeded(rows, seed).map((r, i) => r && Array.isArray(r.items) ? { ...r, items: shuffleSeeded(r.items, seed + (i + 1) * 1013904223 | 0) } : r);
}
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
    newHomeSeed();
    return { state: { tab: tabOf2(state, route), lang: wantedLang(state), ...bump(state), failed: null } };
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
    const tab = tabOf2(state);
    const lang = wantedLang(state);
    for (const u of unitsFor(tab, lang)) {
      const key = memoKey(u);
      if (memo2.has(key) && memo2.get(key).partial) memo2.delete(key);
    }
    return { state: { failed: null, ...bump(state) } };
  },
  async vcat({ value, arg, state }) {
    const tab = tabOf2(state);
    if (tab === "live" || tab === "home") return null;
    const id = typeof arg === "string" ? arg : typeof value === "string" ? value : "";
    if (id === "" || id === "all") return { state: { cat: null, ...bump(state) } };
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
    const tab = tabOf2(state);
    if (tab === "live" || tab === "home") return null;
    const lang = wantedLang(state);
    const m = memo2.get(`${tab}:${lang}`);
    if (!m || !m.hasMore) return null;
    await loadVodTab(tab, lang, { offset: m.next });
    cacheKey = serverKey();
    return { state: { ...bump(state) } };
  },
  async tick({ state, device }) {
    const tab = tabOf2(state);
    let unit = pendingUnit(state, tab, device);
    if (!unit) return null;
    const failed = { ...state.failed || {} };
    const t0 = Date.now();
    const until = serverChosen() ? 0 : t0 + FIRST_RUN_BUDGET_MS;
    console.log("[dbg] tick start tab=" + tab + " wantedLang=" + wantedLang(state) + " storedLang=" + String(getStored(LANG_KEY)) + " unit=" + unit + " plan=[" + unitsFor(tab, wantedLang(state)).join(",") + "] feedLangs=[" + [...homeFeedData.keys()].join(",") + "] tried=[" + [...homeFeedTried].join(",") + "] server=" + serverKey() + " healthReady=" + healthReady());
    for (; ; ) {
      const t1 = Date.now();
      try {
        await runUnit(unit, { until });
      } catch (_) {
        failed[unit] = true;
      }
      console.log("[dbg] unit " + unit + " tab=" + tab + " " + (Date.now() - t1) + "ms" + (failed[unit] ? " FAILED" : ""));
      const next = pendingUnit({ ...state, failed }, tab, device);
      if (!next || next === unit) break;
      if (until) {
        if (!fitsFirstRun(next, until)) break;
      } else if (unitCost(next) > CHEAP_MS || Date.now() - t0 + unitCost(next) > TICK_BUDGET_MS) break;
      unit = next;
    }
    cacheKey = serverKey();
    return { state: { ...bump(state), failed } };
  },
  // Sesión larga: cada 30 min (browseView) vuelve a bajar el feed del Home por si el Action publicó uno nuevo. Nunca falla
  // la vista: si no hay feed nuevo o el servidor cambió, se queda con lo que ya mostraba.
  async hrefresh({ state }) {
    const lang = wantedLang(state);
    if (!homeFeedData.has(lang)) return null;
    let feed = null;
    try {
      feed = await fetchHomeFeed(serverKey(), lang);
    } catch (_) {
      feed = null;
    }
    if (!feed || !feed.rows.length) return null;
    const key = feed.lang && isLang(feed.lang) ? feed.lang : lang;
    const cur = homeFeedData.get(key);
    if (cur && cur.rows.length === feed.rows.length && JSON.stringify(cur.rows[0]) === JSON.stringify(feed.rows[0])) return null;
    homeFeedData.set(key, { slides: feed.slides || [], rows: feed.rows, langs: feed.langs || [], movies: feed.movies || null, series: feed.series || null });
    if (Array.isArray(feed.langs) && feed.langs.length) homeLangsList = feed.langs;
    writeTabSnap("home", key, feed.slides, feed.rows);
    if (feed.movies) writeTabSnap("movies", key, feed.movies.slides, feed.movies.rows);
    if (feed.series) writeTabSnap("series", key, feed.series.slides, feed.series.rows);
    return { state: { ...bump(state) } };
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
  // Elegido un servidor en el selector de la primera vez: lo fija, lo recuerda y manda al Home (que ya carga con ese servidor).
  // Si no respondió, se queda en el selector (con el aviso) para elegir otro.
  async "srv.first"({ arg, state, lang }) {
    const r = await selectServer(arg);
    if (r.ok) {
      resetCaches();
      cacheKey = serverKey();
      markServerChosen();
    }
    return { state: { ...bump(state), failed: null }, toast: { text: say(r.ok ? "srvSelected" : "srvSelectFail", lang, { host: r.host || r.label || "" }), role: r.ok ? "success" : "error" } };
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

// src/plugin.js
var once = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } finally {
    flush();
  }
};
var home2 = once(home);
var browse2 = once(browse);
var search2 = once(search);
var episodes2 = once(episodes);
var resolve2 = once(resolve);
var liveCategories2 = once(liveCategories);
var liveChannels2 = once(liveChannels);
var liveSearch2 = once(liveSearch);
var guide2 = once(guide);
var settingsStatus2 = once(settingsStatus);
var action2 = once(action);
var screen2 = once(screen);
var screenEvent2 = once(screenEvent);
var section3 = once(section2);
export {
  action2 as action,
  browse2 as browse,
  episodes2 as episodes,
  guide2 as guide,
  home2 as home,
  liveCategories2 as liveCategories,
  liveChannels2 as liveChannels,
  liveSearch2 as liveSearch,
  resolve2 as resolve,
  screen2 as screen,
  screenEvent2 as screenEvent,
  search2 as search,
  section3 as section,
  settingsStatus2 as settingsStatus
};
