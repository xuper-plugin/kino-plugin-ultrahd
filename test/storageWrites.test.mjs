// Fewer storage writes (cache study #11). Kino keeps the whole store as one JSON file and rewrites it on every set, and each
// put did two sets (the value and `_idx`) after reading every value to sum their sizes, measured as raw UTF-8 (8-14.5 % less
// than Kino counts). Now sizes live in `_idx`, measured as Kino encodes the file; an unchanged value is not written; `_idx`
// is written once per call by the entry point; and the writers that rewrote the same thing on every call stopped.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, param, fresh } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";
import { keyOf } from "../src/panels.js";
import { put, usage, jsonSize, flush, SOFT_CAP } from "../src/store.js";

const H = 3600000;
let T = Date.UTC(2026, 10, 18, 0);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });
const { sealV2: seal, withCrypto } = sealer();

// The store file as Kino writes it: Android's org.json escapes "/" too.
const kinoFile = (store) => Buffer.byteLength(JSON.stringify(Object.fromEntries(store)).replace(/\//g, "\\/"));

test("sizes as Kino counts its file: JSON-encoded, slashes escaped; the plugin's total is the file's", () => {
  const { store } = installKino();
  assert.equal(jsonSize('a"b/c\\d\n'), 2 + 8 + 4);
  assert.equal(jsonSize("ñ"), 2 + 2);
  put("srvs", JSON.stringify({ list: [{ url: "http://a.example/x" }], name: "🇲🇽 México" }));
  put("homeSnap:v3:k:home:es", JSON.stringify({ v: 3, rails: [{ title: "Acción", items: [{ poster: "https://image.tmdb.org/t/p/w342/abc.jpg" }] }] }));
  put("cats:vod:k", JSON.stringify({ ts: 1, l: [["1", "PELÍCULAS \"4K\""]] }));
  flush();
  assert.equal(usage().total, kinoFile(store), "the plugin's count is the file's size");
});

test("a value equal to the stored one is not written; `_idx` is written once per call at most, when a key came or went", async () => {
  const { writes } = installKino();
  put("browseTab", "movies");
  put("cats:vod:k", "[1]");
  assert.deepEqual(writes, ["browseTab", "cats:vod:k"], "one set per put, no `_idx` yet (it was two sets per put)");
  flush();
  assert.deepEqual(writes.slice(2), ["_idx"]);
  writes.length = 0;
  put("browseTab", "movies");
  flush();
  assert.deepEqual(writes, [], "nothing changed: nothing written");
  put("cats:vod:k", "[1,2]");
  flush();
  assert.deepEqual(writes, ["cats:vod:k"], "a known key changed: its value only (`_idx` follows within 10 min)");
  T += 10 * 60 * 1000 + 1;
  put("cats:vod:k", "[1,2,3]");
  flush();
  assert.deepEqual(writes, ["cats:vod:k", "cats:vod:k", "_idx"]);
  put("cats:vod:k2", "[9]");
  flush();
  assert.deepEqual(writes.slice(3), ["cats:vod:k2", "_idx"], "a new key: `_idx` right away");
});

test("an `_idx` of the older format ({ key: ms }) is read and its sizes measured once", () => {
  const { store } = installKino({ storage: { "cats:vod:a": "x".repeat(1000), _idx: JSON.stringify({ "cats:vod:a": 5 }) } });
  const u = usage();
  assert.equal(u.byClass.cats, jsonSize("cats:vod:a") + jsonSize("x".repeat(1000)) + 2);
  put("cats:vod:b", "y");
  flush();
  const idx = JSON.parse(store.get("_idx"));
  assert.deepEqual(idx["cats:vod:a"], [5, u.byClass.cats], "kept its time, gained its size");
});

test("filling every class stays under the soft cap as Kino counts it (the old count let it reach about 225-230 KB)", () => {
  const { store } = installKino();
  const url = "https://image.tmdb.org/t/p/w600_and_h900_bestv2/" + "b".repeat(27) + ".jpg";
  for (let i = 0; i < 60; i++) {
    put("cats:vod:s" + i, JSON.stringify({ ts: 1, l: Array.from({ length: 80 }, (_, j) => [String(j), "CATEGORÍA \"" + j + "\""]) }));
    put("homeSnap:v3:s" + i + ":home:es", JSON.stringify({ v: 3, rails: Array.from({ length: 30 }, () => ({ poster: url })) }).slice(0, 9000));
    put("vinfo:s" + i, JSON.stringify(Array.from({ length: 200 }, () => url)).slice(0, 20000));
    put("searchHist:v1:s" + i, JSON.stringify(Array.from({ length: 70 }, () => url)).slice(0, 9000));
    put("recent:v1", JSON.stringify(Array.from({ length: 300 }, () => url)).slice(0, 25000));
  }
  flush();
  assert.ok(kinoFile(store) <= SOFT_CAP + 4096, `Kino's file: ${kinoFile(store)} B`);
});

// ---- the writers ----

function world({ prefix }) {
  const list = ["a", "b"].map((id) => ({ url: `http://${prefix}${id}.example`, username: "u" + id, password: "p" + id, name: "🇲🇽" }));
  const KEY = keyOf(list[0]);
  const feed = seal({ v: 1, serverKey: KEY, at: T - H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "r1", title: "Del feed", items: [{ id: "m1", ref: "vod:1", title: "Uno", poster: "https://image.tmdb.org/t/p/w342/u.jpg" }] }], movies: { slides: [], rows: [{ id: "r2", title: "Pelis", items: [{ id: "m2", ref: "vod:2", title: "Dos" }] }] } });
  const routes = [(url) => {
    const u = new URL(url);
    if (u.hostname === "raw.githubusercontent.com") return u.pathname.endsWith(`/data/home/${KEY}.v2.enc.json`) ? res(200, feed) : res(404, "");
    const a = param(url, "action");
    if (a === "get_vod_categories") return res(200, [{ category_id: "1", category_name: "ACCION" }]);
    if (a === "get_vod_streams") return res(200, [{ stream_id: 5, name: "Cinco", container_extension: "mp4" }]);
    return res(200, []);
  }];
  const k = installKino({ routes, storage: { srvs: JSON.stringify({ ts: T, list, idx: 0, ok: true, okAt: T, v: 2, mig: 1, chosen: KEY, homeAt: T }), "srvChosen:v1": "1", "panels:v1": JSON.stringify({ v: 1, at: T, g: {}, t: {} }), "health:v1": JSON.stringify({ ts: T, online: list.map((s) => s.url) }) } });
  withCrypto(k.kino);
  return k;
}

test("a cold open that loads the same feed again writes nothing (it rewrote its three snapshots: six writes of the whole store)", async () => {
  const w = world({ prefix: "w1" });
  const entry = await fresh("plugin.js");
  const tick = async (state) => entry.screenEvent({ name: "tick", state, lang: "es" });
  await tick({ tab: "home" });
  const first = w.writes.filter((k) => k.startsWith("homeSnap:"));
  assert.equal(first.length, 2, "the first load writes the Home's and Películas' snapshots");
  // The runtime closes (5 min idle): a fresh screen module loads the same feed.
  const again = await fresh("plugin.js");
  w.writes.length = 0;
  await again.screenEvent({ name: "tick", state: { tab: "home" }, lang: "es" });
  assert.deepEqual(w.writes.filter((k) => k !== "_idx"), [], "the same feed: no value written");
  assert.ok(w.writes.filter((k) => k === "_idx").length <= 1, "`_idx` once per call at most");
});

test("api() answers within 10 min leave srvs alone; serverStatus still knows when the server last answered", async () => {
  const w = world({ prefix: "w2" });
  const cat = await fresh("catalog.js");
  T += 6000;
  await cat.loadRailsInfo("vod", 1, 5, { noEnrich: true });
  T += 6000;
  await cat.browse("vod:1", "1");
  assert.ok(!w.writes.includes("srvs"), "srvs not rewritten (it was on every answer more than 5 s after the last)");
  const s = await cat.serverStatus();
  assert.equal(s.ok, true);
  assert.ok(T - s.at < 7000, "the last answer, from memory");
});

test("a title played again within the hour does not rewrite what the player's server menu learnt", async () => {
  const w = world({ prefix: "w3" });
  const cat = await fresh("catalog.js");
  await cat.resolve("vod:77:mkv~siete");
  const n = w.writes.filter((k) => k === "avail:v1").length;
  await cat.resolve("vod:77:mkv~siete");
  assert.equal(w.writes.filter((k) => k === "avail:v1").length, n);
});
