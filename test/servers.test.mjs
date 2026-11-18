// The server list end to end through catalog.js with a fake kino: the person's choice survives the 6-hour refresh and the
// health check's jump, dead accounts cost no request, Ultra HD probes VOD categories only, panels are grouped from the
// health check's own answers, a live failover never touches the stored server state, and index results resolve on an account
// of the index's panel when the index's own server is dead, without ever writing srvs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture, installKino, res, kinoError, param, fresh, virtualNet } from "./helpers/fake-kino.mjs";
import { keyOf, readPanels, isDead } from "../src/panels.js";
import { sourceTag } from "../src/titleIndex.js";
import { channelTok } from "../src/channelMatch.js";

const fx = fixture();
const INDEX = JSON.parse(readFileSync(new URL("./fixtures/index-categories.json", import.meta.url), "utf8"));
const catsOf = (s) => fx.categories[s].map(([category_id, category_name]) => ({ category_id, category_name }));
const streamsOf = (s, c) => fx.streams[s][c].map(([stream_id, name]) => ({ stream_id, name }));
// An account of the index's panel: its VOD categories are the index's (same ids, same names).
const indexCats = () => Object.entries(INDEX.vod).map(([category_id, e]) => ({ category_id, category_name: e[0] }));
const H = 3600000;

// The service's list: the index's server (https, dead: sorts first), an account of the index's panel (n), two accounts of
// one panel (a1, a2), another panel (c), one offline.
const SRV = {
  home: { url: "https://home.example", username: "uh", password: "ph", name: "🇲🇽", answer: () => res(200, { user_info: { auth: 0, status: "Invalid", message: "Invalid username or password" } }) },
  n: { url: "http://n.example", username: "un", password: "pn", name: "🌐", cats: "N" },
  a1: { url: "http://a1.example", username: "u1", password: "p1", name: "🇲🇽", cats: "A" },
  a2: { url: "http://a2.example", username: "u2", password: "p2", name: "🇪🇸", cats: "B" },
  c: { url: "http://c.example", username: "uc", password: "pc", name: "🇪🇸", cats: "C" },
  off: { url: "http://off.example", username: "uo", password: "po", name: "🇺🇸", answer: () => kinoError("network", "connection refused") },
};
const NAMES = Object.keys(SRV);
const srvOf = (n) => ({ url: SRV[n].url, username: SRV[n].username, password: SRV[n].password, name: SRV[n].name });
const text = (names) => names.map((n) => `${SRV[n].url}/get.php?username=${SRV[n].username}&password=${SRV[n].password} [${SRV[n].name}]`).join("\n");
const MATRIX = { stream_id: 777001, name: "Matrix (1999)", container_extension: "mkv" };
// The index's state: generated from home's panel ("src" is the tag of home's address).
const idxState = () => JSON.stringify({ v: 1, src: sourceTag(SRV.home.url), done: true, rev: "20261110T153911Z", checked: T });

function world({ names = NAMES, probe = {}, storage = {}, lang, index = true } = {}) {
  const log = [];
  let list = names;
  const added = { cats: [], streams: {} }; // live categories panel A lists on top of the fixture's (addCategory)
  const routes = [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") { log.push({ n: "boot" }); return res(200, { ok: true, servers_text: text(list) }); }
    if (u.hostname === "raw.githubusercontent.com") {
      log.push({ n: "github", file: u.pathname.split("/").pop() });
      return u.pathname.endsWith("/categories.json") ? res(200, INDEX) : res(404, "");
    }
    const n = NAMES.find((x) => new URL(SRV[x].url).hostname === u.hostname);
    if (!n) return undefined;
    if (u.pathname.startsWith("/live/")) {
      log.push({ n, kind: "probe" });
      const v = probe[n] || "302";
      return v === "302" ? res(302, "", { Location: "http://203.0.113.9/x.m3u8" }) : res(Number(v), "");
    }
    const action = param(url, "action");
    const c = param(url, "category_id");
    log.push({ n, action, cat: c, at: T, timeoutMs: init && init.timeoutMs });
    if (SRV[n].answer) return SRV[n].answer(init);
    const cats = SRV[n].cats;
    if (action === "get_vod_categories") return res(200, cats === "N" ? indexCats() : catsOf(cats));
    if (action === "get_live_categories") return res(200, cats === "N" ? catsOf("C") : [...catsOf(cats), ...(cats === "A" ? added.cats : [])]);
    if (action === "get_live_streams" && cats === "A" && added.streams[c]) return res(200, added.streams[c]);
    if (action === "get_vod_streams") return res(200, cats === "N" && c === "1055" ? [MATRIX] : []);
    if (action === "get_live_streams") return res(200, cats === "C" || cats === "N" ? (c === "196" ? streamsOf("C", 196) : []) : c === "2956" ? streamsOf("A", 2956) : []);
    return res(200, []);
  }];
  const k = installKino({ routes, storage: { ...(index ? { "idx:state": idxState() } : {}), ...storage }, lang });
  const addCategory = (id, name, streams) => {
    added.cats.push({ category_id: id, category_name: name });
    added.streams[id] = streams.map(([stream_id, sname]) => ({ stream_id, name: sname }));
  };
  return { ...k, log, setList: (l) => { list = l; }, addCategory };
}

let T = Date.UTC(2026, 10, 17, 12);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });
const advance = (ms) => { T += ms; };
const srvs = (w) => JSON.parse(w.store.get("srvs"));
const activeName = (w) => { const s = srvs(w); return NAMES.find((n) => SRV[n].url === s.list[s.idx].url); };
const setActive = (w, n, extra = {}) => {
  const st = srvs(w);
  st.idx = st.list.findIndex((s) => s.url === SRV[n].url);
  st.ok = true; st.okAt = T; st.mig = 1;
  Object.assign(st, extra);
  w.store.set("srvs", JSON.stringify(st));
};

test("the health check: VOD categories only, panels grouped from its answers, dead accounts marked and then skipped", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  assert.ok(w.log.every((e) => !e.action || e.action === "get_vod_categories"), "the probe is VOD everywhere");
  const map = readPanels();
  assert.equal(map.g[keyOf(srvOf("a1"))], map.g[keyOf(srvOf("a2"))], "a1 and a2: one panel");
  assert.notEqual(map.g[keyOf(srvOf("a1"))], map.g[keyOf(srvOf("c"))]);
  assert.notEqual(map.g[keyOf(srvOf("a1"))], map.g[keyOf(srvOf("n"))]);
  assert.ok(isDead(srvOf("home"), T));
  // A fresh list started on the index's server (dead): the check moved away, without touching any choice.
  assert.notEqual(activeName(w), "home");
  assert.equal(srvs(w).chosen, undefined);
  assert.equal(cat.hasChosenServer(), false, "a jump is not a choice: the first-run picker still shows");
  // The next check (30 min later) spends nothing on the dead account; after 24 h it gets exactly one probe again.
  advance(31 * 60000);
  w.log.length = 0;
  await cat.healthCheck();
  assert.ok(!w.log.some((e) => e.n === "home"));
  advance(25 * H);
  w.log.length = 0;
  const cat2 = await fresh("catalog.js");
  await cat2.healthCheck();
  assert.equal(w.log.filter((e) => e.n === "home").length, 1);
});

test("the index's server is dead: the health check finds the account of its panel (fit 72/72), as a lookup only", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const ix = readPanels().ix;
  assert.equal(ix.src, sourceTag(SRV.home.url));
  assert.deepEqual(ix.fits, [keyOf(srvOf("n"))]);
  assert.equal(ix.home, keyOf(srvOf("n")));
  assert.ok(w.log.filter((e) => e.n === "github").length <= 1, "categories.json at most once (kept for the session)");
  advance(31 * 60000);
  w.log.length = 0;
  await cat.healthCheck();
  assert.equal(w.log.filter((e) => e.n === "github").length, 0);
  assert.equal(readPanels().ix.home, keyOf(srvOf("n")));
  // Never a place to return to: an install without a choice is not pulled to n by backHome.
  setActive(w, "a1");
  advance(6 * 60000);
  w.log.length = 0;
  await cat.liveCategories();
  assert.equal(activeName(w), "a1");
  assert.ok(!w.log.some((e) => e.n === "n" || e.n === "home"));
  assert.equal(cat.panelsStale(), false);
  advance(21 * H);
  assert.equal(cat.panelsStale(), true, "the screen refreshes the map once a day");
});

test("an index result resolves on the account of the index's panel; srvs is never written; the active one stays", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  const before = w.store.get("srvs");
  w.log.length = 0;
  const out = await cat.resolve("idx:m:matrix|1999|1055");
  assert.ok(out.url.startsWith(SRV.n.url + "/movie/") && out.url.endsWith("/777001.mkv"), out.url);
  assert.ok(w.log.filter((e) => e.action).every((e) => e.n === "n"), JSON.stringify(w.log));
  assert.ok(!w.log.some((e) => e.n === "home"), "no request to the dead index server");
  assert.equal(w.store.get("srvs"), before, "the person's server, choice and list are untouched");
  assert.ok(!out.alternatives || !out.alternatives.some((a) => a.ref.startsWith("at:" + keyOf(srvOf("home")) + "~")), "a dead account is never offered");
});

test("the active account carries the index's ids: the index result resolves on it by the normal path", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "n", { chosen: keyOf(srvOf("n")) });
  w.log.length = 0;
  const out = await cat.resolve("idx:m:matrix|1999|1055");
  assert.ok(out.url.startsWith(SRV.n.url + "/movie/"), out.url);
  assert.equal(srvs(w).idx, srvs(w).list.findIndex((s) => s.url === SRV.n.url));
});

test("no account fits the index and its server is dead: no request to it, the active server resolves by title as before", async () => {
  const w = world({ names: ["home", "a1", "a2", "c", "off"] });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  assert.equal(readPanels().ix.home, undefined);
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  w.log.length = 0;
  await assert.rejects(cat.resolve("idx:m:matrix|1999|1055"), (e) => e.code === "not_found");
  assert.ok(!w.log.some((e) => e.n === "home"));
  assert.ok(w.log.some((e) => e.n === "a1" && e.action === "get_vod_streams"));
});

test("the picker and the first-run auto-pick never offer a dead account", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const list = await cat.serverList();
  assert.ok(!list.items.some((x) => x.host === "home.example"));
  assert.ok(!list.items.some((x) => x.host === "off.example"), "offline after a fresh check");
  assert.equal(w.log.filter((e) => e.n === "home").length, 1);
  // 40 min later the health result is stale (every server listed again) but the dead account still is not.
  advance(40 * 60000);
  const later = await cat.serverList();
  assert.ok(later.items.some((x) => x.host === "off.example"));
  assert.ok(!later.items.some((x) => x.host === "home.example"));
});

test("a chosen server survives the 6-hour refresh and the health check's jump; backHome returns to it", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  const iC = srvs(w).list.findIndex((s) => s.url === SRV.c.url);
  const r = await cat.selectServer(String(iC));
  assert.ok(r.ok);
  assert.equal(srvs(w).chosen, keyOf(srvOf("c")));
  assert.ok(cat.hasChosenServer());
  // Six hours later the list is fetched again (in another order): still on c, still chosen.
  advance(6 * H + 1);
  w.setList(["a2", "c", "home", "n", "a1", "off"]);
  await cat.refreshServers();
  assert.equal(activeName(w), "c");
  assert.equal(srvs(w).chosen, keyOf(srvOf("c")));
  // c goes offline: the health check jumps elsewhere but keeps the choice...
  const keep = SRV.c.answer;
  SRV.c.answer = () => kinoError("network", "down");
  advance(31 * 60000);
  await cat.healthCheck();
  assert.notEqual(activeName(w), "c");
  assert.equal(srvs(w).chosen, keyOf(srvOf("c")));
  // ...and once c answers again, the next catalog call goes back to it (at most one probe every 5 min).
  SRV.c.answer = keep;
  advance(6 * 60000);
  await cat.liveCategories();
  assert.equal(activeName(w), "c");
});

test("backHome makes no request to a dead chosen server", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  setActive(w, "a1", { chosen: keyOf(srvOf("home")), mig: 1 });
  await cat.healthCheck(); // marks dead
  advance(6 * 60000);
  w.log.length = 0;
  await cat.liveCategories();
  assert.ok(!w.log.some((e) => e.n === "home"));
});

test("an install from before 0.8.6: its pinned or flagged server becomes the chosen one, once", async () => {
  const list = ["home", "n", "a1", "a2", "c", "off"].map(srvOf);
  const old = { ts: T, list, idx: 3, ok: true, okAt: T, pin: true, v: 2 };
  const w = world({ storage: { srvs: JSON.stringify(old) } });
  const cat = await fresh("catalog.js");
  assert.ok(cat.hasChosenServer());
  const st = srvs(w);
  assert.equal(st.chosen, keyOf(srvOf("a2")));
  assert.equal(st.pin, undefined);
  assert.equal(st.mig, 1);
  const w2 = world({ storage: { srvs: JSON.stringify({ ...old, pin: false }), "srvChosen:v1": "1" } });
  const cat2 = await fresh("catalog.js");
  assert.ok(cat2.hasChosenServer());
  assert.equal(srvs(w2).chosen, keyOf(srvOf("a2")));
  const w3 = world({ storage: { srvs: JSON.stringify({ ...old, pin: false }) } });
  const cat3 = await fresh("catalog.js");
  assert.equal(cat3.hasChosenServer(), false);
  assert.equal(srvs(w3).mig, 1);
});

test("live items carry an enriched ref; resolve plays it with no request, and a failover never touches srvs", async () => {
  const w = world({ probe: { a1: "509" } });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  const page = await cat.liveChannels({ categoryId: "2956" });
  const item = page.items.find((i) => i.id === "live-201583");
  assert.equal(item.title, "DAZN 1 HD", "the shown title has no 'ES ▎'");
  assert.equal(item.ref, "live:201583~2956~es.dazn~es.hd.dazn.1", "the ref still reads the raw name (es.hd.dazn.1)");
  const before = w.store.get("srvs");
  w.log.length = 0;
  const out = await cat.resolve(item.ref);
  assert.ok(out.url.startsWith(SRV.a1.url + "/live/"));
  assert.equal(w.log.length, 0);
  const again = await cat.resolve(item.ref); // a cut: R2 sees the 509 and moves to a2 (same panel, same id)
  assert.ok(again.url.startsWith(SRV.a2.url + "/live/") && again.url.endsWith("/201583.m3u8"), again.url);
  assert.equal(w.store.get("srvs"), before, "the active server, the choice and the list are untouched");
});

test("the 'no server' message follows Kino's language tag", async () => {
  const w = world({ probe: { a1: "509", a2: "509", c: "509", n: "509" }, lang: "en-US" });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "a1");
  const ref = "live:201583~2956~es.dazn~es.hd.dazn.1";
  await cat.resolve(ref);
  await assert.rejects(cat.resolve(ref), (e) => e.code === "unavailable" && /isn't answering on any server/.test(e.userMessage));
});

test("an ISP block that redirects to another host is not a blocked account; Kino refusing the server's own host is", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  SRV.a1.answer = () => kinoError("host_not_allowed", "not allowed", { host: "www.coljuegos.gov.co" });
  SRV.a2.answer = () => kinoError("host_not_allowed", "not allowed", { host: "a2.example" });
  await cat.healthCheck();
  delete SRV.a1.answer;
  delete SRV.a2.answer;
  const acct = JSON.parse(w.store.get("acct:v1"));
  assert.ok(!(keyOf(srvOf("a1")) in acct.blocked));
  assert.ok(keyOf(srvOf("a2")) in acct.blocked);
});

test("refs are identical for every account of a panel (a favourite does not churn when the account changes)", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList();
  const refsOn = async (n) => {
    setActive(w, n);
    const c = await fresh("catalog.js");
    return (await c.liveChannels({ categoryId: "2956" })).items.map((i) => i.ref);
  };
  const a = await refsOn("a1");
  const b = await refsOn("a2");
  assert.ok(a.length > 20);
  assert.deepEqual(a, b);
});

test("movies and episodes: the same paths, minus dead accounts in the 'Servidor' menu", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.serverList(); // no health check: every listed server is a candidate...
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  await cat.selectServer(String(srvs(w).list.findIndex((s) => s.url === SRV.home.url))); // ...until home answers auth 0
  assert.equal(activeName(w), "a1");
  w.log.length = 0;
  const out = await cat.resolve("vod:123:mp4~matrix");
  assert.ok(out.url.startsWith(SRV.a1.url + "/movie/") && out.url.endsWith("/123.mp4"));
  assert.equal(w.log.length, 0);
  const refs = (out.alternatives || []).map((a) => a.ref);
  assert.ok(refs.length >= 3);
  assert.ok(!refs.some((r) => r.startsWith("at:" + keyOf(srvOf("home")) + "~")));
  const ep = await cat.resolve("ep:456:mkv~99~some show");
  assert.ok(ep.url.startsWith(SRV.a1.url + "/series/") && ep.url.endsWith("/456.mkv"));
});

test("first run: the auto-pick races the Spanish accounts before any health check and never picks a dead one; a lost flag heals", async () => {
  const w = world();
  const screen = await fresh("screen.js");
  let state = {};
  const tick = async () => { const r = await screen.screenEvent({ name: "tick", state, lang: "es" }); state = { ...state, ...(r && r.state) }; };
  await tick();
  const race = w.log.filter((e) => e.action);
  // home, a1 and a2 start together; home's auth 0 starts c, the next Spanish account. No health check (n and off untouched).
  assert.deepEqual(race.map((e) => e.n), ["home", "a1", "a2", "c"], "the Spanish accounts raced, a dead one replaced at once");
  assert.ok(race.every((e) => e.timeoutMs === 4000));
  assert.ok(isDead(srvOf("home"), T), "home answered auth 0: remembered dead");
  assert.ok(["a1", "a2", "c"].includes(activeName(w)), "the pick is an account that answered well");
  assert.equal(srvs(w).chosen, keyOf(srvOf(activeName(w))));
  assert.equal(w.store.get("srvChosen:v1"), "1");
  // The flag disappears (an older build's eviction): the chosen server still counts and the flag is written again.
  w.store.delete("srvChosen:v1");
  const view = await screen.screen({ route: { name: "main" }, state, device: { kind: "phone" } });
  assert.ok(view);
  assert.equal(w.store.get("srvChosen:v1"), "1");
});

test("a live category the panel added after En vivo cached its categories: its ref plays there after one refresh", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  await cat.liveCategories(); // En vivo keeps a1's live categories
  advance(H);
  w.addCategory("3100", "ES ▎MUNDIAL 2026", [[777001, "ES ▎MUNDIAL 1 HD"]]);
  // A new runtime opens the channel from fresher data (the CI-built live feed, a favourite from another device).
  const cat2 = await fresh("catalog.js");
  const ref = "live:777001~3100~es.2026.mundial~es.hd.mundial.1";
  w.log.length = 0;
  const out = await cat2.resolve(ref);
  assert.ok(out.url.startsWith(SRV.a1.url + "/live/") && out.url.endsWith("/777001.m3u8"), out.url);
  assert.deepEqual(w.log.map((e) => e.n + " " + (e.action || e.kind)), ["a1 get_live_categories"]);
  const page = await cat2.liveChannels({ categoryId: "3100" });
  assert.equal(page.items[0].ref, ref);
});

test("live titles: the panels' decorations are gone from what Kino lists; ids and refs are built from the raw names as before", async () => {
  const w = world();
  w.addCategory("3200", "UHD CHANNELS", [[900001, "4K ▎DAZN 1"], [900002, "┃UCL┃ CHAMPIONS 1"], [900003, "|PT| DAZN 1 HD"]]);
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  // A category of Spain: every "ES ▎" goes, nothing else; ids and refs are built from the raw names exactly as before.
  const raw = streamsOf("A", 2956);
  const page = await cat.liveChannels({ categoryId: "2956" });
  assert.deepEqual(page.items.map((i) => i.title), raw.map((s) => s.name.replace(/^ES ▎/, "")));
  assert.deepEqual(page.items.map((i) => i.id), raw.map((s) => "live-" + s.stream_id));
  assert.deepEqual(page.items.map((i) => i.ref), raw.map((s) => `live:${s.stream_id}~2956~es.dazn~${channelTok(s.name)}`));
  // A category of no country: the quality is kept at the end, a group before a panel bar goes; refs read the raw names.
  const uhd = await cat.liveChannels({ categoryId: "3200" });
  assert.deepEqual(uhd.items.map((i) => i.title), ["DAZN 1 4K", "CHAMPIONS 1", "DAZN 1 HD"]);
  assert.equal(uhd.items[0].ref, "live:900001~3200~_~_.4k.dazn.1");
  assert.equal(uhd.items[1].ref, `live:900002~3200~_~${channelTok("┃UCL┃ CHAMPIONS 1")}`);
  // Kino's "see more" of a live row lists the same clean titles.
  assert.equal((await cat.browse("lcat:2956")).items[0].title, "DAZN LALIGA FHD");
  // Movies and series keep their titles exactly as before (displayTitle): this cleanup is for live channels only.
  assert.equal(cat.vodItem({ stream_id: 1, name: "ES ▎Matrix (1999)" }).title, "ES ▎Matrix");
  assert.equal(cat.seriesItem({ series_id: 2, name: "| MULTI | Dark" }).title, "Dark");
});

// One account whose few live categories all fit in a search (a real panel has hundreds: a search scans its first 36).
function smallWorld({ cats, streams, config } = {}) {
  const one = { url: "http://s1.example", username: "u", password: "p" };
  return installKino({ config, routes: [(url) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") return res(200, { ok: true, servers_text: `${one.url}/get.php?username=u&password=p [🇪🇸]` });
    if (u.hostname === "raw.githubusercontent.com") return res(404, "");
    if (u.hostname !== "s1.example") return undefined;
    const action = param(url, "action");
    if (action === "get_vod_categories") return res(200, [{ category_id: "1", category_name: "ACCION" }]);
    if (action === "get_live_categories") return res(200, cats.map(([category_id, category_name]) => ({ category_id, category_name })));
    if (action === "get_live_streams") return res(200, streams[param(url, "category_id")] || []);
    return res(200, []);
  }] });
}

test("live search: one mixed list, found by what the person sees, and Kino's lookup by an old decorated name still matches", async () => {
  const k = smallWorld({
    cats: [["2956", "ES ▎DAZN"], ["3200", "UHD CHANNELS"], ["3300", "PT ▎DAZN"]],
    streams: { 2956: streamsOf("A", 2956), 3200: [{ stream_id: 900001, name: "4K ▎DAZN 1" }], 3300: [{ stream_id: 900003, name: "PT ▎DAZN 1 HD" }] },
  });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const hits = (await cat.liveSearch({ query: "dazn 1 hd" })).items;
  assert.deepEqual(hits.map((i) => i.title).sort(), ["DAZN 1 HD · España", "DAZN 1 HD · Portugal"]);
  assert.equal(hits.find((i) => i.id === "live-201583").ref, "live:201583~2956~es.dazn~es.hd.dazn.1");
  assert.deepEqual((await cat.liveSearch({ query: "dazn 1 4k" })).items.map((i) => i.id), ["live-900001"], "found by its shown title");
  // Kino looks a favourite saved under its old, decorated name up by that name: that hit answers under it, so Kino's
  // id + name comparison recognises the channel (and heals the favourite's ref).
  const old = (await cat.liveSearch({ query: "ES ▎DAZN 1 HD" })).items.find((i) => i.id === "live-201583");
  assert.equal(old.title, "ES ▎DAZN 1 HD");
  assert.equal(old.ref, "live:201583~2956~es.dazn~es.hd.dazn.1");
  // English: the suffix follows Kino's language.
  k.kino.lang = "en-US";
  assert.deepEqual((await cat.liveSearch({ query: "dazn 1 hd" })).items.map((i) => i.title).sort(), ["DAZN 1 HD · Portugal", "DAZN 1 HD · Spain"]);
});

test("'Canales de tu país': the person's own country is never repeated on its channels", async () => {
  smallWorld({
    config: { homeCountry: "ES" },
    cats: [["196", "ESPAÑA DAZN"]],
    streams: { 196: [{ stream_id: 201583, name: "ES ▎DAZN 1 HD" }, { stream_id: 196001, name: "DAZN 1 HD" }, { stream_id: 196002, name: "┃ES┃ M+ DEPORTES" }] },
  });
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  const row = await cat.countryRow(20);
  assert.deepEqual(row.items.map((i) => i.title), ["DAZN 1 HD", "DAZN 1 HD", "M+ DEPORTES"]);
  assert.equal(row.items[0].ref, "live:201583~196~es.dazn~es.hd.dazn.1");
});

test("an En vivo snapshot written by an older build shows clean titles", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  w.store.set("srvChosen:v1", "1");
  const card = (id, title) => ({ id: "live-" + id, ref: "live:" + id, title, kind: "live" });
  w.store.set(`homeSnap:v3:${cat.serverKey()}:live:-`, JSON.stringify({ v: 3, at: T, slides: [], rails: [{ id: "lcat-2956", title: "ES DAZN", items: [card(201583, "ES ▎DAZN 1 HD"), card(192289, "ES ▎DAZN 1 FHD")] }] }));
  const screen = await fresh("screen.js");
  const view = JSON.stringify(await screen.screen({ route: { name: "main" }, state: { tab: "live" }, device: { kind: "phone" } }));
  assert.ok(view.includes('"DAZN 1 HD"') && view.includes('"DAZN 1 FHD"'), "the snapshot's cards are clean");
  assert.ok(!view.includes("ES ▎"));
  assert.ok(view.includes("live:201583"), "refs untouched");
});

// ---- index results on a partial account of the index's panel ----------------------------------------------------------

// The index's own server alive (ixh, full bouquet) and an account of its panel (p) whose bouquet lacks [lack] of the index's
// categories; [pHas]: whether p's category 1055 holds the title.
function ixWorld({ lack = [], pHas = true } = {}) {
  const all = indexCats();
  const S2 = {
    ixh: { url: SRV.home.url, username: "uh", password: "ph", name: "🇲🇽", cats: all },
    p: { url: "http://p.example", username: "up", password: "pp", name: "🇲🇽", cats: all.filter((x) => !lack.includes(x.category_id)) },
  };
  const log = [];
  const routes = [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") return res(200, { ok: true, servers_text: Object.values(S2).map((s) => `${s.url}/get.php?username=${s.username}&password=${s.password} [${s.name}]`).join("\n") });
    if (u.hostname === "raw.githubusercontent.com") return u.pathname.endsWith("/categories.json") ? res(200, INDEX) : res(404, "");
    const n = Object.keys(S2).find((x) => new URL(S2[x].url).hostname === u.hostname);
    if (!n) return undefined;
    const action = param(url, "action");
    const c = param(url, "category_id");
    log.push({ n, action, cat: c, timeoutMs: init && init.timeoutMs });
    if (action === "get_vod_categories" || action === "get_live_categories") return res(200, S2[n].cats);
    if (action === "get_vod_streams") return res(200, c === "1055" && S2[n].cats.some((x) => x.category_id === "1055") && (n === "ixh" || pHas) ? [MATRIX] : []);
    return res(200, []);
  }];
  const k = installKino({ routes, storage: { "idx:state": idxState() } });
  const onP = async (cat) => {
    await cat.healthCheck();
    const st = srvs(k);
    st.idx = st.list.findIndex((s) => s.url === S2.p.url);
    st.ok = true; st.okAt = T; st.mig = 1; st.chosen = keyOf(st.list[st.idx]);
    k.store.set("srvs", JSON.stringify(st));
    // The person's Home loaded p's VOD categories.
    k.store.set("cats:vod:" + keyOf(st.list[st.idx]), JSON.stringify({ ts: T, l: S2.p.cats.map((x) => [x.category_id, x.category_name]) }));
    log.length = 0;
  };
  return { ...k, log, S2, onP };
}
const hostOfOut = (out) => new URL(out.url).hostname;

test("an index result in a category the active account of the index's panel lacks: the index's server, not not_found", async () => {
  const lacking = ["1055", ...indexCats().map((x) => x.category_id).filter((id) => id !== "1055").slice(0, 5)]; // fit 66/72
  const w = ixWorld({ lack: lacking });
  const cat = await fresh("catalog.js");
  await w.onP(cat);
  const out = await cat.resolve("idx:m:matrix|1999|1055");
  assert.equal(hostOfOut(out), "home.example");
  assert.ok(out.url.endsWith("/777001.mkv"));
  assert.ok(!w.log.some((e) => e.n === "p" && e.action === "get_vod_streams"), "no walk through the partial account's categories");
});

test("the active account carries the title's own categories (though not every index category): it resolves there", async () => {
  const lacking = indexCats().map((x) => x.category_id).filter((id) => id !== "1055").slice(0, 6); // fit 66/72, has 1055
  const w = ixWorld({ lack: lacking });
  const cat = await fresh("catalog.js");
  await w.onP(cat);
  const out = await cat.resolve("idx:m:matrix|1999|1055");
  assert.equal(hostOfOut(out), "p.example");
  assert.ok(!w.log.some((e) => e.n === "ixh"), "no request to the index's server");
});

test("the active account fits the index but the title is not there: once more on the index's server", async () => {
  const w = ixWorld({ pHas: false });
  const cat = await fresh("catalog.js");
  await w.onP(cat);
  const out = await cat.resolve("idx:m:matrix|1999|1055");
  assert.equal(hostOfOut(out), "home.example");
  assert.ok(w.log.some((e) => e.n === "p" && e.action === "get_vod_streams"), "the active account was asked first");
});

test("the index panel's account hangs: short timeouts, no retry, a 10 s deadline, then the active server resolves", async () => {
  const w = world();
  const cat = await fresh("catalog.js");
  await cat.healthCheck();
  assert.equal(readPanels().ix.home, keyOf(srvOf("n")));
  setActive(w, "a1", { chosen: keyOf(srvOf("a1")) });
  SRV.n.answer = (init) => { advance((init && init.timeoutMs) || 15000); return kinoError("timeout", "timed out"); };
  try {
    const t0 = T;
    w.log.length = 0;
    await cat.resolve("idx:m:matrix|1999|1055").catch(() => null);
    const onN = w.log.filter((e) => e.n === "n");
    assert.ok(onN.length >= 1, "the index's panel was asked");
    assert.ok(onN.every((e) => e.timeoutMs && e.timeoutMs <= 4000), JSON.stringify(onN.map((e) => e.timeoutMs)));
    assert.ok(onN.every((e) => e.at - t0 < 10000), "nothing starts after the index server's deadline");
    assert.equal(new Set(onN.map((e) => e.action + ":" + e.cat)).size, onN.length, "no request is retried");
    assert.ok(w.log.some((e) => e.n === "a1" && e.action === "get_vod_streams"), "then the active server resolves by title");
  } finally { delete SRV.n.answer; }
});

// ---- the health check within one screen call -----------------------------------------------------------------------------

test("the health check ends within a screen call with hanging servers and a stale list, and writes what answered", async () => {
  const net = virtualNet({ start: T });
  Date.now = net.now;
  const hosts = Array.from({ length: 30 }, (_, i) => ({ url: `http://h${i}.example`, username: "u" + i, password: "p" + i, name: "🇲🇽" }));
  const hanging = new Set(hosts.filter((_, i) => i % 3 === 0).map((s) => new URL(s.url).hostname)); // 10 of 30
  const listText = hosts.map((s) => `${s.url}/get.php?username=${s.username}&password=${s.password} [${s.name}]`).join("\n");
  const boot = [];
  const routes = [(url, init) => {
    const u = new URL(url);
    if (u.hostname === "vegetatvv2.duckdns.org") { boot.push(init && init.timeoutMs); return net.request(800).then(() => res(200, { ok: true, servers_text: listText })); }
    if (u.hostname === "raw.githubusercontent.com") return net.request(600).then(() => (u.pathname.endsWith("/categories.json") ? res(200, INDEX) : res(404, "")));
    if (hanging.has(u.hostname)) return net.request((init && init.timeoutMs) || 15000).then(() => kinoError("timeout", "timed out"));
    return net.request(1200).then(() => res(200, [{ category_id: "1", category_name: "ACCION" }]));
  }];
  const stale = { ts: net.now() - 7 * H, list: hosts, idx: 0, ok: true, okAt: net.now(), v: 2, mig: 1 };
  const k = installKino({ routes, storage: { srvs: JSON.stringify(stale), "idx:state": idxState() } });
  const cat = await fresh("catalog.js");
  const t0 = net.now();
  const online = await net.run(cat.healthCheck());
  const took = net.now() - t0;
  assert.ok(took <= 16000, `took ${took} ms (Kino's screen call limit is 20 s)`);
  assert.ok(boot.length >= 1 && boot.every((t) => t && t <= 4000), "the server list is asked with a short timeout");
  assert.ok(online >= 10, String(online));
  assert.ok(JSON.parse(k.store.get("health:v1")).online.length >= online);
  assert.ok(k.store.get("panels:v1"));
});
