// The live failover inside resolve(): evidence rules (Kino's preheat vs its reopen chain), the same-panel step, the name
// step on another panel, budgets, and the live "Servidor" alternatives. Fake servers, scripted probes, a fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, installKino, res, kinoError } from "./helpers/fake-kino.mjs";
import { createLiveFailover, parseLiveRef, liveRef, classifyProbe, MAX_PER_RESOLVE } from "../src/liveFailover.js";
import { keyOf, writePanels, noteDead } from "../src/panels.js";
import { categoryTok, channelTok } from "../src/channelMatch.js";

const fx = fixture();
const catsOf = (s) => fx.categories[s].map(([category_id, category_name]) => ({ category_id, category_name }));
const streamsOf = (s, c) => fx.streams[s][c].map(([stream_id, name]) => ({ stream_id, name }));

const S = {
  A1: { url: "http://a1.example", username: "u1", password: "p1", name: "🇪🇸" },
  A2: { url: "http://a2.example", username: "u2", password: "p2", name: "🇪🇸" },
  A3: { url: "http://a3.example", username: "u3", password: "p3", name: "🇬🇧" },
  C: { url: "http://c.example", username: "uc", password: "pc", name: "🇪🇸" },
  Z: { url: "http://z.example", username: "uz", password: "pz", name: "🌐" },
};
const host = (srv) => new URL(srv.url).hostname;
const byHost = (h) => Object.values(S).find((s) => host(s) === h);
const LIST = [S.A1, S.A2, S.A3, S.C, S.Z];
const DAZN1 = liveRef("201583", "2956", categoryTok("ES ▎DAZN"), channelTok("ES ▎DAZN 1 HD"));
const DAZN2 = liveRef("201584", "2956", categoryTok("ES ▎DAZN"), channelTok("ES ▎DAZN 2 HD"));
const DAZN3 = liveRef("1444631", "2956", categoryTok("ES ▎DAZN"), channelTok("ES ▎DAZN 3 HD"));
const C_DAZN1_HD = "152089";

/**
 * A world: [probe] maps a server name to a verdict maker for its playlist probes ("302", 406, "407", "timeout", or a
 * function); [panels]: false = no panel map; [cats]: the servers whose live categories are cached, [catsAge] ms ago;
 * [served]: categories a server's panel lists now on top of the fixture's ({ A: [[id, name]] }), with [streams] for them
 * ({ "<id>": [[stream_id, name]] }). Returns { fo, clock, calls, probes, kino, deps, cache }.
 */
function world({ probe = {}, panels = true, active = "A1", cats = { A1: true, A2: true, A3: true }, catsAge = 60000, served = {}, streams = {} } = {}) {
  const probes = [];
  const routes = [(url, init) => {
    const u = new URL(url);
    const name = Object.keys(S).find((n) => host(S[n]) === u.hostname);
    probes.push({ name, id: u.pathname.split("/").pop().split(".")[0] });
    const how = probe[name] === undefined ? "302" : probe[name];
    const v = typeof how === "function" ? how(u, init) : how;
    if (v === "302") return res(302, "", { Location: "http://203.0.113.9/live/x/y/1.m3u8?token=t" });
    if (v === "407") return kinoError("network", "Received HTTP_PROXY_AUTH (407) from the proxy");
    if (v === "timeout") return kinoError("timeout", "timed out");
    if (v === "playlist") return res(200, "#EXTM3U\n#EXTINF:-1,\nseg.ts\n");
    return res(Number(v), "");
  }];
  const k = installKino({ routes });
  const clock = { t: 1_000_000_000 };
  if (panels) {
    const t = {};
    for (const n of Object.keys(S)) t[keyOf(S[n])] = clock.t;
    writePanels({ v: 1, at: clock.t, g: { [keyOf(S.A1)]: "P", [keyOf(S.A2)]: "P", [keyOf(S.A3)]: "P", [keyOf(S.C)]: "Q", [keyOf(S.Z)]: "Z" }, t });
  }
  const nameOf = (srv) => Object.keys(S).find((x) => S[x] === srv);
  const panelCats = (n) => (n === "C" ? catsOf("C") : catsOf("A"));
  const listedNow = (n) => [...panelCats(n), ...((served[n === "C" ? "C" : "A"] || []).map(([category_id, category_name]) => ({ category_id, category_name })))];
  // What the plugin has cached per server (catalog.js keeps it in memory and storage): { ts, cats }.
  const cache = {};
  for (const n of Object.keys(cats)) if (cats[n]) cache[n] = { ts: clock.t - catsAge, cats: panelCats(n) };
  const calls = [];
  const deps = {
    servers: async () => ({ list: LIST, idx: LIST.indexOf(S[active]) }),
    cachedCats: (srv) => { const c = cache[nameOf(srv)]; return c ? c.cats : null; },
    catsAt: (srv) => { const c = cache[nameOf(srv)]; return c ? c.ts : null; },
    storeCats: (srv, data) => { cache[nameOf(srv)] = { ts: clock.t, cats: data.map((c) => ({ category_id: String(c.category_id), category_name: String(c.category_name) })) }; },
    callServer: async (srv, action, extra, opts) => {
      const n = nameOf(srv);
      calls.push({ n, action, cat: extra && extra.category_id, timeoutMs: opts && opts.timeoutMs });
      if (action === "get_live_categories") return listedNow(n);
      if (action === "get_live_streams" && streams[extra.category_id] && listedNow(n).some((c) => c.category_id === extra.category_id)) return streams[extra.category_id].map(([stream_id, name]) => ({ stream_id, name }));
      if (action === "get_live_streams" && n === "C" && extra.category_id === "196") return streamsOf("C", 196);
      if (action === "get_live_streams" && n !== "C" && extra.category_id === "2956") return streamsOf("A", 2956);
      return [];
    },
    playUrl: (srv, id, f) => `${srv.url}/live/${srv.username}/${srv.password}/${id}.${f || "m3u8"}`,
    label: (srv) => (srv.name === "🇪🇸" ? "ES · España" : srv.name === "🇬🇧" ? "GB · Reino Unido" : "Global"),
    host: (srv) => new URL(srv.url).host,
    online: () => null,
    flag: (srv) => ({ "🇪🇸": "es", "🇬🇧": "gb" })[srv.name] || "",
    priority: (srv) => (srv.name === "🇪🇸" ? 0 : srv.name === "🌐" ? 2 : 3),
    seed: () => "7",
    now: () => clock.t,
    unavailable: () => kinoError("unavailable", "none", { userMessage: "liveNoServer" }),
    notFound: () => kinoError("not_found", "nf"),
  };
  return { fo: createLiveFailover(deps), clock, calls, probes, kino: k, deps, cache };
}
const at = (w, sec) => { w.clock.t += sec * 1000; };
const serverOf = (out) => byHost(new URL(out.url).hostname);
const idOf = (out) => new URL(out.url).pathname.split("/").pop().split(".")[0];

test("refs: enriched round trip, bare and old suffixed refs", () => {
  assert.deepEqual(parseLiveRef(DAZN1), { id: "201583", catId: "2956", catTok: "es.dazn", tok: "es.hd.dazn.1", bare: false });
  assert.deepEqual(parseLiveRef("live:123"), { id: "123", catId: "", catTok: "", tok: "", bare: true });
  assert.equal(parseLiveRef("live:123~x").bare, true);
  assert.equal(parseLiveRef("live:abc"), null);
  assert.equal(liveRef("5", "", "", ""), "live:5");
  assert.ok(DAZN1.length < 100);
});

test("probe verdicts", () => {
  const v = (status, body = "", h = {}) => classifyProbe(res(status, body, h), null);
  assert.equal(v(302, "", { Location: "http://1.2.3.4/x" }), "accepted");
  assert.equal(v(302), "dead");
  assert.equal(v(200, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8"), "ok");
  assert.equal(v(200, "<html>"), "dead");
  assert.equal(v(200, "#EXTM3U\n"), "dead");
  assert.equal(v(404), "missing");
  for (const s of [401, 403, 406, 407, 429, 451, 456, 458, 503, 509]) assert.equal(v(s), "refused", String(s));
  assert.equal(classifyProbe(null, kinoError("network", "Received HTTP_PROXY_AUTH (407)")), "refused");
  assert.equal(classifyProbe(null, kinoError("network", "unexpected end of stream")), "unreachable");
  assert.equal(classifyProbe(null, kinoError("timeout", "t")), "unreachable");
  assert.equal(classifyProbe(null, kinoError("host_not_allowed", "h")), "blocked");
  assert.equal(classifyProbe(null, kinoError("rate_limited", "r")), "limited");
});

test("R1 (first open, preheat) makes no request and plays on the active account", async () => {
  const w = world();
  const out = await w.fo.resolve(DAZN1);
  assert.equal(serverOf(out), S.A1);
  assert.equal(idOf(out), "201583");
  assert.equal(w.kino.requests.length + w.calls.length, 0);
});

test("Kino's zapping (preheat of neighbours, cached zaps) never probes nor switches", async () => {
  const w = world({ probe: { A1: 406 } });
  const seq = [DAZN1, DAZN2, DAZN3, DAZN1, DAZN2, DAZN3, DAZN1, DAZN3, DAZN2, DAZN1];
  for (const ref of seq) { await w.fo.resolve(ref); at(w, 1.5); }
  assert.equal(w.kino.requests.length + w.calls.length, 0);
  // A preheat answer that expired and the open 70 s later: R1 again.
  await w.fo.resolve(DAZN2);
  at(w, 70);
  const out = await w.fo.resolve(DAZN2);
  assert.equal(serverOf(out), S.A1);
  assert.equal(w.kino.requests.length, 0);
});

test("a reopen chain: the first repeat re-checks (accepted keeps the URL), the second switches", async () => {
  const w = world();
  await w.fo.resolve(DAZN1);           // open
  at(w, 1); await w.fo.resolve(DAZN2); // preheat neighbours
  at(w, 1); await w.fo.resolve(DAZN3);
  at(w, 5);
  let out = await w.fo.resolve(DAZN1); // first reopen: not consecutive (the preheat came between) -> R1
  assert.equal(serverOf(out), S.A1);
  assert.equal(w.kino.requests.length, 0);
  at(w, 4);
  out = await w.fo.resolve(DAZN1);     // R2: re-check only
  assert.equal(serverOf(out), S.A1);
  assert.deepEqual(w.probes.map((p) => p.name), ["A1"]);
  at(w, 8);
  out = await w.fo.resolve(DAZN1);     // R3: the stream keeps dying there -> same id on another account of the panel
  assert.equal(idOf(out), "201583");
  assert.ok([S.A2, S.A3].includes(serverOf(out)));
  assert.ok(w.calls.every((c) => c.action === "get_live_streams" && c.cat === "2956"), "verified by listing its own category");
});

test("R2 with a thrown 407 moves to the same panel; the next channel starts on that account with no request", async () => {
  const w = world({ probe: { A1: "407" } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const out = await w.fo.resolve(DAZN1);
  assert.notEqual(serverOf(out), S.A1);
  assert.equal(idOf(out), "201583");
  assert.equal(w.probes[0].name, "A1");
  const before = w.kino.requests.length + w.calls.length;
  at(w, 2);
  const next = await w.fo.resolve(DAZN2); // zap: R1 on a refusing account -> the preferred one of its panel
  assert.equal(serverOf(next), serverOf(out));
  assert.equal(w.kino.requests.length + w.calls.length, before);
});

test("a 406 on the first same-panel candidate moves to the second", async () => {
  const w = world({ probe: { A1: 509, A2: 406 } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const out = await w.fo.resolve(DAZN1);
  assert.equal(serverOf(out), S.A3);
  assert.equal(idOf(out), "201583");
});

test("the panel exhausted: the channel by name on another panel, 3 requests, its own id there (never A's id)", async () => {
  const w = world({ probe: { A1: 509, A2: 509, A3: 509 } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  await assert.rejects(w.fo.resolve(DAZN1), (e) => e.code === "unavailable" && e.userMessage === "liveNoServer");
  const before = { probes: w.kino.requests.length, calls: w.calls.length };
  at(w, 5);
  const out = await w.fo.resolve(DAZN1); // R3: panel P all tried -> step B on panel Q
  assert.equal(serverOf(out), S.C);
  assert.equal(idOf(out), C_DAZN1_HD);
  const extra = (w.kino.requests.length - before.probes) + (w.calls.length - before.calls);
  assert.equal(extra, 3, "categories + one category's streams + one probe");
  assert.ok(!w.probes.some((p) => p.name === "C" && p.id === "201583"), "A's id is never sent to C");
  assert.deepEqual(w.calls.slice(before.calls).map((c) => c.action), ["get_live_categories", "get_live_streams"]);
  // The alternatives now hold the verified name match.
  assert.ok(!out.alternatives || out.alternatives.every((a) => !a.ref.endsWith("~201583") || !a.ref.startsWith("at:" + keyOf(S.C))));
});

test("without a panel map step A is skipped: only a verified name match", async () => {
  const w = world({ probe: { A1: 509 }, panels: false });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const out = await w.fo.resolve(DAZN1);
  // A2/A3 are unknown: they may be anything; the name path verifies whatever it plays.
  const srv = serverOf(out);
  assert.notEqual(srv, S.A1);
  if (srv === S.C) assert.equal(idOf(out), C_DAZN1_HD);
  else assert.equal(idOf(out), "201583"); // found BY NAME on an account that turns out to carry the same id
  assert.ok(w.calls.some((c) => c.action === "get_live_streams"));
});

test("the request cap and the deadline hold", async () => {
  const w = world({ probe: { A1: 509, A2: () => { w.clock.t += 3000; return "timeout"; }, A3: () => { w.clock.t += 3000; return "timeout"; } } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const t0 = w.clock.t;
  const n0 = w.kino.requests.length + w.calls.length;
  await w.fo.resolve(DAZN1).catch(() => null);
  assert.ok(w.kino.requests.length + w.calls.length - n0 <= MAX_PER_RESOLVE);
  assert.ok(w.clock.t - t0 <= 10000 + 3000, "no request starts past the deadline");
  // timeoutMs is the probe's only bound on the network read (see the next test); redirect "manual" keeps it off the edge.
  for (const r of w.kino.requests) assert.ok(r.init.timeoutMs <= 4000 && r.init.redirect === "manual");
});

test("a 200 that never ends holds the account for the probe's timeout, not 2 KB, and settles nothing", async () => {
  // Kino applies maxBytes to the network read only for a plugin without sealed secrets; both plugins seal feedKey, so Kino
  // reads the body whole (up to 5 MB) within timeoutMs and cuts only the text it hands over (DefaultPluginHost.secretSafeCut).
  // Here Kino's read of an endless body ends at the timeout.
  const held = [];
  const w = world({ probe: { A1: (u, init) => { held.push(init.timeoutMs); w.clock.t += init.timeoutMs; return "timeout"; } } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const out = await w.fo.resolve(DAZN1); // R2: the re-check reads until its timeout: unreachable, so it stays
  assert.equal(serverOf(out), S.A1);
  assert.equal(held.length, 1);
  assert.ok(held[0] <= 4000, "bounded by the timeout");
  at(w, 60);
  const n = w.kino.requests.length + w.calls.length;
  assert.equal(serverOf(await w.fo.resolve(DAZN2)), S.A1, "an inconclusive probe blames no account");
  assert.equal(w.kino.requests.length + w.calls.length, n);
});

test("a stuck channel spends at most 12 extra requests per 10 min over the whole chain", async () => {
  const w = world({ probe: { A1: 509, A2: 509, A3: 509, C: 509, Z: 509 } });
  await w.fo.resolve(DAZN1);
  for (let i = 0; i < 16; i++) { at(w, 20); await w.fo.resolve(DAZN1).catch(() => null); }
  const spent = w.kino.requests.length + w.calls.length;
  assert.ok(spent >= 6 && spent <= 12, String(spent));
  // Ten minutes later the budget is back.
  at(w, 600);
  await w.fo.resolve(DAZN1).catch(() => null);
  at(w, 20);
  await w.fo.resolve(DAZN1).catch(() => null);
  assert.ok(w.kino.requests.length + w.calls.length > spent);
});

test("dead accounts are skipped by the failover", async () => {
  const w = world({ probe: { A1: 509 } });
  noteDead(S.A2, w.clock.t);
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const out = await w.fo.resolve(DAZN1);
  assert.equal(serverOf(out), S.A3);
  assert.ok(!w.probes.some((p) => p.name === "A2"));
});

test("alternatives: other accounts of the same panel only, none without a panel map", async () => {
  const w = world();
  const out = await w.fo.resolve(DAZN1);
  const keys = out.alternatives.map((a) => a.ref.split("~")[0].slice(3));
  assert.deepEqual(keys.sort(), [keyOf(S.A2), keyOf(S.A3)].sort());
  assert.ok(out.alternatives.every((a) => a.ref.endsWith("~l~201583")));
  assert.equal(out.label, "ES · España");
  const bare = world({ panels: false });
  const out2 = await bare.fo.resolve(DAZN1);
  assert.equal(out2.alternatives, undefined);
});

test("a ref from another panel plays the same channel BY NAME on the active server (never its id)", async () => {
  const w = world({ active: "C", cats: { C: true } });
  const out = await w.fo.resolve(DAZN1);
  assert.equal(serverOf(out), S.C);
  assert.equal(idOf(out), C_DAZN1_HD);
  assert.deepEqual(w.calls.map((c) => c.action), ["get_live_streams"], "categories were cached: one request");
  const again = await w.fo.resolve(DAZN1);
  assert.equal(idOf(again), C_DAZN1_HD);
  assert.equal(w.calls.length, 1, "remembered");
  // No such channel there, and the id's own panel is known (its accounts list the category under that id and name) but
  // dead: not found (Kino reopens a saved channel by its identity).
  const w2 = world({ active: "C", cats: { C: true, A1: true, A2: true, A3: true } });
  for (const n of ["A1", "A2", "A3"]) noteDead(S[n], w2.clock.t);
  await assert.rejects(w2.fo.resolve(liveRef("1733676", "2956", categoryTok("ES ▎DAZN"), channelTok("ES ▎DAZN ACB 1"))), (e) => e.code === "not_found");
});

const MUNDIAL = liveRef("777001", "3100", categoryTok("ES ▎MUNDIAL 2026"), channelTok("ES ▎MUNDIAL 1 HD"));
const NEW_CATEGORY = { served: { A: [["3100", "ES ▎MUNDIAL 2026"]] }, streams: { 3100: [["777001", "ES ▎MUNDIAL 1 HD"]] } };

test("a category added after the active server's categories were cached: one refresh, then the id plays there", async () => {
  // The ref comes from fresher data (the CI-built feed, a favourite synced from another device); the cache is 2 h old.
  const w = world({ ...NEW_CATEGORY, catsAge: 2 * 3600000 });
  const out = await w.fo.resolve(MUNDIAL);
  assert.equal(serverOf(out), S.A1);
  assert.equal(idOf(out), "777001");
  assert.deepEqual(w.calls.map((c) => c.n + " " + c.action), ["A1 get_live_categories"]);
  assert.equal(w.kino.requests.length, 0);
  assert.ok(w.cache.A1.cats.some((c) => c.category_id === "3100"), "the refresh is kept as the server's cache");
  // Another runtime later: the kept categories answer, no request.
  at(w, 60);
  const fo2 = createLiveFailover(w.deps);
  assert.equal(serverOf(await fo2.resolve(MUNDIAL)), S.A1);
  assert.equal(w.calls.length, 1);
});

test("fresh categories without the ref's category and no evidence of another panel: the id on the active server, as before", async () => {
  const w = world({ ...NEW_CATEGORY, served: {}, cats: { A1: true } });
  const out = await w.fo.resolve(MUNDIAL);
  assert.equal(serverOf(out), S.A1);
  assert.equal(idOf(out), "777001");
  assert.equal(w.calls.length + w.kino.requests.length, 0, "fresh categories are not asked again");
  // A refresh that cannot run (the server does not answer) is not evidence either.
  const w2 = world({ catsAge: 2 * 3600000, cats: { A1: true } });
  w2.deps.callServer = async () => { throw kinoError("timeout", "t"); };
  const fo = createLiveFailover(w2.deps);
  assert.equal(serverOf(await fo.resolve(MUNDIAL)), S.A1);
});

test("a ref listed with no category name ('_') plays its id on the active server that has the category, no request", async () => {
  const ref = liveRef("201583", "2956", categoryTok(""), channelTok("ES ▎DAZN 1 HD"));
  assert.equal(parseLiveRef(ref).catTok, "_");
  const w = world();
  const out = await w.fo.resolve(ref);
  assert.equal(serverOf(out), S.A1);
  assert.equal(idOf(out), "201583");
  assert.equal(w.calls.length + w.kino.requests.length, 0);
});

test("a bare ref plays on the active server only, even in a chain", async () => {
  const w = world({ probe: { A1: 509 } });
  for (let i = 0; i < 4; i++) { const out = await w.fo.resolve("live:201583"); assert.equal(serverOf(out), S.A1); at(w, 3); }
  assert.equal(w.kino.requests.length + w.calls.length, 0);
});

test("a switch sticks 10 min (also across a runtime restart), unless the person changed server", async () => {
  const w = world({ probe: { A1: 509 } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  const moved = serverOf(await w.fo.resolve(DAZN1));
  assert.notEqual(moved, S.A1);
  // A new runtime (new failover, same storage): the channel reopens on the account it moved to, no request.
  const fo2 = createLiveFailover(w.deps);
  at(w, 60);
  const n = w.kino.requests.length + w.calls.length;
  assert.equal(serverOf(await fo2.resolve(DAZN1)), moved);
  assert.equal(w.kino.requests.length + w.calls.length, n);
  // The person picks another server: the sticky choice no longer applies.
  const fo3 = createLiveFailover({ ...w.deps, servers: async () => ({ list: LIST, idx: LIST.indexOf(S.A3) }) });
  assert.equal(serverOf(await fo3.resolve(DAZN1)), S.A3);
});

test("after a switch the new account gets its own evidence: re-checked on the next cut, left on the one after", async () => {
  const w = world({ probe: { A1: 509, A2: 509, A3: 509 } });
  await w.fo.resolve(DAZN1);
  at(w, 3);
  await w.fo.resolve(DAZN1).catch(() => null); // R2: the whole panel refuses
  at(w, 5);
  let out = await w.fo.resolve(DAZN1);          // R3: by name on C
  assert.equal(serverOf(out), S.C);
  const n = w.probes.length;
  at(w, 5);
  out = await w.fo.resolve(DAZN1);              // first cut on C: re-check C (302) and stay
  assert.equal(serverOf(out), S.C);
  assert.equal(idOf(out), C_DAZN1_HD);
  assert.deepEqual(w.probes.slice(n).map((p) => p.name), ["C"]);
  at(w, 5);
  out = await w.fo.resolve(DAZN1);              // second cut on C: move on (never back to A's id on C)
  assert.ok(!(serverOf(out) === S.C && idOf(out) === "201583"));
});

test("one channel's reopen chain never moves the person's other channels: no account-wide mark without a probe that blames it", async () => {
  const w = world(); // every playlist answers 302: no probe ever blames an account
  await w.fo.resolve(DAZN3);
  at(w, 2); assert.equal(serverOf(await w.fo.resolve(DAZN3)), S.A1); // R2: re-checked, accepted
  at(w, 4);
  const moved = serverOf(await w.fo.resolve(DAZN3));                  // R3: DAZN3 keeps dying on A1 (its source?): it moves
  assert.notEqual(moved, S.A1);
  at(w, 8); await w.fo.resolve(DAZN3);
  at(w, 60);
  const n = w.kino.requests.length + w.calls.length;
  assert.equal(serverOf(await w.fo.resolve(DAZN1)), S.A1, "a channel that never failed stays on the person's account");
  at(w, 1);
  assert.equal(serverOf(await w.fo.resolve(DAZN2)), S.A1, "and so does Kino's preheat of its neighbour");
  assert.equal(w.kino.requests.length + w.calls.length, n, "with no request");
  // DAZN3 itself remembers where it kept dying.
  at(w, 60);
  assert.notEqual(serverOf(await w.fo.resolve(DAZN3)), S.A1);
});

test("Kino's give-up watch on one channel (a reopen every 30 s) leaves the panel's accounts free for the others", async () => {
  const w = world();
  await w.fo.resolve(DAZN3);
  for (let i = 0; i < 8; i++) { at(w, 30); await w.fo.resolve(DAZN3).catch(() => null); }
  at(w, 60);
  const n = w.kino.requests.length + w.calls.length;
  assert.equal(serverOf(await w.fo.resolve(DAZN1)), S.A1);
  at(w, 1);
  assert.equal(serverOf(await w.fo.resolve(DAZN2)), S.A1);
  assert.equal(w.kino.requests.length + w.calls.length, n, "no re-check probe: nothing blamed an account");
});
