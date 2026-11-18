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
// listAgeH: how old the cached server list is (the bootstrap serves the same list, in 300 ms; bootHangs: it never answers).
// The screen's catalog module is shared by every test of this file (its memory of who answered lately too): each test
// names its hosts apart (hosts(n, prefix)).
function world(hosts, { storage = {}, feeds = false, active = 0, listAgeH = 0, bootHangs = false } = {}) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 17, 12) });
  Date.now = net.now;
  const srv = (h) => ({ url: `http://${h.id}.example`, username: "u" + h.id, password: "p" + h.id, name: "🇲🇽" });
  const list = hosts.map(srv);
  const log = [];
  const inflight = new Set();
  const track = (e, p) => { inflight.add(p); p.then(() => { e.end = net.now(); inflight.delete(p); }); return p; };
  const routes = [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") {
      const e = { n: "boot", t: net.now(), timeoutMs: init && init.timeoutMs };
      log.push(e);
      if (bootHangs) return track(e, net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "the request took too long")));
      const text = list.map((s) => `${s.url}/get.php?username=${s.username}&password=${s.password} [${s.name}]`).join("\n");
      return track(e, net.request(300).then(() => res(200, { ok: true, servers_text: text })));
    }
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
  const st = { ts: now - listAgeH * H, list, idx: active, ok: true, okAt: now - 2 * H, v: 2, mig: 1, chosen: keyOf(list[active]) };
  const k = installKino({ routes, storage: { srvs: JSON.stringify(st), "srvChosen:v1": "1", ...storage } });
  withCrypto(k.kino);
  const drain = async () => { while (inflight.size) await Promise.all([...inflight]); };
  // A call as Kino holds it: until every request it started settled. Returns that held time.
  const call = async (p) => { const t0 = net.now(); const out = await net.run(p); await net.run(drain()); return { out, held: net.now() - t0 }; };
  const probes = () => log.filter((e) => e.n !== "github" && e.n !== "boot");
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

test("a full round nothing answered (no network): the panel map keeps its age and confirmations, tried again in 30 min, not every tick", async () => {
  const w = world(hosts(4, "n", () => true));
  const T0 = w.net.now();
  const old = { v: 1, at: T0 - 21 * H, g: {}, t: {} };
  for (let i = 0; i < 4; i++) { old.g[w.keyOf(i)] = "P1"; old.t[w.keyOf(i)] = T0 - 21 * H; }
  w.store.set("panels:v1", JSON.stringify(old));
  const cat = await fresh("catalog.js");
  assert.ok(cat.panelsStale());
  let out;
  for (let i = 0; i < 10 && out !== "done"; i++) out = (await w.call(cat.healthStep({ kind: "full" }))).out;
  assert.equal(out, "done");
  // Written, the map would count as fresh for 20 h with no account confirmed: the failover's same-panel step would have no
  // account from hour 24 of the last confirmation until the next day's check.
  assert.deepEqual(JSON.parse(w.store.get("panels:v1")), old, "the map as it was");
  assert.ok(!cat.panelsStale(), "the screen's next ticks do not start it again");
  await w.net.run(w.net.request(31 * 60000));
  assert.ok(cat.panelsStale(), "30 min later it is tried again");
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

test("a server list past its 6 h: En vivo paints from its feed with no bootstrap request first; the list is renewed after", async () => {
  const w = world(hosts(4, "s"), { feeds: true, listAgeH: 7 });
  w.store.set("panels:v1", freshPanels(w));
  w.store.set("browseTab", "live");
  const s = await screenOf(w, { tab: "live" });
  assert.ok(await s.until(async () => (await s.view()).includes("Canal")), "the feed painted");
  const feed = w.log.find((e) => e.n === "github" && e.path.includes("/live/"));
  assert.ok(!w.log.some((e) => e.n === "boot" && e.t < feed.end), "no bootstrap request before the content: " + JSON.stringify(w.log));
  assert.ok(await s.until(async () => sharedCat.serverListFresh()), "renewed in a later tick");
  const boot = w.log.filter((e) => e.n === "boot");
  assert.equal(boot.length, 1);
  assert.ok(boot[0].t >= feed.end);
  assert.equal(w.probes().length, 0, "nothing else is probed");
});

test("a server list past its 6 h, no feed: the quick check before the content takes the cached list; the renewal comes after", async () => {
  const w = world(hosts(6, "q"), { feeds: false, active: 1, listAgeH: 7 });
  w.store.set("panels:v1", freshPanels(w));
  w.store.set("health:v1", JSON.stringify({ ts: w.net.now() - 7 * H, online: [] }));
  const s = await screenOf(w, { tab: "movies" });
  const firstContent = () => w.probes().find((e) => e.action === "get_vod_streams");
  assert.ok(await s.until(async () => !!firstContent()), "the tab loaded");
  assert.deepEqual(w.probes().filter((e) => e.t < firstContent().t && e.action === null).map((e) => e.n), ["q1"], "the active server's quick check");
  assert.ok(!w.log.some((e) => e.n === "boot" && e.t < firstContent().t), "no bootstrap request before the content: " + JSON.stringify(w.log.filter((e) => e.n === "boot")));
  assert.ok(await s.until(async () => sharedCat.serverListFresh()), "renewed after the content");
  assert.equal(w.log.filter((e) => e.n === "boot").length, 1);
});

test("a server list past its 6 h: the Home from its feed first, the list renewed once after it", async () => {
  const w = world(hosts(4, "h"), { feeds: true, listAgeH: 7 });
  w.store.set("panels:v1", freshPanels(w));
  const s = await screenOf(w, { tab: "home" });
  assert.ok(await s.until(async () => (await s.view()).includes("Del feed")), "the feed painted");
  assert.ok(await s.until(async () => sharedCat.serverListFresh()), "renewed in a later tick");
  const feed = w.log.find((e) => e.n === "github" && e.path.includes("/home/"));
  const boot = w.log.filter((e) => e.n === "boot");
  assert.equal(boot.length, 1);
  assert.ok(boot[0].t >= feed.end, "after the feed");
  assert.equal(w.probes().length, 0, "nothing else is probed");
});

test("a server list past its 6 h and a bootstrap that does not answer: the renewal is tried once, then rests 30 min", async () => {
  const w = world(hosts(4, "z"), { feeds: true, listAgeH: 7, bootHangs: true });
  w.store.set("panels:v1", freshPanels(w));
  w.store.set("browseTab", "live");
  const s = await screenOf(w, { tab: "live" });
  const held = [];
  for (let i = 0; i < 8; i++) held.push(await s.tick());
  assert.ok((await s.view()).includes("Canal"), "the feed painted");
  const boot = w.log.filter((e) => e.n === "boot");
  assert.deepEqual(boot.map((e) => e.timeoutMs), [4000], "one try with its 4 s; tried every tick, each tick would hold Kino's call 4 s");
  assert.ok(held.every((h) => h <= 4000), JSON.stringify(held));
  assert.equal(sharedCat.serverListFresh(), false, "the cached list stays as it was");
});
