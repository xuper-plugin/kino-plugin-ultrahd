// Pruebas del índice de títulos (src/titleIndex.js) y del TMDB perezoso (src/tmdbLazy.js) con el kino.catalog y el
// kino.tmdb del kit, en un solo proceso y sin red: el repo de datos se sirve desde memoria (generado con el generador del repo
// hermano, UHD_DATA) y TMDB responde desde un fixture.   node scripts/test-index.mjs
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataRepo = resolve(process.env.UHD_DATA || join(root, "..", "kino-plugin-ultrahd-data"));
if (!existsSync(join(dataRepo, "scripts", "gen-index.mjs"))) { console.log("sin repo de datos hermano: se omiten las pruebas del índice"); process.exit(0); }
const gen = await import(pathToFileURL(join(dataRepo, "scripts", "gen-index.mjs")).href);
const { createKino } = await import(pathToFileURL(join(root, "sdk", "kino-shim.mjs")).href);
const { validateManifest } = await import(pathToFileURL(join(root, "sdk", "contract.mjs")).href);

const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
assert.ok(checked.ok, "manifiesto inválido");
const tmp = mkdtempSync(join(tmpdir(), "uhd-idx-"));

// ---- fixture de TMDB: "<path>?<params ordenados>" ----
const tmdbFixture = {};
const fxKey = (path, params) => `${path}?${Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&")}`;
const tmdbParams = (name, year, tv) => ({ include_adult: false, language: "es-MX", query: name, ...(year ? { [tv ? "first_air_date_year" : "year"]: year } : {}) });
const fixtureFor = (name, year, tv, results) => { tmdbFixture[fxKey(tv ? "/search/tv" : "/search/movie", tmdbParams(name, year, tv))] = { results }; };

const { kino: rawKino } = createKino(checked.manifest, { storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: { ...process.env }, tmdbFixture });
// El objeto kino del kit está congelado: un Proxy deja interceptar fetch y catalog en las pruebas.
const cat = { ...rawKino.catalog };
let noCatalog = false;
let noTmdb = false;
let tmdbCalls = 0;
let tmdbLimitAt = Infinity; // simula el límite de la clave de Kino (20 cada 10 s)
let fakeFetch = null;
const kino = new Proxy({ ...rawKino }, {
  get(t, k) { if (k === "fetch") return fakeFetch; if (k === "catalog") return noCatalog ? undefined : cat; if (k === "tmdb") { if (noTmdb) return undefined; return async (p, q) => { if (++tmdbCalls > tmdbLimitAt) throw Object.assign(new Error("demasiadas llamadas"), { code: "rate_limited" }); return t.tmdb(p, q); }; } return t[k]; },
  has(t, k) { return k === "catalog" ? !noCatalog : k in t; },
});
globalThis.kino = kino;

// ---- el repo de datos, en memoria ----
let served = new Map();
const fetched = [];
let onFetch = null;
fakeFetch = async (url) => {
  const file = String(url).slice("https://data.test/".length).split("?")[0];
  fetched.push(file);
  if (onFetch) { const r = await onFetch(file); if (r) return r; }
  const text = served.get(file);
  if (text === undefined) return { ok: false, status: 404, json() { throw new Error("404"); }, text() { return ""; } };
  return { ok: true, status: 200, json: () => JSON.parse(text), text: () => text };
};

const idx = await import(pathToFileURL(join(root, "src", "titleIndex.js")).href);
idx.__setBase("https://data.test/");
const lazy = await import(pathToFileURL(join(root, "src", "tmdbLazy.js")).href);
const store = await import(pathToFileURL(join(root, "src", "store.js")).href);

// ---- publicación por revisiones (la misma lógica del generador) ----
let pub = null;
let genClock = Date.parse("2026-10-01T07:17:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const entryOf = (kind, name, year, cats, tmdb = 0) => ({ kind, name, find: gen.findKey(name), year, tmdb, cats: new Set(cats) });
const keyOf = (e) => e.kind + ":" + gen.keyOf(e.find, e.year);
const mapOf = (list) => new Map(list.map((e) => [keyOf(e), e]));
function publish(entries, { fullAt } = {}) {
  genClock += 86400000;
  const generated = iso(genClock);
  const o = gen.buildRevision({ entries, prev: pub, coverage: 0.99, generated, fullAt: fullAt || generated, categoriesJson: "{}" });
  if (o.changed) { served = new Map(o.files); pub = { manifest: o.manifest, entries, files: o.files }; }
  return o;
}
const movies = (n, from = 0) => Array.from({ length: n }, (_, i) => entryOf("movies", `Película de relleno número ${from + i}`, 1980 + ((from + i) % 45), [1100 + ((from + i) % 7)]));
const clone = (m) => new Map([...m].map(([k, e]) => [k, { ...e, cats: new Set(e.cats) }]));
const stateOf = () => JSON.parse(kino.storage.get("idx:state") || "null");
const setState = (f) => { const s = stateOf(); f(s); kino.storage.set("idx:state", JSON.stringify(s)); };
const age = (ms = 2 * 86400000) => setState((s) => { s.checked = Date.now() - ms; s.retryAt = 0; });
const run = (opts) => idx.indexStep({ budgetMs: 120000, ...opts });
const dl = () => fetched.slice();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("✓", name); };
const table = [];
const measure = async (label, fn) => {
  idx.resetIndexStats();
  fetched.length = 0;
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  const s = idx.indexStats();
  table.push({ label, result: r, downloads: fetched.length, upserted: s.upserted, removed: s.removed, ms: Math.round(ms) });
  return r;
};

await test("nombres e ids: cleanTitle/findKey/idOf del plugin coinciden con los del generador", () => {
  for (const [raw, y] of [["Spider-Man: Sin camino a casa (LAT) (2021)", "2021"], ["Acción Total (CAST)", "1990"], ["Fantasía 2000 (LAT)", ""], ["Dark [CAST]", ""], ["007: Skyfall (ENG) (2012)", ""], ["Государственные похороны (LAT) (2019)", "2019"], ["  Hola   mundo (2020) ", ""]]) {
    assert.deepEqual(idx.cleanTitle(raw, y), gen.cleanTitle(raw, y), raw);
    assert.equal(idx.findKey(raw), gen.findKey(raw));
    const { name, year } = gen.cleanTitle(raw, y);
    assert.equal(idx.idOf("movies", gen.findKey(name), year), gen.idOf("movies", gen.findKey(name), year));
    assert.equal(idx.idOf("series", gen.findKey(name), year), gen.idOf("series", gen.findKey(name), year));
  }
});

await test("sin catálogo (Kino viejo) todo responde sin romper", async () => {
  noCatalog = true;
  assert.equal(await idx.indexStep(), "unsupported");
  assert.equal(await idx.indexSearch("spider"), null);
  assert.equal(idx.indexReady(), false);
  assert.deepEqual(await lazy.enrichTmdb([{ title: "X", kind: "movie" }]), 0);
  noCatalog = false;
});

// ============ el escenario grande: 40.000 películas ============
const N = 40000;
let live = mapOf(movies(N));
let rev1;
await test(`primera carga con el catálogo vacío: snapshot de ${N} títulos y queda listo`, async () => {
  rev1 = publish(live).manifest;
  assert.equal(await kino.catalog.count(), 0);
  assert.equal(await measure("1ª instalación (snapshot completo)", () => run()), "done");
  assert.equal(await kino.catalog.count(), N);
  assert.equal(idx.indexReady(), true);
  assert.equal(stateOf().rev, rev1.revision);
  assert.equal(fetched[0], "index.json");
  assert.deepEqual(fetched.slice(1).sort(), [...rev1.movies.parts, ...rev1.series.parts].sort());
});

await test("(a) día sin cambios: 0 descargas de datos (solo el manifiesto), 0 upserts", async () => {
  age();
  const r = await measure("(a) sin cambios", () => run());
  assert.equal(r, "fresh");
  assert.deepEqual(fetched, ["index.json"]);
  assert.equal(idx.indexStats().upserted, 0);
  assert.equal(await run(), "fresh");
});

let nextNew = N + 100000;
const editLive = (add, remove) => {
  live = clone(live);
  const keys = [...live.keys()];
  for (let i = 0; i < remove; i++) live.delete(keys[1000 + i * 7]);
  for (const e of movies(add, nextNew)) live.set(keyOf(e), e);
  nextNew += add;
};

await test("(b) delta pequeño (50 añadidos, 10 retirados): solo esos upserts y removes", async () => {
  editLive(50, 10);
  const o = publish(live);
  const dname = o.manifest.deltas.at(-1).file;
  age();
  const r = await measure("(b) delta +50 −10", () => run());
  assert.equal(r, "done");
  assert.deepEqual(fetched, ["index.json", dname]);
  assert.equal(idx.indexStats().upserted, 50);
  assert.equal(idx.indexStats().removed, 10);
  assert.equal(await kino.catalog.count(), N + 40);
  assert.equal(stateOf().rev, o.manifest.revision);
});

await test("(c) 3 revisiones de atraso: descarga solo los 3 deltas intermedios y los aplica en orden", async () => {
  const before = stateOf().rev;
  let expectedAdd = 0;
  let expectedRem = 0;
  const names = [];
  for (let i = 0; i < 3; i++) {
    const add = 20 + i;
    const rem = 5;
    editLive(add, rem);
    const o = publish(live);
    expectedAdd += add;
    expectedRem += rem;
    names.push(o.manifest.deltas.at(-1).file);
  }
  age();
  assert.equal(stateOf().rev, before);
  const r = await measure("(c) 3 revisiones atrás (3 deltas)", () => run());
  assert.equal(r, "done");
  assert.deepEqual(fetched, ["index.json", ...names]);
  assert.equal(idx.indexStats().upserted, expectedAdd);
  assert.equal(idx.indexStats().removed, expectedRem);
  assert.equal(await kino.catalog.count(), live.size);
  assert.equal(stateOf().rev, pub.manifest.revision);
});

await test("(d) 10 días de atraso: no hay cadena (solo se guardan 7 deltas) → snapshot completo y se retiran los títulos que ya no están", async () => {
  const before = stateOf().rev;
  let removedTotal = 0;
  for (let i = 0; i < 10; i++) { editLive(15, 4); removedTotal += 4; publish(live); }
  assert.equal(pub.manifest.deltas.length, 7);
  assert.ok(!pub.manifest.deltas.some((d) => d.from === before), "el plugin ya no está en la cadena");
  age();
  const r = await measure("(d) 10 días atrás (snapshot + purga)", () => run());
  assert.equal(r, "done");
  assert.ok(fetched.length > 1 + 7 - 7 && fetched.includes("index.json"));
  assert.ok(!fetched.some((f) => f.startsWith("delta-")), "no usa deltas");
  assert.equal(await kino.catalog.count(), live.size);
  assert.equal(stateOf().rev, pub.manifest.revision);
  // el catálogo es exactamente el índice: ni sobran ni faltan
  const sample = [...live.values()].slice(0, 3);
  for (const e of sample) assert.ok((await kino.catalog.get([idx.idOf("movies", e.find, e.year)])).length === 1);
  assert.ok(idx.indexStats().removed >= removedTotal - 0, `se retiraron ${idx.indexStats().removed}`);
});

await test("(e1) delta corrupto: cae al snapshot sin perder el catálogo bueno (nunca queda vacío)", async () => {
  editLive(30, 6);
  const o = publish(live);
  const dname = o.manifest.deltas.at(-1).file;
  const d = JSON.parse(served.get(dname));
  d.added[0] = { k: "m", n: "", y: 1, t: 0, c: [1] }; // entrada inválida
  served.set(dname, JSON.stringify(d));
  age();
  let min = Infinity;
  onFetch = async () => { min = Math.min(min, await kino.catalog.count()); return null; };
  const r = await measure("(e1) delta corrupto → snapshot", () => run());
  onFetch = null;
  assert.equal(r, "done");
  assert.ok(min >= live.size - 100, `el catálogo nunca se vació (mínimo ${min})`);
  assert.equal(await kino.catalog.count(), live.size);
  assert.equal(stateOf().rev, o.manifest.revision);
  assert.ok(fetched.includes(dname), "intentó el delta primero");
  assert.ok(fetched.some((f) => f.startsWith("movies-")), "y cayó al snapshot");
});

await test("(e2) delta ausente (404): reintenta una vez y cae al snapshot", async () => {
  editLive(10, 2);
  const o = publish(live);
  const dname = o.manifest.deltas.at(-1).file;
  served.delete(dname);
  age();
  assert.equal(await run(), "error");
  assert.equal(stateOf().done, true, "el catálogo bueno sigue sirviendo");
  assert.equal((await idx.indexSearch("relleno número 5")).items.length > 0, true);
  setState((s) => { s.retryAt = 0; });
  const r = await measure("(e2) delta ausente → snapshot", () => run());
  assert.equal(r, "done");
  assert.equal(await kino.catalog.count(), live.size);
  assert.equal(stateOf().rev, o.manifest.revision);
});

await test("catálogo incoherente tras un delta (cuenta distinta): cae al snapshot", async () => {
  editLive(5, 1);
  const o = publish(live);
  await kino.catalog.remove([idx.idOf("movies", [...live.values()][100].find, [...live.values()][100].year)]); // alguien borró una fila
  age();
  const r = await measure("incoherencia → snapshot", () => run());
  assert.equal(r, "done");
  assert.equal(await kino.catalog.count(), live.size);
  assert.equal(stateOf().rev, o.manifest.revision);
});

await test("el id de TMDB resuelto al vuelo no se pierde cuando un delta vuelve a subir ese título", async () => {
  const e = [...live.values()][500];
  const id = idx.idOf("movies", e.find, e.year);
  const row = (await kino.catalog.get([id]))[0];
  await kino.catalog.upsert([{ id, title: row.title, sort: row.sort, data: { ...idx.dataOf(row), t: 4242 } }]);
  live = clone(live);
  live.get(keyOf(e)).cats.add(1999); // cambia sus categorías → entra en el delta
  const o = publish(live);
  age();
  assert.equal(await run(), "done");
  const after = (await kino.catalog.get([id]))[0];
  assert.equal(idx.dataOf(after).t, 4242);
  assert.ok(idx.dataOf(after).c.includes(1999));
  assert.ok(o.changed);
});

// ============ casos funcionales con datos pequeños ============
await test("búsqueda: sin acentos, palabras en cualquier orden, tipo y orden por año; ids y refs válidos", async () => {
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  pub = null;
  const small = mapOf([
    entryOf("movies", "Spider-Man: Sin camino a casa", 2021, [1147, 1126], 0), entryOf("movies", "El paseo 8", 2025, [1147]), entryOf("movies", "Acción Total", 1990, [1126]),
    entryOf("movies", "Spider-Man", 2002, [1126]), entryOf("series", "La casa de papel", 2017, [684]), entryOf("series", "Dark", 2017, [684]),
  ]);
  publish(small);
  assert.equal(await run(), "done");
  assert.deepEqual((await idx.indexSearch("accion")).items.map((i) => i.title), ["Acción Total"]);
  const s = await idx.indexSearch("spider man");
  assert.deepEqual(s.items.map((i) => i.title), ["Spider-Man: Sin camino a casa", "Spider-Man"]);
  assert.equal((await idx.indexSearch("man spider")).items.length, 2);
  assert.equal((await idx.indexSearch("casa", "series")).items.length, 1);
  assert.equal((await idx.indexSearch("casa", "movie")).items.length, 1);
  assert.equal((await idx.indexSearch("zzzz")).items.length, 0);
  assert.match(s.items[0].id, /^m-[a-z0-9]{2,26}$/);
  assert.match(s.items[0].ref, /^idx:m:spider man sin camino a casa\|2021\|1126,1147$/);
  assert.equal(s.items[0].year, "2021");
});

await test("abrir un resultado: el id real se pide en vivo solo a las categorías del título", async () => {
  const asked = [];
  const cats = { 1126: [{ stream_id: 11, name: "Spider-Man: Sin camino a casa (LAT) (2021)", year: "2021", container_extension: "mkv" }], 1147: [] };
  const fetchCategory = async (action, id) => { asked.push(action + ":" + id); if (!(id in cats)) throw new Error("rate"); return cats[id]; };
  assert.equal(await idx.resolveIdxRef("idx:m:spider man sin camino a casa|2021|1147,1126", fetchCategory), "vod:11:mkv");
  assert.deepEqual(asked, ["get_vod_streams:1147", "get_vod_streams:1126"]);
  assert.equal(await idx.resolveIdxRef("idx:s:dark|2017|684", async () => [{ series_id: 99, name: "Dark (LAT)", release_date: "2017-12-01" }]), "series:99");
  await assert.rejects(idx.resolveIdxRef("idx:m:otra cosa|2000|1126", fetchCategory), (e) => e.code === "not_found");
  await assert.rejects(idx.resolveIdxRef("idx:m:x|2000|5", async () => { throw new Error("x"); }), (e) => e.code === "unavailable");
  await assert.rejects(idx.resolveIdxRef("idx:m:basura", fetchCategory), (e) => e.code === "not_found");
});

await test("reintentos: la primera instalación prueba 3 veces; sin red queda 'error' y espera antes de reintentar", async () => {
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  let n = 0;
  onFetch = async (f) => (f === "index.json" && n++ < 2 ? { ok: false, status: 503, json() { throw new Error("503"); }, text() { return ""; } } : null);
  fetched.length = 0;
  assert.equal(await run(), "done");
  assert.equal(fetched.filter((f) => f === "index.json").length, 3);
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  onFetch = async () => ({ ok: false, status: 503, json() { throw new Error("503"); }, text() { return ""; } });
  fetched.length = 0;
  assert.equal(await run(), "error");
  assert.equal(fetched.length, 3);
  assert.equal(await run(), "wait");
  assert.equal(idx.indexReady(), false);
  onFetch = null;
  setState((s) => { s.retryAt = 0; });
  assert.equal(await run(), "done");
});

await test("índice dañado: no reemplaza al bueno (manifiesto con cobertura baja, versión ajena, sin revisión)", async () => {
  const before = await kino.catalog.count();
  for (const bad of [{ coverage: 0.5 }, { v: 2 }, { revision: "mala" }, { movies: { count: 1, parts: ["x.json"], hashes: [] } }]) {
    const mm = JSON.parse(served.get("index.json"));
    served.set("index.json", JSON.stringify({ ...mm, ...bad }));
    age();
    assert.notEqual(await run(), "done");
    assert.equal(await kino.catalog.count(), before);
    assert.equal(idx.indexReady(), true);
  }
});

await test("copia de seguridad restaurada: el estado dice 'indexado' pero el catálogo está vacío → se reconstruye", async () => {
  publish(mapOf(movies(30)));
  age(1000);
  await kino.catalog.clear();
  assert.equal(await idx.indexSearch("relleno"), null, "catálogo vacío: cae a la búsqueda en vivo");
  assert.equal(idx.indexReady(), false);
  assert.equal(await run(), "done");
  assert.equal(await kino.catalog.count(), 30);
});

await test("reanudable: con poco tiempo queda en pausa y retoma donde iba (idempotente)", async () => {
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  pub = null;
  publish(mapOf(movies(1300)));
  const r1 = await idx.indexStep({ budgetMs: 2600 });
  assert.ok(["paused", "done"].includes(r1), r1);
  let guard = 0;
  while (!idx.indexReady() && guard++ < 20) await run({ budgetMs: 2600 });
  assert.equal(await kino.catalog.count(), 1300);
  assert.equal(await run(), "fresh");
});

await test("tope de 100.000: al recibir 'limit' se queda con lo que cupo y se marca capped", async () => {
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  pub = null;
  publish(mapOf(movies(1300)));
  const upsert = cat.upsert;
  let calls = 0;
  cat.upsert = async (items) => { if (++calls > 2) { const e = new Error("full"); e.code = "limit"; throw e; } return upsert(items); };
  assert.equal(await run(), "done");
  cat.upsert = upsert;
  assert.equal(stateOf().capped, true);
  assert.ok(await kino.catalog.count() <= 1000);
});

// ============ TMDB perezoso ============
const T = (title, year, kind = "movie") => ({ title, year: String(year), kind });
await test("TMDB: sin kino.tmdb, o sin clave en esa Kino, el camino queda inactivo sin errores", async () => {
  noTmdb = true;
  assert.equal(await lazy.enrichTmdb([T("Algo", 2020)]), 0);
  noTmdb = false;
  lazy.resetTmdbStats();
  const items = [T("Sin fixture", 2020)];
  assert.equal(await lazy.enrichTmdb(items), 0, "el fixture no lo tiene → not_found, sin lanzar");
  assert.equal(items[0].ids, undefined);
});

await test("TMDB: consulta solo lo que no está en caché, acepta solo coincidencias seguras y cada título se consulta una vez", async () => {
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  kino.storage.remove("tmdb:cache");
  pub = null;
  publish(mapOf([entryOf("movies", "Spider-Man: Sin camino a casa", 2021, [1147]), entryOf("movies", "El paseo 8", 2025, [1147]), entryOf("series", "Dark", 2017, [684])]));
  assert.equal(await run(), "done");
  fixtureFor("Spider-Man: Sin camino a casa", 2021, false, [{ id: 1, title: "Otra cosa", release_date: "2021-01-01" }, { id: 634649, title: "Spider-Man: Sin camino a casa", release_date: "2021-12-15" }]);
  fixtureFor("El paseo 8", 2025, false, [{ id: 7, title: "Algo distinto", release_date: "2025-02-02" }, { id: 8, title: "Otro más", release_date: "2025-02-02" }]); // ambiguo → sin coincidencia
  fixtureFor("Dark", 2017, true, [{ id: 70523, name: "Dark", original_name: "Dark", first_air_date: "2017-12-01" }]);
  fixtureFor("Película que no está en el catálogo", 2023, false, [{ id: 999, title: "Película que no está en el catálogo", release_date: "2023-05-05" }]);
  lazy.resetTmdbStats();
  const items = [T("Spider-Man: Sin camino a casa (LAT)", 2021), T("El paseo 8", 2025), T("Dark", 2017, "series"), T("Película que no está en el catálogo", 2023)];
  const t0 = performance.now();
  assert.equal(await lazy.enrichTmdb(items), 3);
  const ms = Math.round(performance.now() - t0);
  assert.deepEqual(items.map((i) => (i.ids || {}).tmdb), [634649, undefined, 70523, 999]);
  let s = lazy.tmdbStats();
  assert.equal(s.queries, 4);
  assert.equal(s.found, 3);
  assert.equal(s.missed, 1);
  table.push({ label: "TMDB: 4 títulos nuevos", result: "ok", downloads: 0, upserted: s.queries, removed: 0, ms });
  // persistido: en la fila del catálogo (los 3 que existen) y en el mapa (el que no tiene fila)
  const spider = (await kino.catalog.get([idx.idOf("movies", gen.findKey("Spider-Man: Sin camino a casa"), 2021)]))[0];
  assert.equal(idx.dataOf(spider).t, 634649);
  const miss = (await kino.catalog.get([idx.idOf("movies", gen.findKey("El paseo 8"), 2025)]))[0];
  assert.equal(idx.dataOf(miss).t, 0);
  assert.ok(idx.dataOf(miss).a > 0, "fecha del último intento");
  assert.ok(JSON.parse(kino.storage.get("tmdb:cache"))[idx.idOf("movies", gen.findKey("Película que no está en el catálogo"), 2023)]);
  // segunda vez: nada que consultar
  lazy.resetTmdbStats();
  const again = [T("Spider-Man: Sin camino a casa (LAT)", 2021), T("El paseo 8", 2025), T("Dark", 2017, "series"), T("Película que no está en el catálogo", 2023)];
  assert.equal(await lazy.enrichTmdb(again), 3);
  s = lazy.tmdbStats();
  assert.equal(s.queries, 0, "caché: 0 consultas");
  assert.equal(s.cached, 3);
  assert.equal(s.skippedFresh, 1, "el sin coincidencia no se reintenta antes de 14 días");
  // a los 14 días se reintenta solo el que no coincidió
  const realNow = Date.now;
  Date.now = () => realNow() + 15 * 86400000;
  lazy.resetTmdbStats();
  await lazy.enrichTmdb([T("El paseo 8", 2025)]);
  Date.now = realNow;
  assert.equal(lazy.tmdbStats().queries, 1);
});

await test("TMDB: tope por llamada, límite de Kino (rate_limited) y presupuesto de tiempo: devuelve lo que hay y no lanza", async () => {
  const list = Array.from({ length: 30 }, (_, i) => T(`Título TMDB ${i}`, 2020));
  for (const it of list) fixtureFor(it.title, 2020, false, [{ id: 5000 + Number(it.title.split(" ").pop()), title: it.title, release_date: "2020-01-01" }]);
  lazy.resetTmdbStats();
  const t0 = performance.now();
  const n = await lazy.enrichTmdb(list, { max: 24, budgetMs: 2500 });
  const ms = Math.round(performance.now() - t0);
  let s = lazy.tmdbStats();
  assert.equal(s.queries, 24, "tope por llamada, no más de 24 de 30");
  assert.equal(n, 24);
  table.push({ label: "TMDB: 30 títulos nuevos (tope 24 por llamada)", result: n + " con id", downloads: 0, upserted: s.queries, removed: 0, ms });
  // con el límite de Kino (20 cada 10 s): se detiene sin lanzar y deja el resto para la próxima
  const more = Array.from({ length: 30 }, (_, i) => T(`Título TMDB B${i}`, 2021));
  for (const it of more) fixtureFor(it.title, 2021, false, [{ id: 7000 + Number(it.title.split("B").pop()), title: it.title, release_date: "2021-01-01" }]);
  await new Promise((r) => setTimeout(r, 10500)); // vacía la ventana de 10 s del kit
  lazy.resetTmdbStats();
  tmdbCalls = 0;
  tmdbLimitAt = 20;
  const m = await lazy.enrichTmdb(more, { max: 24, budgetMs: 2500 });
  tmdbLimitAt = Infinity;
  s = lazy.tmdbStats();
  assert.equal(m, 20, "los 20 que cupieron ya tienen id");
  assert.ok(s.rateLimited >= 1 && s.queries <= 24);
  table.push({ label: "TMDB: límite de Kino (20/10 s) a mitad de la llamada", result: m + " con id, " + s.rateLimited + " rate_limited", downloads: 0, upserted: s.queries, removed: 0, ms: 0 });
});

await test("TMDB perezoso en la búsqueda del índice: solo los 20 primeros resultados, sin tocar el resto", async () => {
  await kino.catalog.clear();
  kino.storage.remove("idx:state");
  pub = null;
  publish(mapOf(Array.from({ length: 60 }, (_, i) => entryOf("movies", `Búsqueda TMDB ${i}`, 2000 + (i % 25), [1100]))));
  assert.equal(await run(), "done");
  for (let i = 0; i < 60; i++) fixtureFor(`Búsqueda TMDB ${i}`, 2000 + (i % 25), false, [{ id: 9000 + i, title: `Búsqueda TMDB ${i}`, release_date: `${2000 + (i % 25)}-01-01` }]);
  const res = await idx.indexSearch("busqueda tmdb", "any", 60);
  assert.equal(res.items.length, 60);
  lazy.resetTmdbStats();
  await new Promise((r) => setTimeout(r, 10500)); // deja vaciar la ventana de 10 s del límite de Kino
  const t0 = performance.now();
  await lazy.enrichTmdb(res.items.slice(0, 20), { max: 20, budgetMs: 2500 });
  const ms = Math.round(performance.now() - t0);
  assert.equal(lazy.tmdbStats().queries, 20);
  assert.equal(res.items.filter((i) => i.ids).length, 20);
  assert.equal(res.items.slice(20).filter((i) => i.ids).length, 0);
  table.push({ label: "búsqueda: 20 primeros resultados (todos nuevos)", result: "ok", downloads: 0, upserted: 20, removed: 0, ms });
  const second = await idx.indexSearch("busqueda tmdb", "any", 60);
  assert.equal(second.items.filter((i) => i.ids).length, 20, "las siguientes búsquedas ya traen el id (data.t de la fila)");
});

await test("presupuesto de kino.storage: las clases idx y tmdb quedan dentro de su límite", () => {
  const u = store.usage();
  assert.ok((u.byClass.idx || 0) <= store.CLASSES.idx.budget, JSON.stringify(u.byClass));
  assert.ok((u.byClass.tmdb || 0) <= store.CLASSES.tmdb.budget, JSON.stringify(u.byClass));
});

await test("ids estables y válidos (patrón de ids de Kino), sin colisiones en 50.000 títulos", () => {
  const seen = new Set();
  for (let i = 0; i < 50000; i++) {
    const id = idx.idOf("movies", gen.findKey(`Título ${i}`), 1900 + (i % 120));
    assert.match(id, /^[A-Za-z0-9._~-]{1,128}$/);
    assert.ok(!seen.has(id), "colisión " + id);
    seen.add(id);
  }
});

console.log("\nMedidas (títulos procesados frente a " + N + "; el tiempo es del catálogo simulado del kit, no de SQLite):");
for (const r of table) console.log(`  ${r.label.padEnd(62)} descargas ${String(r.downloads).padStart(2)} | upserts ${String(r.upserted).padStart(6)} | retirados ${String(r.removed).padStart(6)} | ${String(r.ms).padStart(6)} ms | ${r.result}`);
console.log(`\n${passed} pruebas OK`);
process.exit(0);
