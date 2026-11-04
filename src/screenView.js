// Los árboles de la pantalla de Ultra Hd: funciones puras sobre lo que screen.js guarda en memoria. Sin red.
import { twin } from "./i18n.js";
import { LOGO_DATA } from "./logo.js";
import { LANG_LABELS } from "./names.js";

export const TAB_IDS = ["home", "movies", "series", "live"];
const TAB_KEYS = { home: "tabHome", movies: "tabMovies", series: "tabSeries", live: "tabLive" };
const POLL_MS = 1_500;
const GRID_CAP = 60;
const MAX_SLIDES = 6;
const MAX_SLIDE_TEXT = 160;
const HTTPS = /^https:\/\//;
export const PRESS_MS = 30_000;

export function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind };
  const poster = item.poster || item.logo;
  if (poster && HTTPS.test(poster)) out.poster = poster;
  if (item.backdrop && HTTPS.test(item.backdrop)) out.backdrop = item.backdrop;
  if (item.adult === true) out.adult = true;
  if (typeof item.rating === "number") out.rating = item.rating;
  if (item.ids) out.ids = item.ids;
  if (item.overview) out.overview = item.overview;
  return out;
}

export function slidesOf(rails) {
  const out = [];
  const seen = new Set();
  for (const rail of rails) {
    for (const item of rail.items) {
      if (out.length >= MAX_SLIDES) return out;
      const image = item.backdrop && HTTPS.test(item.backdrop) ? item.backdrop : null;
      const text = typeof item.overview === "string" ? item.overview.trim() : "";
      if (item.adult === true || seen.has(item.id) || !image || !HTTPS.test(image) || text === "") continue;
      seen.add(item.id);
      out.push({
        id: item.id, ref: item.ref, kind: item.kind, title: item.title, image,
        text: text.length <= MAX_SLIDE_TEXT ? text : `${text.slice(0, MAX_SLIDE_TEXT - 1).trimEnd()}…`,
      });
    }
  }
  return out;
}

const slim = (card) => {
  const { overview, ...rest } = card;
  return rest;
};

const railSkeleton = (n) => ({
  type: "Column", key: "skel" + n, gap: 8, children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 12, sizes: ["compact"], children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}c${i}`, flex: 1 })) },
    { type: "Row", gap: 12, sizes: ["medium", "expanded"], children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}w${i}`, flex: 1 })) },
  ],
});

const gridSkeleton = () => ({
  type: "Column", key: "gridSkeleton", gap: 12, children: [
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["compact"], key: `gc${r}`, children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `gc${r}-${i}`, flex: 1 })) })),
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["medium", "expanded"], key: `gw${r}`, children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `gw${r}-${i}`, flex: 1 })) })),
  ],
});

const slideNode = (s) => ({
  type: "heroCard", key: "slide-" + s.id, h: { compact: 200, expanded: 240 }, title: s.title, text: s.text, image: s.image,
  buttons: [
    { type: "ElevatedButton", key: "watch-" + s.id, ...twin("watch", "labelText"), icon: "play",
      onPressed: { go: { play: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } } },
    { type: "TextButton", key: "info-" + s.id, ...twin("info", "labelText"),
      onPressed: { go: { title: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } } },
  ],
});

// La clave lleva el número de slides: el paginador de Kino conserva la cuenta de su primer dibujo.
const hero = (slides) => (slides.length === 1 ? slideNode(slides[0]) : {
  type: "PageView", key: "hero" + slides.length, autoPlayMs: 6_000, children: slides.map(slideNode),
});

const brandText = () => ({ type: "Text", key: "brandText", text: "Ultra Hd", textEn: "Ultra Hd", style: "h4" });
const title = () => ({
  type: "Row", key: "brand", gap: 8, crossAxisAlignment: "center",
  children: [{ type: "Image", key: "logo", url: LOGO_DATA, aspect: "1:1", fit: "contain", h: 32, alt: "Ultra Hd", altEn: "Ultra Hd" }, brandText()],
});

const tabBar = (active) => ({
  type: "TabBar", key: "tabs", divider: false, value: active, onChanged: "tab",
  tabs: TAB_IDS.map((id) => ({ value: id, ...twin(TAB_KEYS[id], "label") })),
});

const langChips = (langs, lang) => ({
  type: "Chips", key: "langChips", value: lang, onChanged: "lang",
  options: langs.map((l) => ({ value: l, label: LANG_LABELS[l][0], labelEn: LANG_LABELS[l][1] })),
});

const roundChannel = (c, n) => ({
  type: "Column", key: "ch-" + n, w: 120, gap: 8, crossAxisAlignment: "center",
  onTap: { go: { play: { ref: c.ref, kind: "live", id: c.id, title: c.title } } },
  children: [
    { type: "CircleAvatar", key: "chl-" + n, radius: 44, ...(c.poster ? { image: c.poster } : { text: String(c.title).slice(0, 2).toUpperCase() }), labelText: c.title, labelTextEn: c.title },
    { type: "Text", text: c.title, textEn: c.title, style: "caption", maxLines: 1, textAlign: "center" },
  ],
});

const roundRail = (items, key, titleProps) => ({
  type: "Column", key, gap: 8, children: [
    { type: "Text", ...titleProps, style: "h4" },
    { type: "SingleChildScrollView", key: key + "Scroll", direction: "horizontal", children: [{ type: "Row", gap: 24, children: items.slice(0, 20).map(roundChannel) }] },
  ],
});

const rail = (r, key, titleProps) => ({
  type: "titleRail", key, ...(titleProps || { title: r.title, titleEn: r.title }), ...(r.ref ? { ref: r.ref } : {}), items: r.items.map(slim), size: "medium",
});

const barButton = (key, icon, labelKey, onPressed) => ({ type: "IconButton", key, icon, ...twin(labelKey, "labelText"), ...twin(labelKey, "tooltip"), onPressed });

/**
 * `data`: { slides, rails } del tab activo o null. `recent`: tarjetas. `country`: tarjetas de la fila de tu país.
 * `loading`: algo falta por cargar (el temporizador solo corre entonces). `failed`: el tab activo no cargó.
 */
export function browseView({ tab, data, recent, country, loading, failed, device = "phone" }) {
  const tv = device === "tv";
  const active = TAB_IDS.includes(tab) ? tab : TAB_IDS[0];
  const body = [];
  const chips = data && data.langs && data.langs.length > 1 && active !== "live" ? langChips(data.langs, data.lang) : null;
  if (chips) body.push(chips);
  if (data && data.cats && data.cats.length > 1 && active !== "live" && active !== "home") {
    body.push({ type: "DropdownButton", key: "vcat", ...twin("category", "labelText"), value: data.catSel || "", onChanged: "vcat",
      options: [{ value: "", ...twin("allCats", "label") }, ...data.cats.slice(0, 200).map((c) => ({ value: c.id, label: c.title, labelEn: c.title }))] });
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
      type: "AppBar", divider: false, mergeWithKinoBar: true, dense: true,
      leading: barButton("close", "close", "close", { go: { close: true } }),
      title: tv ? { type: "Row", key: "titleRow", gap: 24, crossAxisAlignment: "center", children: [title(), tabBar(active)] } : title(),
      actions: [
        ...(tv ? [barButton("searchButton", "search", "search", "openSearch")] : []),
        barButton("liveButton", "tv", "live", { event: "go", arg: "live" }),
        barButton("settings", "settings", "settings", { event: "go", arg: "settings" }),
      ],
    },
    ...(tv ? {} : { floatingActionButton: { type: "FloatingActionButton", key: "searchFab", icon: "search", ...twin("search", "tooltip"), onPressed: "openSearch" } }),
    body: { type: "Column", key: "page", children: [
      ...(tv ? [] : [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(active)] }]),
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ] },
    ...(loading ? { every: { ms: POLL_MS, event: "tick" } } : {}),
  };
}

const searchForm = (tv, query, key, field, event, hintKey, goKey) => ({
  type: "Form", key, onSubmitted: event, gap: 8, children: tv
    ? [{ type: "Row", key: key + "Row", gap: 16, crossAxisAlignment: "center", children: [
      { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: field === "q", onSubmitted: event, weight: 1 },
      { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true },
    ] }]
    : [
      { type: "TextField", key: field, kind: "text", value: query, ...twin(hintKey, "labelText"), maxLength: 100, autofocus: field === "q", onSubmitted: event },
      { type: "ElevatedButton", key: goKey, ...twin("search", "labelText"), icon: "search", submit: true },
    ],
});

const backBar = (tv, extra) => ({
  type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false,
  leading: barButton("back", "arrow_back", "back", "back"),
  ...extra,
});

export function searchView({ query, status, items, enriching = false, partial = false, history = [], device = "phone" }) {
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
    ...(status === "loading" ? { every: { ms: 1_000, event: "stick" } } : enriching ? { every: { ms: 1_500, event: "senrich" } } : {}),
  };
}

export function liveView({ cats, cat, items, query = "", searching = false, partial = false, failed = false, device = "phone" }) {
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
    ...(!failed && (searching || (query === "" && (!cats || !items))) ? { every: { ms: 1_000, event: "ltick" } } : {}),
  };
}

const text = (key, extra = {}, vars) => ({ type: "Text", ...twin(key, "text", vars), ...extra });
const caption = (key, extra = {}, vars) => text(key, { style: "caption", color: "muted", ...extra }, vars);
const section = (key) => text(key, { style: "h4" });
const press = (event, arg) => ({ event, ...(arg !== undefined ? { arg } : {}), timeoutMs: PRESS_MS });

export function settingsView({ srv, busy, pluginVersion, appVersion, device }) {
  const status = !srv ? { badge: "checking", sub: null }
    : !srv.host ? { badge: "setServerNone", sub: null }
      : { badge: srv.ok ? "setServerOk" : "setServerDown", sub: srv.total ? twin("setServerPos", "subtitle", { i: srv.index, n: srv.total }) : null };
  const deviceName = device === "tv" ? ["televisor", "TV"] : device === "desktop" ? ["computador", "desktop"] : ["teléfono", "phone"];
  const rows = [
    ["aboutPlugin", [pluginVersion, pluginVersion]],
    ["aboutKino", [appVersion || "?", appVersion || "?"]],
    ["aboutDevice", deviceName],
  ].map(([k, v], n) => ({ type: "TableRow", key: "diag" + n, children: [
    { type: "TableCell", ...twin(k) },
    { type: "TableCell", text: v[0], textEn: v[1] },
  ] }));
  return {
    type: "Scaffold",
    appBar: backBar(device === "tv", { ...twin("setTitle", "title") }),
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [
      { type: "Card", key: "connCard", children: [
        section("setConnection"),
        caption("setConnectionHint"),
        { type: "ListTile", key: "serverRow", ...twin("setServer", "title"), ...(status.sub || {}), leading: { type: "Icon", name: "language" },
          trailing: { type: "Badge", ...twin(status.badge) } },
        { type: "Row", wrap: true, gap: 8, children: [
          { type: "ElevatedButton", key: "switchServer", ...twin("setSwitch", "labelText"), icon: "refresh", ...twin("setSwitchHint", "tooltip"), enabled: !busy, onPressed: press("srv.switch") },
          { type: "Button", variant: "secondary", key: "refreshServers", ...twin("setRefresh", "labelText"), icon: "download", ...twin("setRefreshHint", "tooltip"), enabled: !busy, onPressed: press("srv.refresh") },
          { type: "TextButton", key: "checkServer", ...twin("setCheck", "labelText"), enabled: !busy, onPressed: press("srv.check") },
        ] },
      ] },
      { type: "Card", key: "adultCard", children: [
        section("setAdultTitle"),
        caption("setAdultHint"),
        { type: "settings", key: "adultForm", keys: ["showAdult"], autoSave: true, onSaved: "saved" },
      ] },
      { type: "Card", key: "liveCard", children: [
        section("setLiveTitle"),
        caption("setLiveHint"),
        { type: "settings", key: "liveForm", keys: ["liveFormat"], autoSave: true, onSaved: "saved" },
      ] },
      { type: "Card", key: "homeCard", children: [
        section("setHomeTitle"),
        caption("setHomeHint"),
        { type: "settings", key: "homeForm", keys: ["homeCountry"], autoSave: true, onSaved: "saved" },
      ] },
      { type: "Card", key: "aboutCard", children: [
        section("setAbout"),
        { type: "DataTable", key: "aboutTable", columns: [{ flex: 2 }, { flex: 3 }], wrap: true, zebra: true, children: rows },
      ] },
    ] }] },
    ...(!srv ? { every: { ms: 1_000, event: "sstatus" } } : {}),
  };
}
