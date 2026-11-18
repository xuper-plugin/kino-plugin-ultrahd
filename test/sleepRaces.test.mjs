// No kino.sleep races (cache study #8). Kino holds a call until every pending binding settles, a kino.sleep included, so a
// race against a sleep holds the call for the sleep's whole length even when the other side answered at once: Kino's Home
// (home()) took at least 3 s every time, even with no country set (the default), and every TMDB lookup held its call 2.5 s.
// Now the Home row's cap is its requests' own timeouts, and TMDB's time cap only stops new queries.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";
import { keyOf } from "../src/panels.js";

const H = 3600000;
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const { seal, withCrypto } = sealer();

function world({ prefix, config = {}, panelHangs = false } = {}) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 18, 0) });
  Date.now = net.now;
  const list = ["a", "b"].map((id) => ({ url: `http://${prefix}${id}.example`, username: "u" + id, password: "p" + id, name: "🇨🇴" }));
  const KEY = keyOf(list[0]);
  const log = [];
  const sleeps = [];
  const inflight = new Set();
  const hold = (p) => { inflight.add(p); p.then(() => inflight.delete(p), () => inflight.delete(p)); return p; };
  const routes = [(url, init) => {
    const u = new URL(url);
    const e = { host: u.hostname, path: u.pathname, action: param(url, "action"), timeoutMs: init && init.timeoutMs, t: net.now() };
    log.push(e);
    if (u.hostname === "raw.githubusercontent.com") {
      if (u.pathname.includes(`/home/${KEY}.`)) return hold(net.request(250).then(() => res(200, seal({ v: 1, serverKey: KEY, at: net.now() - H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "r1", title: "Del feed", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }] }))));
      return hold(net.request(150).then(() => res(404, "")));
    }
    if (panelHangs) return hold(net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "the request took too long")));
    if (e.action === "get_live_categories") return hold(net.request(400).then(() => res(200, [{ category_id: "7", category_name: "COLOMBIA" }])));
    return hold(net.request(500).then(() => res(200, [{ stream_id: 70, name: "Caracol", category_id: "7" }])));
  }];
  const now = net.now();
  const k = installKino({ routes, config, storage: { srvs: JSON.stringify({ ts: now, list, idx: 0, ok: true, okAt: now, v: 2, mig: 1, chosen: KEY }) } });
  withCrypto(k.kino);
  k.kino.sleep = (ms) => { sleeps.push(ms); return hold(net.request(ms)); };
  const drain = async () => { while (inflight.size) await Promise.all([...inflight]); };
  const call = async (p) => { const t0 = net.now(); const out = await net.run(p); await net.run(drain()); return { out, held: net.now() - t0 }; };
  return { ...k, net, log, sleeps, call, hold };
}

test("Kino's Home from the feed with no country set: the feed's time only (it was 3 s at least), no sleep", async () => {
  const w = world({ prefix: "s1" });
  const cat = await fresh("catalog.js");
  const { out, held } = await w.call(cat.home());
  assert.equal(out[0].title, "Del feed");
  assert.deepEqual(w.sleeps, [], "no kino.sleep");
  assert.equal(held, 250, "the feed's one request");
  assert.ok(!w.log.some((e) => e.action), "no panel request without a country");
});

test("Kino's Home with a country: the row's requests carry the time left of 3 s; a silent panel costs that, never more", async () => {
  const w = world({ prefix: "s2", config: { homeCountry: "CO" } });
  const cat = await fresh("catalog.js");
  const { out, held } = await w.call(cat.home());
  assert.deepEqual(w.sleeps, []);
  assert.equal(out.at(-1).id, "live-country", "the row came");
  const panel = w.log.filter((e) => e.action);
  assert.ok(panel.length >= 2 && panel.every((e) => e.timeoutMs > 0 && e.timeoutMs <= 3000), JSON.stringify(panel));
  assert.equal(held, 250 + 400 + 500, "feed, live categories, one country category");

  const w2 = world({ prefix: "s3", config: { homeCountry: "CO" }, panelHangs: true });
  const cat2 = await fresh("catalog.js");
  const r2 = await w2.call(cat2.home());
  assert.equal(r2.out.length, 1, "no country row");
  assert.ok(r2.held <= 250 + 3000, `held ${r2.held} ms`);
});

test("TMDB lookups: the call holds as long as TMDB takes, never the 2.5 s budget; no sleep", async () => {
  const w = world({ prefix: "s4" });
  w.kino.tmdb = (path, params) => w.hold(w.net.request(120).then(() => ({ results: [{ id: 99, title: params.query, release_date: "2020-01-01", poster_path: "/p.jpg" }] })));
  const { enrichTmdb } = await fresh("tmdbLazy.js");
  const items = Array.from({ length: 6 }, (_, i) => ({ id: "vod-" + i, title: "Película " + i + " (2020)", kind: "movie" }));
  const { out, held } = await w.call(enrichTmdb(items, { max: 6, budgetMs: 2500 }));
  assert.equal(out, 6);
  assert.deepEqual(w.sleeps, []);
  assert.equal(held, 2 * 120, "two rounds of 3 queries");
});
