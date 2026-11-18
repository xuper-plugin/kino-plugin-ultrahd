// Fills everything Ultra HD keeps in kino.storage and checks the person's choices are never evicted (before 0.8.6, about 13
// plays of avail:v1 pushed srvChosen:v1, browseTab, browseLang and health:v1 out of the shared 2 KB "misc" class), the
// avail learning keeps working by trimming itself, the new panel and account entries keep their own budget, and the total
// stays under the plugin's 262144-byte cap without ever throwing.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, fresh } from "./helpers/fake-kino.mjs";
import { put, usage, classOf, CLASSES, TOTAL_CAP } from "../src/store.js";

const srvList = (n) => Array.from({ length: n }, (_, i) => ({
  url: `http://a-rather-long-host-name-number-${i}.example-panel.xyz:8080`,
  username: "user" + "x".repeat(14), password: "pass" + "y".repeat(14),
  name: "🇲🇽 Servidor de ejemplo con nombre largo " + i,
}));

test("30 long servers plus the chosen key fit the never-evicted servers class", () => {
  installKino();
  const text = JSON.stringify({ ts: Date.now(), list: srvList(30).map((s) => ({ ...s, name: s.name.slice(0, 40) })), idx: 29, ok: true, okAt: Date.now(), homeAt: Date.now(), chosen: "1abcdef", mig: 1, v: 2 });
  assert.ok(put("srvs", text), text.length + " B");
  assert.ok(put("vcode", "25"));
});

test("the classes: the person's choices, health, panels, accounts and the live switch are kept; avail has its own budget", () => {
  installKino();
  for (const [k, c] of [["srvChosen:v1", "prefs"], ["browseTab", "prefs"], ["browseLang", "prefs"], ["seed:v1", "prefs"], ["health:v1", "health"], ["panels:v1", "panels"], ["acct:v1", "acct"], ["live:v1", "live"], ["avail:v1", "avail"]]) assert.equal(classOf(k), c, k);
  for (const c of ["prefs", "health", "panels", "acct", "live", "servers"]) assert.equal(CLASSES[c].keep, true, c);
  assert.notEqual(CLASSES.avail.keep, true, "avail is a cache");
});

test("400 plays: srvChosen:v1 and the rest survive, and avail:v1 keeps learning within its budget", async () => {
  const servers = Array.from({ length: 7 }, (_, i) => ({ url: `http://s${i}.example`, username: "u" + i, password: "p" + i, name: "🇲🇽" }));
  const { store } = installKino({ routes: [() => res(200, [])] });
  let T = Date.UTC(2026, 10, 17, 12);
  const realNow = Date.now;
  Date.now = () => T;
  try {
    put("srvs", JSON.stringify({ ts: T, list: servers, idx: 0, ok: true, okAt: T, chosen: "x", mig: 1, v: 2 }));
    put("srvChosen:v1", "1");
    put("browseTab", "movies");
    put("browseLang", "es-419");
    put("health:v1", JSON.stringify({ ts: T, online: Array.from({ length: 22 }, (_, i) => `http://server-number-${i}.example.com:8080`) }));
    const cat = await fresh("catalog.js");
    for (let n = 1; n <= 400; n++) {
      T += 60000;
      const st = JSON.parse(store.get("srvs"));
      st.idx = n % servers.length; st.okAt = T;
      store.set("srvs", JSON.stringify(st));
      await cat.resolve(`vod:${100000 + n}:mkv~title ${n}`); // records avail:v1 for the active server
      for (const k of ["srvChosen:v1", "browseTab", "browseLang", "health:v1", "srvs"]) assert.ok(store.has(k), `${k} evicted at play ${n}`);
    }
    const avail = JSON.parse(store.get("avail:v1"));
    assert.ok(avail["m:100400"], "the latest play is learnt");
    assert.ok(!avail["m:100001"], "the oldest ones were trimmed");
    assert.ok(store.get("avail:v1").length <= 15 * 1024);
    const u = usage();
    for (const [c, n] of Object.entries(u.byClass)) assert.ok(n <= CLASSES[c].budget, `${c}: ${n} > ${CLASSES[c].budget}`);
  } finally { Date.now = realNow; }
});

test("the person's choice survives any pressure from other classes; panels and accounts keep their budgets", () => {
  const { store } = installKino();
  put("srvChosen:v1", "1");
  put("browseTab", "movies");
  put("browseLang", "es-419");
  put("seed:v1", "123456789");
  put("srvs", JSON.stringify({ ts: 1, list: srvList(30), idx: 0, v: 2 }));
  const g = {}; const t = {};
  for (let i = 0; i < 60; i++) { g["k" + i.toString(36).padStart(7, "0")] = "k000000" + (i % 9); t["k" + i.toString(36).padStart(7, "0")] = Date.now(); }
  const ix = { src: "19c7mrn", fits: ["k0000001", "k0000002", "k0000003"], home: "k0000002" };
  assert.ok(put("panels:v1", JSON.stringify({ v: 1, at: Date.now(), g, t, ix })), "60 servers and the index's accounts fit the panels class");
  const dead = {}; for (let i = 0; i < 40; i++) dead["k" + i.toString(36).padStart(6, "0")] = [Date.now(), "abcdef"];
  assert.ok(put("acct:v1", JSON.stringify({ v: 1, dead, blocked: { a: "0.8.6", b: "0.8.6" } })), "40 dead accounts fit");
  put("health:v1", JSON.stringify({ ts: Date.now(), online: srvList(30).map((s) => s.url) }));
  put("live:v1", JSON.stringify({ p: "k0000001|201583", k: "k0000002", id: "201583", a: "k0000001", at: Date.now() }));
  // Everything else the plugin writes, over and over.
  for (let round = 0; round < 40; round++) {
    put("cats:vod:s" + round, JSON.stringify({ ts: Date.now(), l: Array.from({ length: 150 }, (_, i) => [String(i), "CATEGORÍA DE EJEMPLO " + i]) }));
    put("homeSnap:v3:s" + round + ":home:es", "x".repeat(9000));
    put("vinfo:s" + round, "v".repeat(20000));
    put("searchHist:v1:s" + round, "y".repeat(3000));
    put("avail:v1", "a".repeat(15000));
    put("misc-" + round, "z".repeat(600)); // the 2 KB misc class
  }
  for (const k of ["srvChosen:v1", "browseTab", "browseLang", "seed:v1", "srvs", "panels:v1", "acct:v1", "health:v1", "live:v1"]) assert.ok(store.has(k), k + " evicted");
  const u = usage();
  assert.ok(u.total < TOTAL_CAP, String(u.total));
  for (const [c, n] of Object.entries(u.byClass)) assert.ok(n <= CLASSES[c].budget, `${c}: ${n} > ${CLASSES[c].budget}`);
});

test("a value too big for its class is refused with false, never thrown", () => {
  installKino();
  assert.equal(put("panels:v1", "x".repeat(5000)), false);
  assert.equal(put("srvChosen:v1", "x".repeat(400)), false);
  assert.equal(put("avail:v1", "x".repeat(17000)), false);
});
