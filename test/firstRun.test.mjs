// The first open on a fresh install, in Kino's network in virtual time. Kino holds a call until every request it started
// settles, so `tick` here waits for them too and reports that held time (what the person waits for), as on a device.
// The race: the accounts of the picker's order (Spanish first), 3 probes in flight, at most one per host, a failed one
// replaced at once by the next, each with 2.5 s clipped to the race's 9 s; the first good answer is chosen and its feed paints
// in the same tick; the full health check runs only after the first content. A dead account never wins, a late answer never
// moves the pick, an account in another language never wins while a Spanish one is in flight or left to race. When the race finds none, the
// health check and the automatic pick over the accounts that answered it, in one tick when it fits; the manual picker only
// when that finds none either.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { sealer } from "./helpers/feeds.mjs";
import { keyOf, isDead } from "../src/panels.js";

const INDEX = JSON.parse(readFileSync(new URL("./fixtures/index-categories.json", import.meta.url), "utf8"));
const H = 3600000;
const BOOT = 600; // the bootstrap's answer time in these worlds: the race starts then
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });
const { sealV2, withCrypto } = sealer();

const feedOf = (key, at) => ({ v: 1, serverKey: key, at: at - 2 * H, lang: "es", langs: ["es"], slides: [], rows: [{ id: "vod-1", title: "Estrenos del feed", items: [{ id: "m1", ref: "vod:1", title: "Uno" }] }] });

// accounts: [{ id, host, flag, does: "ok" | "dead" | "hang" | "refuse", ms }], in the service's order. An answer slower than
// the request's timeoutMs is Kino's timeout at timeoutMs, as on a device.
function world(accounts, { storage = {}, feeds = true, bootHangs = false } = {}) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 17, 12) });
  Date.now = net.now;
  const srvOf = (a) => ({ url: `http://${a.host}`, username: "u" + a.id, password: "p" + a.id });
  const text = accounts.map((a) => `http://${a.host}/get.php?username=u${a.id}&password=p${a.id} [${a.flag}]`).join("\n");
  const log = [];
  const live = new Map();
  const peak = new Map();
  const inflight = new Set();
  // Every request is logged with its start (t) and, once it settles, its end.
  const track = (entry, p) => {
    inflight.add(p);
    p.then(() => { entry.end = net.now(); inflight.delete(p); });
    return p;
  };
  const within = (init, ms, out) => {
    const limit = init && init.timeoutMs;
    return limit && ms > limit ? net.request(limit).then(() => kinoError("timeout", "the request took too long")) : net.request(ms).then(out);
  };
  const routes = [(url, init) => {
    const u = new URL(url);
    const t = net.now();
    if (u.hostname === "vegetatvv2.duckdns.org") {
      const e = { n: "boot", t, timeoutMs: init && init.timeoutMs };
      log.push(e);
      if (bootHangs) return track(e, net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "the request took too long")));
      return track(e, net.request(BOOT).then(() => res(200, { ok: true, servers_text: text })));
    }
    if (u.hostname === "raw.githubusercontent.com") {
      const m = /\/kino-plugin-ultrahd\/data\/home\/([^/.]+)\.v2\.enc\.json$/.exec(u.pathname);
      const e = { n: "github", feed: m ? m[1] : null, t, timeoutMs: init && init.timeoutMs };
      log.push(e);
      if (m && feeds) return track(e, net.request(250).then(() => res(200, sealV2(feedOf(m[1], net.now())))));
      if (u.pathname.endsWith("/categories.json")) return track(e, net.request(300).then(() => res(200, INDEX)));
      return track(e, net.request(150).then(() => res(404, "404: Not Found")));
    }
    const a = accounts.find((x) => x.host === u.hostname && "u" + x.id === param(url, "username"));
    if (!a) return undefined;
    const e = { n: a.id, action: param(url, "action"), t, timeoutMs: init && init.timeoutMs };
    log.push(e);
    const h = u.hostname;
    live.set(h, (live.get(h) || 0) + 1);
    peak.set(h, Math.max(peak.get(h) || 0, live.get(h)));
    const end = (out) => { live.set(h, live.get(h) - 1); return out; };
    const action = param(url, "action");
    let p;
    if (a.does === "hang") p = net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "the request took too long"));
    else if (a.does === "refuse") p = within(init, a.ms || 50, () => kinoError("network", "connection refused"));
    else if (a.does === "dead") p = within(init, a.ms || 100, () => res(200, { user_info: { auth: 0, status: "Invalid" } }));
    else if (action === "get_vod_categories" || action === "get_series_categories") p = within(init, a.ms || 1000, () => res(200, [{ category_id: "1", category_name: "ACCION" }]));
    else if (action === "get_vod_streams") p = within(init, a.ms || 1000, () => res(200, [{ stream_id: 11, name: "Película en vivo", category_id: "1", container_extension: "mp4" }]));
    else p = within(init, a.ms || 1000, () => res(200, []));
    return track(e, p.then(end));
  }];
  const k = installKino({ routes, storage });
  withCrypto(k.kino);
  const keyFor = (id) => keyOf(srvOf(accounts.find((a) => a.id === id)));
  const srvs = () => JSON.parse(k.store.get("srvs") || "null");
  const chosenId = () => { const st = srvs(); return st && st.chosen ? accounts.find((a) => keyFor(a.id) === st.chosen).id : null; };
  const probes = () => log.filter((e) => e.action);
  const probe = (id) => probes().find((e) => e.n === id);
  const drain = async () => { while (inflight.size) await Promise.all([...inflight]); };
  return { ...k, net, log, peak, keyFor, srvs, chosenId, probes, probe, srvOf, drain };
}

async function screenOf(w) {
  const screen = await fresh("screen.js");
  let state = {};
  const s = { last: null };
  // One tick as Kino runs it: the event, then the wait for every request still in flight. Returns the held time;
  // s.last.answered is when the plugin's own answer came.
  s.tick = async () => {
    const t0 = w.net.now();
    const r = await w.net.run(screen.screenEvent({ name: "tick", state, lang: "es" }));
    const answered = w.net.now() - t0;
    await w.net.run(w.drain());
    state = { ...state, ...(r && r.state) };
    s.last = { t0, answered, held: w.net.now() - t0 };
    return s.last.held;
  };
  s.view = async () => JSON.stringify(await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } }));
  return s;
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
  const held = await s.tick();
  // The race: 3 accounts at once, 2.5 s each; nothing failed before m2 answered, so nobody else started; no health check.
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["e1", "m1", "m2"]);
  assert.ok(w.probes().every((e) => e.timeoutMs === 2500 && e.t === w.probes()[0].t), "all three start together, 2.5 s each");
  assert.equal(w.chosenId(), "m2", "the first good answer wins");
  assert.equal(w.store.get("srvChosen:v1"), "1");
  // The picked server's feed came in the same tick, and the screen shows it.
  const feedReq = w.log.filter((e) => e.n === "github" && e.feed);
  assert.deepEqual(feedReq.map((e) => e.feed), [w.keyFor("m2")]);
  assert.ok(feedReq[0].timeoutMs > 0 && feedReq[0].timeoutMs <= 16000, "the feed has a deadline inside the call");
  assert.ok(s.last.answered <= BOOT + 700 + 250 + 50, `the plugin answered after ${s.last.answered} ms (bootstrap 600 + race 700 + feed 250)`);
  // Kino holds the call until e1's probe ends: its own 2.5 s timeout, never more.
  assert.ok(held <= BOOT + 2500 + 50, `the call as Kino holds it: ${held} ms`);
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

// The Redmi run of 2026-11-17 (D1): the top Spanish accounts were capitanhero.com (auth 0 in ~1.05 s), xiques96sa.site
// (auth 0 in ~0.88 s) and line.krishkaz.com (silent: it held the first tick until the race's own timeout); a fixed race of those 3 found nothing, and the person
// got the manual picker at ~57 s. nexotvplus.com, the next one, answers well.
test("D1: two dead accounts and a silent host first; the race replaces them at once and picks the good account in ~3 s", async () => {
  const w = world([
    { id: "cap", host: "cap.example", flag: "🇪🇸", does: "dead", ms: 1050 },
    { id: "xiq", host: "xiq.example", flag: "🇪🇸", does: "dead", ms: 880 },
    { id: "kri", host: "kri.example", flag: "🇪🇸", does: "hang" },
    { id: "nex", host: "nex.example", flag: "🇪🇸", does: "ok", ms: 1500 },
    { id: "fv", host: "fv.example", flag: "🇪🇸", does: "ok", ms: 2000 },
    { id: "zee", host: "zee.example", flag: "🇪🇸", does: "hang" },
    { id: "tmp", host: "tmp.example", flag: "🇲🇽", does: "hang" },
    { id: "us", host: "us.example", flag: "🇺🇸", does: "ok", ms: 100 },
  ]);
  const s = await screenOf(w);
  const held = await s.tick();
  const t0 = s.last.t0;
  assert.equal(w.chosenId(), "nex", "the good account after the two dead ones");
  // xiq's auth 0 at 600 + 880 starts nex at once; cap's at 600 + 1050 starts fv. nex answers at 600 + 880 + 1500.
  assert.equal(w.probe("nex").t - t0, BOOT + 880, "nex starts the moment xiq answers auth 0");
  assert.equal(w.probe("fv").t - t0, BOOT + 1050, "fv starts the moment cap answers auth 0");
  assert.equal(w.srvs().okAt - t0, BOOT + 880 + 1500, "picked 2.98 s into the tick");
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["cap", "fv", "kri", "nex", "xiq"], "no other account was needed");
  assert.ok(isDead(w.srvOf({ id: "cap", host: "cap.example" }), w.net.now()) && isDead(w.srvOf({ id: "xiq", host: "xiq.example" }), w.net.now()), "the dead accounts are remembered dead, as always");
  assert.equal(Math.max(...w.peak.values()), 1, "one probe per host at a time");
  // The feed came in the same tick; kri's probe timed out (its own 2.5 s) at 3.1 s, before the feed was in, so the call
  // ends with fv's late answer at 3.65 s (with 4 s it ended at 4.6 s, 1.4 s after the content was ready).
  assert.deepEqual(w.log.filter((e) => e.feed).map((e) => e.feed), [w.keyFor("nex")]);
  assert.equal(w.probe("kri").end - t0, BOOT + 2500, "the silent host's probe ends at its 2.5 s");
  assert.ok(held <= BOOT + 1050 + 2000 + 50, `the call as Kino holds it: ${held} ms`);
  const v = await s.view();
  assert.ok(v.includes("Estrenos del feed") && !v.includes('"verifying"') && !v.includes('"fpPage"'), "content after the first tick, never the picker");

  // The same list in the service's real order and with the answer times the device measured (hosts renamed): the two dead
  // accounts, two in another language (one silent), the silent Spanish one, then fv, tre and nex. xiq's auth 0 starts fv,
  // which answers 739 ms later.
  const real = world([
    { id: "cap", host: "cap.example", flag: "🇲🇽", does: "dead", ms: 1053 },
    { id: "xiq", host: "xiq.example", flag: "🇲🇽", does: "dead", ms: 883 },
    { id: "znn", host: "znn.example", flag: "🌐", does: "ok", ms: 483 },
    { id: "zee", host: "zee.example", flag: "🌐", does: "hang" },
    { id: "kri", host: "kri.example", flag: "🇪🇸", does: "hang" },
    { id: "fv", host: "fv.example", flag: "🇪🇸", does: "ok", ms: 739 },
    { id: "tre", host: "tre.example", flag: "🇪🇸", does: "ok", ms: 636 },
    { id: "nex", host: "nex.example", flag: "🇲🇽", does: "ok", ms: 563 },
  ]);
  const sr = await screenOf(real);
  const heldReal = await sr.tick();
  assert.equal(real.chosenId(), "fv");
  assert.equal(real.srvs().okAt - sr.last.t0, BOOT + 883 + 739, "picked 2.2 s into the tick");
  assert.deepEqual(real.probes().map((e) => e.n), ["cap", "xiq", "kri", "fv", "tre"], "Spanish first; nothing in another language");
  assert.ok(heldReal <= BOOT + 2500 + 50, `the call as Kino holds it: ${heldReal} ms (4 s before: ${BOOT + 4000})`);
  assert.ok((await sr.view()).includes("Estrenos del feed"));
});

test("hanging accounts: each probe ends by its own 2.5 s and none outlives the race's 9 s; the 6th account still wins", async () => {
  const hang = (n) => ({ id: "h" + n, host: `h${n}.example`, flag: "🇪🇸", does: "hang" });
  const w = world([hang(1), hang(2), hang(3), hang(4), hang(5), { id: "g6", host: "g6.example", flag: "🇲🇽", does: "ok", ms: 1000 }]);
  const s = await screenOf(w);
  const held = await s.tick();
  assert.equal(w.chosenId(), "g6", "the second wave finds it");
  for (const e of w.probes()) assert.ok(e.end - e.t <= 2500, `${e.n} held ${e.end - e.t} ms`);
  assert.equal(w.srvs().okAt - s.last.t0, BOOT + 2500 + 1000);
  assert.ok(held <= BOOT + 2500 + 2500 + 50, `held until the second wave's hangs time out: ${held} ms`);
  assert.ok((await s.view()).includes("Estrenos del feed"));

  // Nine hanging accounts: three waves (two with 4 s); every probe ends by the race's deadline.
  const w2 = world([1, 2, 3, 4, 5, 6, 7, 8, 9].map(hang));
  const s2 = await screenOf(w2);
  const held2 = await s2.tick();
  assert.equal(w2.probes().length, 9);
  for (const e of w2.probes()) assert.ok(e.end - e.t <= 2500 && e.end - s2.last.t0 <= BOOT + 9000, `${e.n}: ${e.t}-${e.end}`);
  assert.ok(held2 <= BOOT + 9000, `the race's tick: ${held2} ms`);
  assert.equal(w2.chosenId(), null);
});

test("the race finds none, a slow account answers the health check: picked automatically in the same tick, never the picker", async () => {
  const w = world([
    { id: "d1", host: "d1.example", flag: "🇪🇸", does: "dead", ms: 1000 },
    { id: "d2", host: "d2.example", flag: "🇲🇽", does: "dead", ms: 900 },
    { id: "h1", host: "h1.example", flag: "🇪🇸", does: "hang" },
    { id: "s1", host: "s1.example", flag: "🇪🇸", does: "ok", ms: 5000 }, // slower than the race's 2.5 s
  ]);
  const s = await screenOf(w);
  const held = await s.tick();
  // Race: d1, d2, h1 at 600; d2's auth 0 starts s1 at 1500, which times out at 4000: no winner, 12 s left of the tick's
  // 16 s. The health check follows in the same tick (7.5 s probes, 4 s kept for the feed), s1 answers it, the pick takes it.
  assert.equal(w.chosenId(), "s1");
  assert.equal(w.store.get("srvChosen:v1"), "1");
  assert.equal(w.probes().filter((e) => e.n === "s1").length, 2, "the race's probe and the health check's");
  assert.equal(w.probes().filter((e) => e.n === "d1" || e.n === "d2").length, 2, "the dead accounts cost no second request");
  assert.ok(w.store.get("health:v1"), "the health check ran");
  assert.deepEqual(w.log.filter((e) => e.feed).map((e) => e.feed), [w.keyFor("s1")], "and the feed, all in the first tick");
  assert.ok(held <= 16000, `one tick: ${held} ms`);
  const v = await s.view();
  assert.ok(v.includes("Estrenos del feed") && !v.includes('"fpPage"'), "content, never the picker");
});

test("a slow network (every account answers in 5 s): the race runs out its 9 s; health check, pick and feed share the next tick", async () => {
  const w = world([1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: "s" + n, host: `s${n}.example`, flag: "🇪🇸", does: "ok", ms: 5000 })));
  const s = await screenOf(w);
  const first = await s.tick();
  assert.equal(w.chosenId(), null);
  assert.equal(w.probes().length, 7, "three waves (3, 3, 1): every account got its 2.5 s");
  assert.ok(first <= BOOT + 9000, `the race's tick: ${first} ms`);
  assert.ok(!w.store.get("health:v1"), "no time left for the health check in the race's tick");
  assert.ok((await s.view()).includes('"verifying"'));
  const second = await s.tick();
  assert.equal(w.chosenId(), "s1", "the first of the order among those that answered the health check");
  assert.deepEqual(w.log.filter((e) => e.feed).map((e) => e.feed), [w.keyFor("s1")]);
  assert.ok(second <= 16000, `health + pick + feed in one tick: ${second} ms`);
  const v = await s.view();
  assert.ok(v.includes("Estrenos del feed") && !v.includes('"fpPage"'));
});

test("no account answers anything: the health check, then the manual picker, in the same tick; nothing is chosen", async () => {
  const w = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "hang" },
    { id: "e1", host: "e1.example", flag: "🇪🇸", does: "refuse" },
    { id: "m2", host: "m2.example", flag: "🇲🇽", does: "dead" },
    { id: "c1", host: "c1.example", flag: "🇨🇴", does: "refuse" },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "hang" },
  ]);
  const s = await screenOf(w);
  const held = await s.tick();
  assert.equal(w.chosenId(), null);
  assert.ok(held <= 16000, `${held} ms`);
  assert.ok(!w.log.some((e) => e.n === "github" && e.feed), "no feed without a server");
  assert.ok(w.store.get("health:v1"), "the health check ran");
  assert.equal(w.probes().filter((e) => e.n === "m2").length, 1, "the dead account is not probed again");
  const v = await s.view();
  assert.ok(v.includes('"fpPage"'), "the manual picker after the first tick");
  assert.ok(v.includes("c1.example") && v.includes("u1.example") && !v.includes("m2.example"));
  assert.equal(w.chosenId(), null);
  assert.equal(w.store.get("srvChosen:v1"), undefined);
});

test("the service's list does not answer: the health check tries it once more, the pick sends nothing, then the picker's error", async () => {
  const w = world([{ id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 500 }], { bootHangs: true });
  const s = await screenOf(w);
  const held = await s.tick();
  // The race's list request times out at 4 s; the health check (10+ s left) asks once more, 4 s; the pick has no answers.
  assert.deepEqual(w.log.map((e) => [e.n, e.timeoutMs]), [["boot", 4000], ["boot", 4000]]);
  assert.ok(held <= 2 * 4000 + 50, `${held} ms`);
  assert.equal(w.probes().length, 0);
  assert.ok(!(await s.view()).includes('"fpPage"'));
  await s.tick(); // the picker's own list request, which fails too
  assert.ok((await s.view()).includes('"fpFail"'), "the picker's error, with its retry");
  assert.equal(w.chosenId(), null);
});

test("one probe per host at a time: the next account of a busy host waits; a host that never answers is skipped", async () => {
  const w = world([
    { id: "a1", host: "a.example", flag: "🇲🇽", does: "dead", ms: 300 },
    { id: "b1", host: "b.example", flag: "🇪🇸", does: "hang" },
    { id: "c1", host: "c.example", flag: "🇲🇽", does: "hang" },
    { id: "a2", host: "a.example", flag: "🇲🇽", does: "dead", ms: 300 },
    { id: "b2", host: "b.example", flag: "🇪🇸", does: "ok", ms: 100 },
    { id: "a3", host: "a.example", flag: "🇪🇸", does: "ok", ms: 500 },
  ]);
  const s = await screenOf(w);
  await s.tick();
  // a1, b1, c1 start; a1's auth 0 frees host a: a2 (b2 waits for b1), then a3, which wins.
  assert.deepEqual(w.probes().map((e) => e.n), ["a1", "b1", "c1", "a2", "a3"]);
  assert.equal(w.chosenId(), "a3");
  assert.equal(Math.max(...w.peak.values()), 1);

  // Two accounts on one host, the first silent: the host is skipped for the rest of the race; the health check that follows
  // in the same tick finds the good account, which the automatic pick takes.
  const one = world([
    { id: "s1", host: "solo.example", flag: "🇪🇸", does: "hang" },
    { id: "t1", host: "t.example", flag: "🇪🇸", does: "dead", ms: 200 },
    { id: "s2", host: "solo.example", flag: "🇪🇸", does: "ok", ms: 500 },
  ]);
  const s2 = await screenOf(one);
  await s2.tick();
  const race = one.probes().filter((e) => e.t - s2.last.t0 < BOOT + 2500);
  assert.deepEqual(race.map((e) => e.n), ["s1", "t1"], "s2 waited for its host");
  // Had the race not skipped the host, s2 would have started there when s1 timed out (with the race's 2.5 s) and won it.
  const s2probes = one.probes().filter((e) => e.n === "s2");
  assert.equal(s2probes.length, 1);
  assert.ok(s2probes[0].timeoutMs > 2500, `s2's only probe is the health check's (${s2probes[0].timeoutMs} ms), not the race's`);
  assert.ok(one.store.get("health:v1"), "the health check ran in the same tick");
  assert.equal(one.chosenId(), "s2", "found by the health check, picked automatically");
});

test("a probe that starts late in the race gets only what is left of its 9 s; the race never outlives it", async () => {
  const dead = (id) => ({ id, host: `${id}.example`, flag: "🇪🇸", does: "dead", ms: 2400 });
  const hang = (id) => ({ id, host: `${id}.example`, flag: "🇪🇸", does: "hang" });
  const w = world([dead("d1"), hang("h1"), hang("h2"), dead("d2"), dead("d3"), dead("d4"), hang("h3"), hang("h4"), hang("h5"), hang("h6")]);
  const s = await screenOf(w);
  const held = await s.tick();
  // d1-d4 free their slot after 2.4 s, h1-h3 after 2.5 s; h6 starts at 600 + 7300 (when h3 times out), with 1.7 s left of
  // the race (600 + 9000).
  assert.equal(w.probe("h6").t - s.last.t0, BOOT + 7300);
  assert.equal(w.probe("h6").timeoutMs, 1700, "clipped to the race's deadline");
  for (const e of w.probes()) assert.ok(e.end - s.last.t0 <= BOOT + 9000, `${e.n} ended at ${e.end - s.last.t0} ms`);
  assert.ok(held <= BOOT + 9000, `the race's tick: ${held} ms`);
  assert.equal(w.chosenId(), null);
});

test("a dead account answering first is remembered dead and never chosen; a late good answer never moves the pick", async () => {
  const w = world([
    { id: "d1", host: "d1.example", flag: "🇲🇽", does: "dead", ms: 100 },
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 900 },
    { id: "m2", host: "m2.example", flag: "🇪🇸", does: "ok", ms: 1500 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 100 },
  ]);
  const s = await screenOf(w);
  await s.tick(); // waits for m2's late answer too, as Kino does
  assert.equal(w.chosenId(), "m1");
  assert.ok(isDead(w.srvOf({ id: "d1", host: "d1.example" }), w.net.now()), "the dead account is remembered for a day");
  assert.ok(w.probe("m2").end > w.probe("m1").end, "m2 answered well, late");
  assert.equal(w.chosenId(), "m1");
  assert.equal(w.srvs().list[w.srvs().idx].url, "http://m1.example");
});

test("an account in another language never wins while a Spanish one is in flight; it wins once they all fail", async () => {
  const w = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 2500 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 100 },
  ]);
  const s = await screenOf(w);
  await s.tick();
  assert.deepEqual(w.probes().map((e) => e.n).sort(), ["m1", "u1"], "a free slot takes the next account in the order");
  assert.equal(w.chosenId(), "m1", "u1 answered first but waited for m1");

  // The Spanish accounts sit on two hosts, so the third slot takes the account in another language, which answers first. The
  // Spanish accounts left still race as their hosts free up, and the one that answers well wins.
  const w3 = world([
    { id: "a1", host: "a.example", flag: "🇪🇸", does: "dead", ms: 1000 },
    { id: "b1", host: "b.example", flag: "🇪🇸", does: "dead", ms: 1000 },
    { id: "a2", host: "a.example", flag: "🇪🇸", does: "dead", ms: 1000 },
    { id: "b2", host: "b.example", flag: "🇪🇸", does: "dead", ms: 1000 },
    { id: "a3", host: "a.example", flag: "🇪🇸", does: "ok", ms: 800 },
    { id: "n1", host: "n.example", flag: "🇺🇸", does: "ok", ms: 300 },
  ]);
  const s3 = await screenOf(w3);
  await s3.tick();
  assert.deepEqual(w3.probes().map((e) => e.n), ["a1", "b1", "n1", "a2", "b2", "a3"], "no other account in another language started");
  assert.equal(w3.chosenId(), "a3", "a Spanish account left untried never loses to one in another language");
  assert.equal(Math.max(...w3.peak.values()), 1);

  const w2 = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "dead", ms: 1500 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 100 },
  ]);
  const s2 = await screenOf(w2);
  await s2.tick();
  assert.equal(w2.chosenId(), "u1");
  assert.equal(w2.srvs().okAt, w2.probe("m1").end, "taken the moment m1 answered auth 0");
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

test("a server the person chose: no race, no health check first; the feed paints and the choice is untouched", async () => {
  const accounts = [
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 500 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 200 },
  ];
  const now = Date.UTC(2026, 10, 17, 12);
  const list = accounts.map((a) => ({ url: `http://${a.host}`, username: "u" + a.id, password: "p" + a.id, name: a.flag }));
  const chosen = keyOf(list[1]);
  const stored = () => ({ srvs: JSON.stringify({ ts: now, v: 2, mig: 1, list, idx: 1, ok: true, okAt: now, chosen }), "srvChosen:v1": "1" });
  const w = world(accounts, { storage: stored() });
  const s = await screenOf(w);
  await s.tick();
  assert.equal(w.probes().length, 0);
  assert.deepEqual(w.log.filter((e) => e.feed).map((e) => e.feed), [chosen]);
  assert.ok((await s.view()).includes("Estrenos del feed"));
  assert.equal(w.srvs().chosen, chosen);
  // Asked directly (the screen's flag lost, say), the race and the automatic pick keep the choice and send nothing.
  const w2 = world(accounts, { storage: stored() });
  const cat = await fresh("catalog.js");
  for (const pick of [cat.raceFirstServer, cat.autoPickServer]) {
    const r = await w2.net.run(pick({ until: w2.net.now() + 16000 }));
    assert.ok(r.ok && r.kept);
  }
  assert.equal(w2.probes().length, 0);
  assert.equal(w2.srvs().chosen, chosen);
  assert.equal(w2.srvs().idx, 1);
});

test("first run, no feed for the picked account: the Home's loading layout, its rails before the health check, which comes last", async () => {
  const w = world([
    { id: "m1", host: "m1.example", flag: "🇲🇽", does: "ok", ms: 400 },
    { id: "m2", host: "m2.example", flag: "🇲🇽", does: "ok", ms: 600 },
    { id: "u1", host: "u1.example", flag: "🇺🇸", does: "ok", ms: 200 },
  ], { feeds: false });
  const s = await screenOf(w);
  await s.tick();
  assert.equal(w.chosenId(), "m1", "a Spanish account wins over a faster one in another language");
  const v0 = await s.view();
  assert.ok(!v0.includes('"verifying"') && v0.includes('"heroSkeleton"'), "the Home's loading layout, not Verificando");
  const health = () => !!w.store.get("health:v1");
  const raceProbes = w.probes().length;
  let shown = false;
  for (let i = 0; i < 6 && !shown; i++) { await s.tick(); shown = (await s.view()).includes("Película en vivo"); }
  assert.ok(shown, "a rail from the picked account");
  assert.ok(!health(), "no health check before the first rail");
  assert.ok(w.probes().slice(raceProbes).every((e) => e.n === "m1"), "only the picked account until then");
  for (let i = 0; i < 30 && !health(); i++) await s.tick();
  assert.ok(health(), "the health check ran last");
  assert.equal(w.chosenId(), "m1");
});

test("a list without a Spanish account: the picker's order races", async () => {
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
