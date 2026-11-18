// The feeds' reader: the orphan `data` branch first, `main` only for a file `data` lacks, and a `data` branch that does not
// exist yet remembered for 6 h (in memory and in storage, with its time), so a device pays one request per feed meanwhile.
// Cache-busting and freshness stay as they were: home by the hour, live by the day, at most 3 days old.
// Feed v2 (cache study #10): on `data` the reader asks the compressed copy (<path>.v2.enc.json: "v": 2, gzip inside the
// seal), on `main` the v1 file; a Kino without kino.crypto.gunzip reads as 0.8.6 did (`data` v1, then `main` v1).
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, fresh } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";

const H = 3600000;
let T = Date.UTC(2026, 10, 17, 12, 30);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });

const SK = "k1abc";
const REPO = "/xuper-plugin/kino-plugin-ultrahd/";
const { seal, sealV2, withCrypto } = sealer();
const homeOf = (key, extra = {}) => ({ v: 1, serverKey: key, at: T - 2 * H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "r1", title: "Acción", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }], ...extra });
const liveOf = (key, extra = {}) => ({ v: 1, serverKey: key, at: T - 2 * H, rails: [{ id: "lcat-1", title: "Deportes", items: [{ id: "live-1", ref: "live:1", title: "Uno" }] }], ...extra });

// branches: { data: { "<path>": body | status | Error }, main: {...} }; a missing branch or path answers 404.
function world({ data, main = {}, storage = {}, gunzip = true } = {}) {
  const branches = { ...(data ? { data } : {}), main };
  const routes = [(url) => {
    const u = new URL(url);
    if (u.hostname !== "raw.githubusercontent.com" || !u.pathname.startsWith(REPO)) return undefined;
    const [branch, ...rest] = u.pathname.slice(REPO.length).split("/");
    const got = branches[branch] ? branches[branch][rest.join("/")] : undefined;
    if (got instanceof Error) return got;
    if (typeof got === "number") return res(got, "error");
    return got === undefined ? res(404, "404: Not Found") : res(200, got);
  }];
  const k = installKino({ routes, storage });
  withCrypto(k.kino, { gunzip });
  const asked = () => k.requests.map((r) => { const u = new URL(r.url); return u.pathname.slice(REPO.length) + u.search; });
  return { ...k, asked };
}

const hour = () => Math.floor(T / H);
const day = () => Math.floor(T / (24 * H));

test("the data branch serves the feeds (v2): one request each, never main, with the same cache-busting as before", async () => {
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: sealV2(homeOf(SK)), [`home/${SK}.es-419.v2.enc.json`]: sealV2(homeOf(SK, { lang: "es-419" })), [`live/${SK}.v2.enc.json`]: sealV2(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  const home = await feed.fetchHomeFeed(SK, "es");
  assert.equal(home.rows[0].title, "Acción");
  const own = await feed.fetchHomeFeed(SK, "es-419");
  assert.equal(own.lang, "es-419");
  const live = await feed.fetchLiveFeed(SK);
  assert.equal(live.rails.length, 1);
  assert.deepEqual(w.asked(), [`data/home/${SK}.v2.enc.json?v=${hour()}`, `data/home/${SK}.es-419.v2.enc.json?v=${hour()}`, `data/live/${SK}.v2.enc.json?v=${day()}`]);
  assert.equal(w.store.get("feedData:v1"), undefined, "nothing remembered");
});

test("no data branch yet: main serves, the miss is remembered 6 h in memory and storage, then data is tried again", async () => {
  const w = world({ main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w.asked(), [`data/home/${SK}.v2.enc.json?v=${hour()}`, `main/home/${SK}.enc.json?v=${hour()}`]);
  assert.equal(JSON.parse(w.store.get("feedData:v1")).at, T, "stored with its time");
  // The same runtime: one request per feed, home and live alike.
  w.requests.length = 0;
  assert.ok(await feed.fetchLiveFeed(SK));
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w.asked(), [`main/live/${SK}.enc.json?v=${day()}`, `main/home/${SK}.enc.json?v=${hour()}`]);
  // A cold runtime (fresh module) reads the mark from storage.
  T += 5 * H;
  w.requests.length = 0;
  const cold = await fresh("homeFeed.js");
  assert.ok(await cold.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w.asked(), [`main/home/${SK}.enc.json?v=${hour()}`]);
  // Past 6 h: data first again (and, still missing, remembered again from now).
  T += 1.5 * H;
  w.requests.length = 0;
  assert.ok(await cold.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w.asked(), [`data/home/${SK}.v2.enc.json?v=${hour()}`, `main/home/${SK}.enc.json?v=${hour()}`]);
  assert.equal(JSON.parse(w.store.get("feedData:v1")).at, T);
});

test("the data branch appears: after the 6 h, data serves and main is no longer asked", async () => {
  const files = { [`home/${SK}.enc.json`]: seal(homeOf(SK)) };
  const w = world({ main: files });
  const feed = await fresh("homeFeed.js");
  await feed.fetchHomeFeed(SK, "es");
  T += 7 * H;
  const w2 = world({ data: { [`home/${SK}.v2.enc.json`]: sealV2(homeOf(SK)) }, main: files, storage: { "feedData:v1": w.store.get("feedData:v1") } });
  const again = await fresh("homeFeed.js");
  assert.ok(await again.fetchHomeFeed(SK, "es"));
  assert.ok(await again.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w2.asked(), [`data/home/${SK}.v2.enc.json?v=${hour()}`, `data/home/${SK}.v2.enc.json?v=${hour()}`]);
});

test("a file missing on both branches: null, and data is not marked missing (an account without its own language file)", async () => {
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: sealV2(homeOf(SK)) }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  const got = await feed.fetchHomeFeed(SK, "es-ES");
  assert.equal(got.rows[0].title, "Acción", "the default feed");
  assert.deepEqual(w.asked(), [`data/home/${SK}.es-ES.v2.enc.json?v=${hour()}`, `main/home/${SK}.es-ES.enc.json?v=${hour()}`, `data/home/${SK}.v2.enc.json?v=${hour()}`]);
  assert.equal(w.store.get("feedData:v1"), undefined);
});

test("main's copy that does not serve (stale orphan, another server) never marks data missing", async () => {
  const w = world({ data: {}, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK, { at: T - 4 * 24 * H })), [`live/${SK}.enc.json`]: seal(liveOf("other")) } });
  const feed = await fresh("homeFeed.js");
  assert.equal(await feed.fetchHomeFeed(SK, "es"), null);
  assert.equal(await feed.fetchLiveFeed(SK), null);
  assert.equal(w.store.get("feedData:v1"), undefined);
});

test("data fails without a 404 (a 5xx, a body that does not open): main serves this time, nothing remembered", async () => {
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: 503, [`live/${SK}.v2.enc.json`]: "<html>not a feed</html>" }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.ok(await feed.fetchLiveFeed(SK));
  assert.equal(w.requests.length, 4);
  assert.equal(w.store.get("feedData:v1"), undefined);
});

test("a network error on data is not a missing file: no request to main", async () => {
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: kinoError("network", "unreachable"), [`live/${SK}.v2.enc.json`]: kinoError("timeout", "timed out") }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.equal(await feed.fetchHomeFeed(SK, "es"), null);
  assert.equal(await feed.fetchLiveFeed(SK), null);
  assert.deepEqual(w.asked(), [`data/home/${SK}.v2.enc.json?v=${hour()}`, `data/live/${SK}.v2.enc.json?v=${day()}`]);
});

test("a stale feed on data is not looked for on main (freshness as before: at most 3 days)", async () => {
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: sealV2(homeOf(SK, { at: T - 3 * 24 * H - 1 })) }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.equal(await feed.fetchHomeFeed(SK, "es"), null);
  assert.equal(w.requests.length, 1);
});

test("a deadline: each request's timeout fits in it, and none starts with less than a second left", async () => {
  const w = world({ main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es", { until: T + 3000 }));
  assert.deepEqual(w.requests.map((r) => r.init.timeoutMs), [3000, 3000]);
  w.requests.length = 0;
  const cold = await fresh("homeFeed.js");
  w.store.delete("feedData:v1");
  assert.equal(await cold.fetchHomeFeed(SK, "es", { until: T + 900 }), null);
  assert.equal(w.requests.length, 0);
  assert.ok(await cold.fetchHomeFeed(SK, "es"), "no deadline: as before");
  assert.ok(w.requests.every((r) => r.init.timeoutMs === undefined));
});

// ---- feed v2 ----------------------------------------------------------------------------------------------------------

test("v2: the same feed in about a third of the bytes; it opens to exactly what v1 opens to", async () => {
  // A realistic Home: 11 rails of 20 cards with TMDB posters, as the producers build it.
  const big = homeOf(SK, { rows: Array.from({ length: 11 }, (_, r) => ({ id: "vod-" + r, title: "Categoría " + r, items: Array.from({ length: 20 }, (_, i) => ({ id: "vod-" + (r * 100 + i), ref: `vod:${r * 100 + i}:mp4~titulo ${i}`, title: "Título de ejemplo " + i, kind: "movie", poster: `https://image.tmdb.org/t/p/w342/${String(r * 100 + i).padStart(27, "x")}.jpg`, year: "2024" })) })) });
  const v1 = seal(big);
  const v2 = sealV2(big);
  assert.ok(v2.length < v1.length / 2.5, `v2 ${v2.length} B against v1 ${v1.length} B`);
  const a = world({ data: { [`home/${SK}.v2.enc.json`]: v2 } });
  const viaV2 = await (await fresh("homeFeed.js")).fetchHomeFeed(SK, "es");
  const b = world({ main: { [`home/${SK}.enc.json`]: v1 } });
  const viaV1 = await (await fresh("homeFeed.js")).fetchHomeFeed(SK, "es");
  assert.deepEqual(viaV2, viaV1);
  assert.equal(viaV2.rows.length, 11);
  void a; void b;
});

test("data still has only v1 (the producers publish v2 later): main's v1 serves, data is remembered missing 6 h", async () => {
  const w = world({ data: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w.asked(), [`data/home/${SK}.v2.enc.json?v=${hour()}`, `main/home/${SK}.enc.json?v=${hour()}`]);
  assert.equal(JSON.parse(w.store.get("feedData:v1")).at, T);
});

test("a v2 copy that does not open (damaged, or a format this reader does not know): main's v1, nothing remembered", async () => {
  const bad = JSON.stringify({ ...JSON.parse(sealV2(homeOf(SK))), v: 3 });
  const torn = JSON.parse(sealV2(homeOf(SK)));
  torn.data = torn.data.slice(0, -8) + "AAAAAAAA";
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: bad, [`live/${SK}.v2.enc.json`]: JSON.stringify(torn) }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.ok(await feed.fetchLiveFeed(SK));
  assert.equal(w.requests.length, 4);
  assert.equal(w.store.get("feedData:v1"), undefined);
});

test("a Kino without kino.crypto.gunzip reads as 0.8.6 did: data's v1, then main's v1", async () => {
  const w = world({ gunzip: false, data: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`home/${SK}.v2.enc.json`]: sealV2(homeOf(SK)) }, main: { [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.ok(await feed.fetchLiveFeed(SK));
  assert.deepEqual(w.asked(), [`data/home/${SK}.enc.json?v=${hour()}`, `data/live/${SK}.enc.json?v=${day()}`, `main/live/${SK}.enc.json?v=${day()}`]);
});

test("v1 stays readable wherever it is served (a v1 envelope at a v2 path opens as v1)", async () => {
  const w = world({ data: { [`home/${SK}.v2.enc.json`]: seal(homeOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.equal((await feed.fetchHomeFeed(SK, "es")).rows[0].title, "Acción");
  assert.equal(w.requests.length, 1);
});
