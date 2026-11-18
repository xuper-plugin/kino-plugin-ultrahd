// The guide burst (cache study #7). Kino asks `guide` for up to 50 channels per call as native En vivo lists them, and calls
// to a plugin run one at a time, so the 50 programme requests the guide sent at once (each through api(): its own backHome
// probe and the walk to other accounts) held En vivo's categories behind them 2.4-4.4 s on a Redmi (25-51 panel requests).
// Now: the first 12 channels, on the active server only, 4 at a time (Kino's requests per host), 3 s each; and api() calls
// that run together share one backHome probe.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf } from "../src/panels.js";

const H = 3600000;
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

function world({ prefix, active = 0, chosen = 0, epgMs = 250, hangIds = [], storage = {} } = {}) {
  const net = virtualNet({ start: Date.UTC(2026, 10, 18, 0) });
  Date.now = net.now;
  const list = ["a", "b", "c"].map((id) => ({ url: `http://${prefix}${id}.example`, username: "u" + id, password: "p" + id, name: "🇲🇽" }));
  const log = [];
  let live = 0;
  let peak = 0;
  const inflight = new Set();
  const routes = [(url, init) => {
    const u = new URL(url);
    const e = { host: u.hostname, action: param(url, "action"), id: param(url, "stream_id"), cat: param(url, "category_id"), timeoutMs: init && init.timeoutMs, t: net.now() };
    log.push(e);
    live++;
    peak = Math.max(peak, live);
    const done = (out) => { live--; return out; };
    let p;
    if (e.action === "get_short_epg" && hangIds.includes(e.id)) p = net.request(init.timeoutMs).then(() => kinoError("timeout", "the request took too long"));
    else if (e.action === "get_short_epg") p = net.request(epgMs).then(() => res(200, { epg_listings: [{ title: btoa("Noticias"), description: "", start_timestamp: String(Math.floor(net.now() / 1000) - 600), stop_timestamp: String(Math.floor(net.now() / 1000) + 1800) }] }));
    else if (e.action === "get_vod_categories") p = net.request(500).then(() => res(200, [{ category_id: "1", category_name: "ACCION" }, { category_id: "2", category_name: "DRAMA" }, { category_id: "3", category_name: "TERROR" }]));
    else p = net.request(400).then(() => res(200, [{ stream_id: 1, name: "Uno", container_extension: "mp4" }]));
    p = p.then(done);
    inflight.add(p);
    p.then(() => inflight.delete(p));
    return p;
  }];
  const now = net.now();
  const k = installKino({ routes, storage: { srvs: JSON.stringify({ ts: now, list, idx: active, ok: true, okAt: now, v: 2, mig: 1, chosen: keyOf(list[chosen]), homeAt: 0 }), ...(typeof storage === "function" ? storage(list, now) : storage) } });
  const drain = async () => { while (inflight.size) await Promise.all([...inflight]); };
  const call = async (p) => { const t0 = net.now(); const out = await net.run(p); await net.run(drain()); return { out, held: net.now() - t0 }; };
  return { ...k, net, log, list, call, peak: () => peak };
}

const window = (net) => ({ from: net.now() - 2 * H, to: net.now() + 22 * H });

test("guide: 50 channels asked, the first 12 answered from the active server, 4 at a time, 3 s each; nothing else is sent", async () => {
  const w = world({ prefix: "g1" });
  const cat = await fresh("catalog.js");
  const ids = Array.from({ length: 50 }, (_, i) => "live-" + (500 + i));
  const { out, held } = await w.call(cat.guide({ channelIds: ids, ...window(w.net) }));
  assert.equal(w.log.length, 12, "12 programme requests, no probe, no walk");
  assert.ok(w.log.every((e) => e.action === "get_short_epg" && e.host === "g1a.example" && e.timeoutMs === 3000));
  assert.deepEqual(w.log.map((e) => e.id), ids.slice(0, 12).map((x) => x.slice(5)), "the channels Kino lists first");
  assert.equal(w.peak(), 4, "4 in flight at most");
  assert.equal(held, 3 * 250, "three waves: the call holds Kino's queue 0.75 s (50 at Kino's 4 per host: 13 waves, 3.25 s)");
  assert.equal(new Set(out.map((e) => e.channelId)).size, 12);
  assert.equal(out[0].title, "Noticias");
});

test("guide: a channel whose programme never comes holds the call 3 s at most, and no other account is asked", async () => {
  const w = world({ prefix: "g2", hangIds: ["503"] });
  const cat = await fresh("catalog.js");
  const { out, held } = await w.call(cat.guide({ channelIds: Array.from({ length: 12 }, (_, i) => "live-" + (500 + i)), ...window(w.net) }));
  assert.ok(held <= 3000 + 250, `${held} ms`);
  assert.equal(new Set(out.map((e) => e.channelId)).size, 11);
  assert.ok(w.log.every((e) => e.host === "g2a.example"), "never another account (its stream ids are another panel's channels)");
});

test("api() calls run together share one backHome probe, with a short timeout", async () => {
  // The active server is a fallback (b), its categories cached; the person's choice (a) answers again. The three rails ask
  // at once: before, each api() call sent its own probe (three); now they share one, which moves back to a.
  const cats = JSON.stringify({ ts: Date.UTC(2026, 10, 18, 0), l: [["1", "ACCION"], ["2", "DRAMA"], ["3", "TERROR"]] });
  const w = world({ prefix: "g3", active: 1, chosen: 0, storage: (list) => ({ ["cats:vod:" + keyOf(list[1])]: cats }) });
  const cat = await fresh("catalog.js");
  await w.call(cat.loadRailsInfo("vod", 3, 10, { noEnrich: true }));
  const probes = w.log.filter((e) => e.action === "get_vod_categories");
  assert.equal(probes.length, 1, "one probe for the whole call: " + JSON.stringify(w.log.map((e) => e.host + ":" + e.action)));
  assert.equal(probes[0].host, "g3a.example");
  assert.equal(probes[0].timeoutMs, 4000);
  assert.equal(JSON.parse(w.store.get("srvs")).idx, 0, "back on the chosen server");
});
