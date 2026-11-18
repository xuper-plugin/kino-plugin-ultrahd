// The screen's ticks in Kino's timer, in virtual time (cache study #6). Kino sends the next tick POLL ms after a tick and its
// render finished, stretched to twice a slow tick's time (PluginScreenSession.nextWait), and holds a tick until every request
// it started settled. The screen asks a 1 s timer while it loads, runs cheap units together in one tick (never past
// ~1.2 s), and keeps a heavy unit near a second: the index applies a big delta in steps under a second instead of one
// 2.3 s tick.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";
import { keyOf } from "../src/panels.js";

const H = 3600000;
const RENDER_MS = 80;
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const { sealV2, withCrypto } = sealer();

const R1 = "20261110T153911Z";
const R2 = "20261117T153911Z";

// One account; feed: its Home feed exists; delta: rows the index's daily check finds to add (0: the index is current).
function world({ prefix, feed = true, delta = 0, healthAge = H, recent = [] }) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 18, 0) });
  Date.now = net.now;
  const T0 = net.now();
  const list = ["a", "b", "c"].map((id) => ({ url: `http://${prefix}${id}.example`, username: "u" + id, password: "p" + id, name: "🇲🇽" }));
  const KEY = keyOf(list[0]);
  const manifest = { v: 1, generated: "2026-11-17T15:39:11Z", hash: "h2", revision: R2, coverage: 0.99, src: "", movies: { parts: ["movies-0.json"], hashes: ["m0"], count: 40000 }, series: { parts: ["series-0.json"], hashes: ["s0"], count: 6000 }, deltas: [{ from: R1, to: R2, file: `delta-${R1}-${R2}.json` }] };
  const deltaFile = { from: R1, to: R2, total: 46000 + delta, added: Array.from({ length: delta }, (_, i) => ({ k: "m", n: "Nueva película " + i, y: 2025, t: 0, c: [1] })), removed: [] };
  const log = [];
  const inflight = new Set();
  const track = (e, p) => { inflight.add(p); p.then(() => { e.end = net.now(); inflight.delete(p); }); return p; };
  const routes = [(url) => {
    const u = new URL(url);
    const e = { host: u.hostname, path: u.pathname, action: param(url, "action"), t: net.now() - T0 };
    log.push(e);
    if (u.hostname === "raw.githubusercontent.com") {
      if (u.pathname.includes("kino-plugin-ultrahd-data")) {
        if (u.pathname.endsWith("/index.json")) return track(e, net.request(200).then(() => res(200, manifest)));
        if (u.pathname.includes("delta-")) return track(e, net.request(300).then(() => res(200, deltaFile)));
        return track(e, net.request(150).then(() => res(404, "")));
      }
      const m = /\/data\/home\/([^/.]+)\.v2\.enc\.json$/.exec(u.pathname);
      if (feed && m && m[1] === KEY) return track(e, net.request(250).then(() => res(200, sealV2({ v: 1, serverKey: KEY, at: net.now() - 2 * H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "r1", title: "Fila del feed", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }] }))));
      return track(e, net.request(150).then(() => res(404, "404: Not Found")));
    }
    const a = e.action;
    const body = !a ? { user_info: { auth: 1 } }
      : a.endsWith("_categories") ? Array.from({ length: 20 }, (_, i) => ({ category_id: String(i + 1), category_name: "PELICULAS " + (i + 1) }))
      : a === "get_vod_info" ? { info: { name: "Vista" }, movie_data: { stream_id: 7, name: "Vista", container_extension: "mp4" } }
      : Array.from({ length: 30 }, (_, i) => ({ stream_id: 100 + i, series_id: 100 + i, name: "Peli " + i, container_extension: "mp4" }));
    return track(e, net.request(!a ? 300 : a.endsWith("_categories") ? 500 : 600).then(() => res(200, body)));
  }];
  // The catalog's writes take time on a phone (SQLite): 0.6 ms a row here.
  let count = 46000;
  const catalog = {
    count: async () => count,
    upsert: async (rows) => { await net.request(Math.ceil(rows.length * 0.6)); count += rows.length; },
    get: async () => [], remove: async () => {}, search: async () => ({ items: [] }), clear: async () => { count = 0; },
  };
  const now = net.now();
  const k = installKino({ routes, storage: {
    srvs: JSON.stringify({ ts: now, list, idx: 0, ok: true, okAt: now - 2 * H, v: 2, mig: 1, chosen: KEY }),
    "srvChosen:v1": "1",
    "panels:v1": JSON.stringify({ v: 1, at: now - 2 * H, g: {}, t: {} }),
    "health:v1": JSON.stringify({ ts: now - healthAge, online: list.map((s) => s.url) }),
    "idx:state": JSON.stringify({ v: 1, src: "", done: true, rev: delta ? R1 : R2, checked: delta ? now - 25 * H : now - H, total: 46000 }),
    "recent:v1": JSON.stringify(recent.map((id) => ({ id, srv: KEY, ext: "mp4" }))),
  } });
  withCrypto(k.kino);
  k.kino.catalog = catalog;
  const drain = async () => { while (inflight.size) await Promise.all([...inflight]); };
  return { ...k, net, T0, log, drain };
}

// Kino's timer over the screen until nothing is left to load: every tick with its start, held time and requests.
async function runTimer(w, { tab = "home", max = 60 } = {}) {
  const screen = await fresh("screen.js");
  let state = {};
  const sleep = async (ms) => { if (ms > 0) await w.net.run(w.net.request(ms)); };
  const ev = async (name) => { const out = await w.net.run(screen.screenEvent({ name, state, route: { name: "main" }, lang: "es" })); state = { ...state, ...(out && out.state) }; };
  const view = async () => w.net.run(screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  await ev("open");
  state.tab = tab;
  let v = await view();
  await sleep(RENDER_MS);
  const ticks = [];
  const marks = {};
  for (let i = 0; i < max; i++) {
    const every = v && v.every;
    if (!every || every.event !== "tick") break;
    const wait = i === 0 ? every.ms : Math.max(every.ms, 2 * ticks[i - 1].took);
    await sleep(wait);
    const t0 = w.net.now();
    const n0 = w.log.length;
    await ev("tick");
    await w.net.run(w.drain());
    const held = w.net.now() - t0;
    v = await view();
    await sleep(RENDER_MS);
    if (JSON.stringify(v).includes("Fila del feed") && marks.fresh === undefined) marks.fresh = w.net.now() - w.T0;
    ticks.push({ at: t0 - w.T0, held, took: held + RENDER_MS, wait, requests: w.log.slice(n0) });
  }
  return { ticks, marks, last: v };
}

test("the timer is 1 s while loading; the feed and the cheap units after it share the first tick", async () => {
  const w = world({ prefix: "t1", recent: [] });
  const { ticks, marks } = await runTimer(w);
  assert.equal(ticks[0].at, RENDER_MS + 1000, "the first tick 1 s after the first render (it was 1.5 s)");
  assert.ok(marks.fresh <= RENDER_MS + 1000 + 250 + RENDER_MS, `the feed painted at ${marks.fresh} ms`);
  // hfeed (1 request) and recent (no request) in the first tick; the index alone in its own.
  assert.equal(ticks[0].requests.length, 1);
  assert.equal(ticks.length, 1, "nothing left after the first tick: " + JSON.stringify(ticks.map((t) => t.requests.map((r) => r.path))));
});

test("a big index delta: steps under a second each, so no wait is stretched past 2 s and a tapped channel waits less than a second", async () => {
  const w = world({ prefix: "t2", delta: 3000 });
  const { ticks } = await runTimer(w);
  const indexTicks = ticks.filter((t) => t.requests.some((r) => r.path.includes("kino-plugin-ultrahd-data")) || t.requests.length === 0);
  assert.ok(ticks.length >= 3, "the delta took several steps");
  for (const t of ticks) assert.ok(t.held <= 1000, `a tick held ${t.held} ms (the 2.5 s step held 2.3 s)`);
  for (const t of ticks.slice(1)) assert.ok(t.wait <= 2 * (1000 + RENDER_MS), `a wait of ${t.wait} ms`);
  assert.ok(indexTicks.length >= 1);
  assert.equal(JSON.parse(w.store.get("idx:state")).rev, R2, "the delta applied in the end");
  assert.equal(w.log.filter((r) => r.path.includes("/delta-")).length, 1, "downloaded once for all its steps");
});

test("no feed: the check of the active server, the Home's plan and its first rails come in the first ticks, two rails a tick", async () => {
  const w = world({ prefix: "t3", feed: false, healthAge: 7 * H });
  const { ticks } = await runTimer(w, { max: 30 });
  const first = ticks[0].requests.map((r) => r.action || (r.host === "raw.githubusercontent.com" ? "github" : "login"));
  assert.deepEqual(first, ["github", "github", "login", "get_vod_categories", "get_series_categories"], "feed tried, the active server checked, the plan: one tick");
  const railTicks = ticks.filter((t) => t.requests.some((r) => r.action === "get_vod_streams" || r.action === "get_series"));
  assert.ok(railTicks.some((t) => t.requests.filter((r) => r.action === "get_vod_streams" || r.action === "get_series").length === 2), "two rails in a tick");
  // Every tick but the hero's (its ~11 fichas, unchanged here) stays near a second.
  const shape = JSON.stringify(ticks.map((x) => [x.held, x.requests.map((r) => r.action || "gh")]));
  for (const t of ticks.filter((x) => !x.requests.some((r) => /_info$/.test(r.action || "")))) assert.ok(t.held <= 1200, `a tick held ${t.held} ms: ${shape}`);
});

test("'Continuar viendo' cards to look up are not cheap: they wait for their own tick", async () => {
  const w = world({ prefix: "t4", recent: ["1", "2", "3"] });
  const { ticks } = await runTimer(w);
  assert.deepEqual(ticks[0].requests.map((r) => r.action || "github"), ["github"], "the feed alone in the first tick");
  assert.ok(ticks[1].requests.every((r) => r.action === "get_vod_info"), "the cards in the next one");
});
