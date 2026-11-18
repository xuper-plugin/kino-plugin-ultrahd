// The feeds' reader: the orphan `data` branch first, `main` only for a file `data` lacks, and a `data` branch that does not
// exist yet remembered for 6 h (in memory and in storage, with its time), so a device pays one request per feed meanwhile.
// Cache-busting and freshness stay as they were: home by the hour, live by the day, at most 3 days old.
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
const { seal, withCrypto } = sealer();
const homeOf = (key, extra = {}) => ({ v: 1, serverKey: key, at: T - 2 * H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "r1", title: "Acción", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }], ...extra });
const liveOf = (key, extra = {}) => ({ v: 1, serverKey: key, at: T - 2 * H, rails: [{ id: "lcat-1", title: "Deportes", items: [{ id: "live-1", ref: "live:1", title: "Uno" }] }], ...extra });

// branches: { data: { "<path>": body | status | Error }, main: {...} }; a missing branch or path answers 404.
function world({ data, main = {}, storage = {} } = {}) {
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
  withCrypto(k.kino);
  const asked = () => k.requests.map((r) => { const u = new URL(r.url); return u.pathname.slice(REPO.length) + u.search; });
  return { ...k, asked };
}

const hour = () => Math.floor(T / H);
const day = () => Math.floor(T / (24 * H));

test("the data branch serves the feeds: one request each, never main, with the same cache-busting as before", async () => {
  const w = world({ data: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`home/${SK}.es-419.enc.json`]: seal(homeOf(SK, { lang: "es-419" })), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  const home = await feed.fetchHomeFeed(SK, "es");
  assert.equal(home.rows[0].title, "Acción");
  const own = await feed.fetchHomeFeed(SK, "es-419");
  assert.equal(own.lang, "es-419");
  const live = await feed.fetchLiveFeed(SK);
  assert.equal(live.rails.length, 1);
  assert.deepEqual(w.asked(), [`data/home/${SK}.enc.json?v=${hour()}`, `data/home/${SK}.es-419.enc.json?v=${hour()}`, `data/live/${SK}.enc.json?v=${day()}`]);
  assert.equal(w.store.get("feedData:v1"), undefined, "nothing remembered");
});

test("no data branch yet: main serves, the miss is remembered 6 h in memory and storage, then data is tried again", async () => {
  const w = world({ main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w.asked(), [`data/home/${SK}.enc.json?v=${hour()}`, `main/home/${SK}.enc.json?v=${hour()}`]);
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
  assert.deepEqual(w.asked(), [`data/home/${SK}.enc.json?v=${hour()}`, `main/home/${SK}.enc.json?v=${hour()}`]);
  assert.equal(JSON.parse(w.store.get("feedData:v1")).at, T);
});

test("the data branch appears: after the 6 h, data serves and main is no longer asked", async () => {
  const files = { [`home/${SK}.enc.json`]: seal(homeOf(SK)) };
  const w = world({ main: files });
  const feed = await fresh("homeFeed.js");
  await feed.fetchHomeFeed(SK, "es");
  T += 7 * H;
  const w2 = world({ data: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) }, main: files, storage: { "feedData:v1": w.store.get("feedData:v1") } });
  const again = await fresh("homeFeed.js");
  assert.ok(await again.fetchHomeFeed(SK, "es"));
  assert.ok(await again.fetchHomeFeed(SK, "es"));
  assert.deepEqual(w2.asked(), [`data/home/${SK}.enc.json?v=${hour()}`, `data/home/${SK}.enc.json?v=${hour()}`]);
});

test("a file missing on both branches: null, and data is not marked missing (an account without its own language file)", async () => {
  const w = world({ data: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  const got = await feed.fetchHomeFeed(SK, "es-ES");
  assert.equal(got.rows[0].title, "Acción", "the default feed");
  assert.deepEqual(w.asked(), [`data/home/${SK}.es-ES.enc.json?v=${hour()}`, `main/home/${SK}.es-ES.enc.json?v=${hour()}`, `data/home/${SK}.enc.json?v=${hour()}`]);
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
  const w = world({ data: { [`home/${SK}.enc.json`]: 503, [`live/${SK}.enc.json`]: "<html>not a feed</html>" }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.ok(await feed.fetchHomeFeed(SK, "es"));
  assert.ok(await feed.fetchLiveFeed(SK));
  assert.equal(w.requests.length, 4);
  assert.equal(w.store.get("feedData:v1"), undefined);
});

test("a network error on data is not a missing file: no request to main", async () => {
  const w = world({ data: { [`home/${SK}.enc.json`]: kinoError("network", "unreachable"), [`live/${SK}.enc.json`]: kinoError("timeout", "timed out") }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)), [`live/${SK}.enc.json`]: seal(liveOf(SK)) } });
  const feed = await fresh("homeFeed.js");
  assert.equal(await feed.fetchHomeFeed(SK, "es"), null);
  assert.equal(await feed.fetchLiveFeed(SK), null);
  assert.deepEqual(w.asked(), [`data/home/${SK}.enc.json?v=${hour()}`, `data/live/${SK}.enc.json?v=${day()}`]);
});

test("a stale feed on data is not looked for on main (freshness as before: at most 3 days)", async () => {
  const w = world({ data: { [`home/${SK}.enc.json`]: seal(homeOf(SK, { at: T - 3 * 24 * H - 1 })) }, main: { [`home/${SK}.enc.json`]: seal(homeOf(SK)) } });
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
