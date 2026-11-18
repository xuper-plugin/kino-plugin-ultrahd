// The first open on a fresh install, in Kino's network in virtual time: the top 3 accounts of the picker's order (Spanish
// first) race in the first tick with 4 s timeouts, the first good answer is chosen and its feed paints right after that same
// tick; the full health check runs only after the first content. A dead account never wins, a late answer never moves the
// pick, no host gets more than 3 of the race's requests, and when none of the 3 answers the plan falls back to the health
// check and the manual picker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";
import { keyOf, isDead } from "../src/panels.js";

const INDEX = JSON.parse(readFileSync(new URL("./fixtures/index-categories.json", import.meta.url), "utf8"));
const H = 3600000;
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const { seal, withCrypto } = sealer();

const feedOf = (key, at) => ({ v: 1, serverKey: key, at: at - 2 * H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "vod-1", title: "Estrenos del feed", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }] });

// accounts: [{ id, host, flag, does: "ok" | "dead" | "hang" | "refuse", ms }], in the service's order.
function world(accounts, { storage = {}, feeds = true } = {}) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 17, 12) });
  Date.now = net.now;
  const srvOf = (a) => ({ url: `http://${a.host}`, username: "u" + a.id, password: "p" + a.id });
  const text = accounts.map((a) => `http://${a.host}/get.php?username=u${a.id}&password=p${a.id} [${a.flag}]`).join("\n");
  const log = [];
  const live = new Map();
  const peak = new Map();
  const routes = [(url, init) => {
    const u = new URL(url);
    const t = net.now();
    if (u.hostname === "vegetatvv2.duckdns.org") { log.push({ n: "boot", t }); return net.request(600).then(() => res(200, { ok: true, servers_text: text })); }
    if (u.hostname === "raw.githubusercontent.com") {
      const m = /\/kino-plugin-ultrahd\/data\/home\/([^/.]+)\.enc\.json$/.exec(u.pathname);
      log.push({ n: "github", feed: m ? m[1] : null, t, timeoutMs: init && init.timeoutMs });
      if (m && feeds) return net.request(250).then(() => res(200, seal(feedOf(m[1], net.now()))));
      if (u.pathname.endsWith("/categories.json")) return net.request(300).then(() => res(200, INDEX));
      return net.request(150).then(() => res(404, "404: Not Found"));
    }
    const a = accounts.find((x) => x.host === u.hostname && "u" + x.id === param(url, "username"));
    if (!a) return undefined;
    log.push({ n: a.id, action: param(url, "action"), t, timeoutMs: init && init.timeoutMs });
    const h = u.hostname;
    live.set(h, (live.get(h) || 0) + 1);
    peak.set(h, Math.max(peak.get(h) || 0, live.get(h)));
    const end = (out) => { live.set(h, live.get(h) - 1); return out; };
    if (a.does === "hang") return net.request((init && init.timeoutMs) || 15000).then(() => end(kinoError("timeout", "timed out")));
    if (a.does === "refuse") return net.request(a.ms || 50).then(() => end(kinoError("network", "connection refused")));
    if (a.does === "dead") return net.request(a.ms || 100).then(() => end(res(200, { user_info: { auth: 0, status: "Invalid" } })));
    const action = param(url, "action");
    if (action === "get_vod_categories" || action === "get_series_categories") return net.request(a.ms || 1000).then(() => end(res(200, [{ category_id: "1", category_name: "ACCION" }])));
    if (action === "get_vod_streams") return net.request(a.ms || 1000).then(() => end(res(200, [{ stream_id: 11, name: "Película en vivo", category_id: "1", container_extension: "mp4" }])));
    return net.request(a.ms || 1000).then(() => end(res(200, [])));
  }];
  const k = installKino({ routes, storage });
  withCrypto(k.kino);
  const keyFor = (id) => keyOf(srvOf(accounts.find((a) => a.id === id)));
  const srvs = () => JSON.parse(k.store.get("srvs") || "null");
  const chosenId = () => { const st = srvs(); return st && st.chosen ? accounts.find((a) => keyFor(a.id) === st.chosen).id : null; };
  const probes = () => log.filter((e) => e.action);
  return { ...k, net, log, peak, keyFor, srvs, chosenId, probes, srvOf };
}

async function screenOf(w) {
  const screen = await fresh("screen.js");
  let state = {};
  const tick = async () => {
    const t0 = w.net.now();
    const r = await w.net.run(screen.screenEvent({ name: "tick", state, lang: "es" }));
    state = { ...state, ...(r && r.state) };
    return w.net.now() - t0;
  };
  const view = async () => JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  // Lets requests still in flight (a race's late answers) finish in virtual time.
  const settle = (ms) => w.net.run(w.net.request(ms));
  return { tick, view, settle };
}

test("first run: the race picks in the first tick and the feed paints right after it; the health check comes after the content", async () => {
  const w = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 1200 },
    { id: "e1", host: "e1.example", flag: "🇪🇸", does: "hang" },
    { id: "m2", host: "m2.example", flag: "🇲🇽", does: "ok", ms: 700 },
    { id: "c1", host: "c1.example", flag: "🇨🇴", does: "ok", ms: 300 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 200 },
  ]);
  const s = await screenOf(w);
  assert.ok((await s.view()).includes('"verifying"'), "Verificando before the first tick");
  const took = await s.tick();
  // The race: the top 3 Spanish accounts at once, 4 s each; no health check (c1 and u1 untouched).
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["e1", "m1", "m2"]);
  assert.ok(w.probes().every((e) => e.timeoutMs === 4000 && e.t === w.probes()[0].t), "all three start together, 4 s each");
  assert.equal(w.chosenId(), "m2", "the first good answer wins");
  assert.equal(w.store.get("srvChosen:v1"), "1");
  // The picked server's feed came in the same tick, and the screen shows it.
  const feedReq = w.log.filter((e) => e.n === "github" && e.feed);
  assert.deepEqual(feedReq.map((e) => e.feed), [w.keyFor("m2")]);
  assert.ok(feedReq[0].timeoutMs > 0 && feedReq[0].timeoutMs <= 16000, "the feed has a deadline inside the call");
  assert.ok(took <= 2000, `first content after ${took} ms of the first tick (bootstrap 600 + race 700 + feed 250)`);
  const v = await s.view();
  assert.ok(v.includes("Estrenos del feed") && !v.includes('"verifying"'), "the feed paints after the first tick");
  // The full health check runs later (the daily one, last), and keeps the pick.
  const firstHealth = () => w.probes().find((e) => e.n === "u1" || e.n === "c1");
  for (let i = 0; i < 12 && !firstHealth(); i++) await s.tick();
  assert.ok(firstHealth(), "the health check ran after the first content");
  assert.ok(firstHealth().t > feedReq[0].t);
  assert.equal(w.chosenId(), "m2");
  assert.equal(w.srvs().list[w.srvs().idx].url, "http://m2.example");
});

test("a dead account answering first is remembered dead and never chosen; a late good answer never moves the pick", async () => {
  const w = world([
    { id: "d1", host: "d1.example", flag: "🇲🇽", does: "dead", ms: 100 },
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 900 },
    { id: "m2", host: "m2.example", flag: "🇪🇸", does: "ok", ms: 1500 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 100 },
  ]);
  const s = await screenOf(w);
  await s.tick();
  assert.equal(w.chosenId(), "m1");
  assert.ok(isDead(w.srvOf({ id: "d1", host: "d1.example" }), w.net.now()), "the dead account is remembered for a day");
  await s.settle(3000); // m2 answers well, late
  assert.ok(w.probes().some((e) => e.n === "m2"));
  assert.equal(w.chosenId(), "m1");
  assert.equal(w.srvs().list[w.srvs().idx].url, "http://m1.example");
});

test("an account already known dead never races: the next one in the order takes its place", async () => {
  const accounts = [
    { id: "d1", host: "d1.example", flag: "🇲🇽", does: "dead" },
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 900 },
    { id: "m2", host: "m2.example", flag: "🇪🇸", does: "ok", ms: 800 },
    { id: "m3", host: "m3.example", flag: "🇲🇽", does: "ok", ms: 700 },
  ];
  const w = world(accounts);
  const { noteDead } = await import("../src/panels.js");
  noteDead(w.srvOf(accounts[0]), w.net.now());
  const s = await screenOf(w);
  await s.tick();
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["m1", "m2", "m3"]);
  assert.equal(w.chosenId(), "m3");
});

test("none of the three answers: the health check, then the manual picker; nothing is chosen for the person", async () => {
  const w = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "hang" },
    { id: "e1", host: "e1.example", flag: "🇪🇸", does: "refuse" },
    { id: "m2", host: "m2.example", flag: "🇲🇽", does: "dead" },
    { id: "c1", host: "c1.example", flag: "🇨🇴", does: "ok", ms: 300 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 200 },
  ]);
  const s = await screenOf(w);
  const took = await s.tick();
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["e1", "m1", "m2"]);
  assert.ok(took <= 600 + 4000 + 100, `the race gave up within its 4 s (${took} ms)`);
  assert.equal(w.chosenId(), null);
  assert.ok((await s.view()).includes('"verifying"'), "Verificando while the health check runs");
  assert.ok(!w.log.some((e) => e.n === "github" && e.feed), "no feed without a server");
  await s.tick(); // health
  assert.ok(w.probes().some((e) => e.n === "c1") && w.probes().some((e) => e.n === "u1"), "the health check probed the rest");
  assert.equal(w.probes().filter((e) => e.n === "m2").length, 1, "the dead account is not probed again");
  await s.tick(); // pick
  const v = await s.view();
  assert.ok(v.includes('"fpPage"'), "the manual picker");
  assert.ok(v.includes("c1.example") && v.includes("u1.example") && !v.includes("m2.example"));
  assert.equal(w.chosenId(), null);
  assert.equal(w.store.get("srvChosen:v1"), undefined);
});

test("the race spreads over hosts and never sends one host more than 3 requests", async () => {
  const same = [1, 2, 3, 4].map((n) => ({ id: "a" + n, host: "same.example", flag: "🇲🇽", does: "ok", ms: 800 }));
  const w = world([...same, { id: "b1", host: "b.example", flag: "🇪🇸", does: "ok", ms: 1000 }, { id: "c1", host: "c.example", flag: "🇲🇽", does: "hang" }]);
  const s = await screenOf(w);
  await s.tick();
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["a1", "b1", "c1"], "one account per host first, in the picker's order");
  assert.equal(w.chosenId(), "a1");
  // Only one host in the list: three of its accounts race, never more.
  const one = world([1, 2, 3, 4, 5].map((n) => ({ id: "s" + n, host: "solo.example", flag: "🇪🇸", does: n < 4 ? "hang" : "ok", ms: 500 })));
  const s2 = await screenOf(one);
  await s2.tick();
  assert.equal(one.probes().length, 3);
  assert.ok(one.peak.get("solo.example") <= 3, "under Kino's 4 per host");
  assert.equal(one.chosenId(), null, "the 3 that raced hung: no pick");
});

test("a server the person chose: no race, no health check first; the feed paints and the choice is untouched", async () => {
  const accounts = [
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 500 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 200 },
  ];
  const now = Date.UTC(2026, 10, 17, 12);
  const list = accounts.map((a) => ({ url: `http://${a.host}`, username: "u" + a.id, password: "p" + a.id, name: a.flag }));
  const chosen = keyOf(list[1]);
  const w = world(accounts, { storage: { srvs: JSON.stringify({ ts: now, v: 2, mig: 1, list, idx: 1, ok: true, okAt: now, chosen }), "srvChosen:v1": "1" } });
  const s = await screenOf(w);
  await s.tick();
  assert.equal(w.probes().length, 0);
  assert.deepEqual(w.log.filter((e) => e.feed).map((e) => e.feed), [chosen]);
  assert.ok((await s.view()).includes("Estrenos del feed"));
  assert.equal(w.srvs().chosen, chosen);
});

test("first run, no feed for the picked account: its rails load before the health check, which comes last", async () => {
  const w = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 400 },
    { id: "m2", host: "m2.example", flag: "🇲🇽", does: "ok", ms: 600 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 200 },
  ], { feeds: false });
  const s = await screenOf(w);
  await s.tick();
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["m1", "m2"], "only Spanish accounts race while there is one");
  assert.equal(w.chosenId(), "m1");
  const health = () => w.probes().some((e) => e.n === "u1");
  let shown = false;
  for (let i = 0; i < 6 && !shown; i++) { await s.tick(); shown = (await s.view()).includes("Película en vivo"); }
  assert.ok(shown, "a rail from the picked account");
  assert.ok(!health(), "no health check before the first rail");
  assert.ok(w.probes().filter((e) => e.n !== "m1" && e.n !== "m2").length === 0);
  for (let i = 0; i < 30 && !health(); i++) await s.tick();
  assert.ok(health(), "the health check ran last");
  assert.equal(w.chosenId(), "m1");
});

test("a list without a Spanish account: the first 3 of the picker's order race", async () => {
  const w = world([
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 900 },
    { id: "b1", host: "b1.example", flag: "🇧🇷", does: "ok", ms: 500 },
    { id: "f1", host: "f1.example", flag: "🇫🇷", does: "hang" },
    { id: "g1", host: "g1.example", flag: "🇬🇧", does: "ok", ms: 100 },
  ]);
  const s = await screenOf(w);
  await s.tick();
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["b1", "f1", "u1"]);
  assert.equal(w.chosenId(), "b1");
});
