// The screen's checks off the path (cache study #5): which accounts answer is checked every 6 h (not every 30 min), with the
// account's login answer (player_api.php with no action) instead of a full category list, in short steps that never hold a
// screen call (and a channel the person taps behind it) for more than a probe's timeout; the full check (category lists,
// panel map) runs once a day. On the screen: no check at all on En vivo while its feed paints, and before loading from the
// panel only a quick probe of the active server when it has not answered lately. In Kino's network in virtual time.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";
import { keyOf, readPanels } from "../src/panels.js";
import * as sharedCat from "../src/catalog.js";

const H = 3600000;
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const { sealV2: seal, withCrypto } = sealer();

// hosts: [{ id, does: "ok" | "hang" | "dead", ms }]; each its own host. feeds: serve the account's home and live feeds.
// The screen's catalog module is shared by every test of this file (its memory of who answered lately too): each test
// names its hosts apart (hosts(n, prefix)).
function world(hosts, { storage = {}, feeds = false, active = 0 } = {}) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 17, 12) });
  Date.now = net.now;
  const srv = (h) => ({ url: `http://${h.id}.example`, username: "u" + h.id, password: "p" + h.id, name: "🇲🇽" });
  const list = hosts.map(srv);
  const log = [];
  const inflight = new Set();
  const track = (e, p) => { inflight.add(p); p.then(() => { e.end = net.now(); inflight.delete(p); }); return p; };
  const routes = [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "raw.githubusercontent.com") {
      const e = { n: "github", path: u.pathname, t: net.now() };
      log.push(e);
      const m = /\/data\/(home|live)\/([^/.]+)\.v2\.enc\.json$/.exec(u.pathname);
      const key = m && m[2];
      if (feeds && m && m[1] === "home") return track(e, net.request(250).then(() => res(200, seal({ v: 1, serverKey: key, at: net.now() - H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "r1", title: "Del feed", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }] }))));
      if (feeds && m && m[1] === "live") return track(e, net.request(250).then(() => res(200, seal({ v: 1, serverKey: key, at: net.now() - H, rails: [{ id: "lcat-1", title: "Deportes", items: [{ id: "live-1", ref: "live:1", title: "Canal" }] }] }))));
      return track(e, net.request(150).then(() => res(404, "404: Not Found")));
    }
    const h = hosts.find((x) => u.hostname === `${x.id}.example`);
    if (!h) return undefined;
    const e = { n: h.id, action: param(url, "action"), t: net.now(), timeoutMs: init && init.timeoutMs };
    log.push(e);
    const limit = init && init.timeoutMs;
    if (h.does === "hang" || (limit && (h.ms || 400) > limit)) return track(e, net.request(limit || 15000).then(() => kinoError("timeout", "the request took too long")));
    if (h.does === "dead") return track(e, net.request(h.ms || 400).then(() => res(200, { user_info: { auth: 0 } })));
    const answer = () => {
      if (!e.action) return res(200, { user_info: { auth: 1, status: "Active" }, server_info: { url: u.hostname } });
      if (e.action.endsWith("_categories")) return res(200, Array.from({ length: 12 }, (_, i) => ({ category_id: String(i + 1), category_name: "CATEGORIA " + (i + 1) })));
      return res(200, [{ stream_id: 11, name: "Algo", category_id: "1", container_extension: "mp4" }]);
    };
    return track(e, net.request(h.ms || 400).then(answer));
  }];
  const now = net.now();
  const st = { ts: now, list, idx: active, ok: true, okAt: now - 2 * H, v: 2, mig: 1, chosen: keyOf(list[active]) };
  const k = installKino({ routes, storage: { srvs: JSON.stringify(st), "srvChosen:v1": "1", ...storage } });
  withCrypto(k.kino);
  const drain = async () => { while (inflight.size) await Promise.all([...inflight]); };
  // A call as Kino holds it: until every request it started settled. Returns that held time.
  const call = async (p) => { const t0 = net.now(); const out = await net.run(p); await net.run(drain()); return { out, held: net.now() - t0 }; };
  const probes = () => log.filter((e) => e.n !== "github");
  return { ...k, net, log, list, call, probes, keyOf: (i) => keyOf(list[i]) };
}

const freshPanels = (w, hours = 1) => JSON.stringify({ v: 1, at: w.net.now() - hours * H, g: {}, t: {} });
const hosts = (n, prefix, hang = () => false) => Array.from({ length: n }, (_, i) => ({ id: prefix + i, does: hang(i) ? "hang" : "ok", ms: 400 }));

test("a live round: the login answer only (no action), 3 s at most, the active server alone first; no step holds a call past its slowest probe", async () => {
  const w = world(hosts(30, "a", (i) => i % 3 === 1), { active: 4 });
  w.store.set("panels:v1", freshPanels(w));
  const cat = await fresh("catalog.js");
  const steps = [];
  for (let i = 0; i < 20; i++) {
    const { out, held } = await w.call(cat.healthStep({ kind: "live" }));
    steps.push({ out, held, probes: w.probes().length });
    if (out === "done") break;
  }
  assert.equal(steps.at(-1).out, "done");
  // The first step: the active (and chosen) server only, so the screen can load from it right after.
  assert.equal(steps[0].probes, 1);
  assert.equal(w.probes()[0].n, "a4");
  assert.ok(w.probes().every((e) => e.action === null && e.timeoutMs === 3000), "the login answer, with 3 s");
  // 700 ms of starts plus the slowest probe's 3 s: a channel tapped meanwhile waits that long at most (it was up to 15 s).
  for (const s of steps) assert.ok(s.held <= 700 + 3000 + 50, `a step held its call ${s.held} ms`);
  assert.equal(w.probes().length, 30, "every account once");
  const health = JSON.parse(w.store.get("health:v1"));
  assert.equal(health.online.length, 20);
  assert.ok(!health.online.includes("http://a1.example"));
  assert.equal(JSON.parse(w.store.get("panels:v1")).g && Object.keys(JSON.parse(w.store.get("panels:v1")).g).length, 0, "a live round leaves the panel map alone");
  assert.ok(cat.healthReady());
});

test("health stays fresh 6 h (it was 30 min); a check nothing answered (no network) only 30 min", async () => {
  const w = world(hosts(3, "b"));
  const cat = await fresh("catalog.js");
  const T0 = w.net.now();
  w.store.set("health:v1", JSON.stringify({ ts: T0 - 5 * H, online: ["http://b0.example"] }));
  assert.ok(cat.healthReady(), "5 h old: fresh");
  w.store.set("health:v1", JSON.stringify({ ts: T0 - 6 * H - 1000, online: ["http://b0.example"] }));
  assert.ok(!cat.healthReady(), "past 6 h: stale");
  w.store.set("health:v1", JSON.stringify({ ts: T0 - 40 * 60000, online: [] }));
  assert.ok(!cat.healthReady(), "an empty check is good for 30 min only");
});

test("the full round (once a day): VOD category lists with 4 s, the panel map regrouped, the dead active server left behind", async () => {
  const list = hosts(8, "c", (i) => i === 5);
  list[0] = { id: "c0", does: "dead" };
  const w = world(list, { active: 0 });
  const cat = await fresh("catalog.js");
  assert.ok(cat.panelsStale());
  let out;
  for (let i = 0; i < 10 && out !== "done"; i++) out = (await w.call(cat.healthStep({ kind: "full" }))).out;
  assert.equal(out, "done");
  assert.ok(w.probes().every((e) => e.action === "get_vod_categories" && e.timeoutMs === 4000));
  assert.ok(!cat.panelsStale(), "the panel map is fresh");
  assert.equal(Object.keys(readPanels().g).length, 6, "the 6 accounts that answered, in one panel");
  const st = JSON.parse(w.store.get("srvs"));
  assert.notEqual(st.idx, 0, "jumped off the dead active server");
  assert.equal(st.chosen, w.keyOf(0), "the person's choice is untouched (backHome returns there)");
});

// ---- on the screen ---------------------------------------------------------------------------------------------------

async function screenOf(w, state0 = {}) {
  const screen = await fresh("screen.js");
  let state = { ...state0 };
  const s = {};
  s.tick = async () => {
    const { out, held } = await w.call(screen.screenEvent({ name: "tick", state, lang: "es" }));
    state = { ...state, ...(out && out.state) };
    return held;
  };
  s.view = async () => JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  s.until = async (pred, max = 40) => { for (let i = 0; i < max && !(await pred()); i++) await s.tick(); return pred(); };
  return s;
}

test("En vivo with its feed: no account is probed at all while the panel map is fresh (it ran the whole check every 30 min)", async () => {
  const w = world(hosts(10, "d"), { feeds: true });
  w.store.set("panels:v1", freshPanels(w));
  w.store.set("browseTab", "live");
  const s = await screenOf(w, { tab: "live" });
  assert.ok(await s.until(async () => (await s.view()).includes("Canal") && !(await s.view()).includes('"every"')), "the feed painted and nothing is left to run");
  assert.equal(w.probes().length, 0, "no probe: " + JSON.stringify(w.probes()));
});

test("no feed, a stale check: one quick probe of the active server, the content from it, the rest of the check after the content", async () => {
  const w = world(hosts(12, "e", (i) => i === 7), { feeds: false, active: 2 });
  w.store.set("panels:v1", freshPanels(w));
  w.store.set("health:v1", JSON.stringify({ ts: w.net.now() - 7 * H, online: [] }));
  const s = await screenOf(w, { tab: "movies" });
  const firstContent = () => w.probes().find((e) => e.action === "get_vod_streams");
  assert.ok(await s.until(async () => !!firstContent()), "the tab loaded");
  const before = w.probes().filter((e) => e.t < firstContent().t);
  assert.deepEqual(before.filter((e) => e.action === null).map((e) => e.n), ["e2"], "only the active server was checked before the content");
  assert.ok(await s.until(async () => JSON.parse(w.store.get("health:v1")).online.length > 0), "the check finished after the content");
  assert.equal(w.probes().filter((e) => e.action === null).length, 12, "every account once, in the end");
});

test("the active server answered a minute ago: nothing is probed before the content", async () => {
  const w = world(hosts(6, "f"), { feeds: false, active: 1 });
  w.store.set("panels:v1", freshPanels(w));
  await w.call(sharedCat.serverStatus()); // any good answer of the active server (here the settings' status check)
  const s = await screenOf(w, { tab: "movies" });
  const n0 = w.probes().length;
  assert.ok(await s.until(async () => w.probes().some((e) => e.action === "get_vod_streams")));
  const first = w.probes().slice(n0).find((e) => e.action === "get_vod_streams" || e.action === null);
  assert.equal(first.action, "get_vod_streams", "the content came first");
});
