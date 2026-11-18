// Panel grouping (exact containment of "id|name" category pairs, around anchors) and the dead / blocked account memory.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, installKino } from "./helpers/fake-kino.mjs";
import { pairHashes, groupPanels, linked, panelOf, membersOf, readPanels, writePanels, noteDead, noteBlocked, noteAlive, isDead, isBlocked, usable, accountVerdict, keyOf, ACCT_KEY } from "../src/panels.js";
import { PLUGIN_VERSION } from "../src/version.js";

const fx = fixture();
const cats = (srv) => fx.categories[srv].map(([category_id, category_name]) => ({ category_id, category_name }));
const sets = (obj) => new Map(Object.entries(obj).map(([k, list]) => [k, pairHashes(list)]));
const H = 3600000;
const DAY = 24 * H;

test("two accounts of one panel group together; foreign panels do not", () => {
  const map = groupPanels(sets({ a: cats("A"), b: cats("B"), c: cats("C"), z: cats("Z") }), null, 1000);
  assert.equal(map.g.a, map.g.b);
  assert.notEqual(map.g.a, map.g.c);
  assert.notEqual(map.g.a, map.g.z);
  assert.notEqual(map.g.c, map.g.z);
});

test("a 30 % bouquet of the same panel still groups (containment, not similarity)", () => {
  const small = cats("B").filter((_, i) => i % 10 < 3);
  assert.ok(small.length >= 8);
  const map = groupPanels(sets({ a: cats("A"), s: small }), null, 1);
  assert.equal(map.g.s, map.g.a);
});

test("a chance overlap of a few pairs never groups (the 8-pair floor)", () => {
  const common = Array.from({ length: 5 }, (_, i) => ({ category_id: String(i + 1), category_name: ["PELICULAS", "SERIES", "DEPORTES", "NOTICIAS", "INFANTIL"][i] }));
  const x = [...common, ...Array.from({ length: 40 }, (_, i) => ({ category_id: String(100 + i), category_name: "X " + i }))];
  const y = [...common, ...Array.from({ length: 40 }, (_, i) => ({ category_id: String(500 + i), category_name: "Y " + i }))];
  const s = sets({ x, y });
  assert.equal(linked(s.get("x"), s.get("y")), false);
  const map = groupPanels(s, null, 1);
  assert.notEqual(map.g.x, map.g.y);
});

test("a small account contained in two panels never merges them (anchors)", () => {
  const p1 = Array.from({ length: 60 }, (_, i) => ({ category_id: String(i), category_name: "P1 " + i }));
  const p2 = Array.from({ length: 50 }, (_, i) => ({ category_id: String(1000 + i), category_name: "P2 " + i }));
  const shared = Array.from({ length: 10 }, (_, i) => ({ category_id: String(5000 + i), category_name: "BOTH " + i }));
  const map = groupPanels(sets({ big1: [...p1, ...shared], big2: [...p2, ...shared], tiny: shared }), null, 1);
  assert.notEqual(map.g.big1, map.g.big2);
  assert.equal(map.g.tiny, undefined, "ambiguous: unknown");
});

test("labels survive; an offline server keeps its label 7 days and follows a relabel", () => {
  const first = groupPanels(sets({ a: cats("A"), b: cats("B"), c: cats("C") }), null, 0);
  // b offline now; a answers alone: the group keeps its label and b keeps it too.
  const second = groupPanels(sets({ a: cats("A"), c: cats("C") }), first, 2 * DAY);
  assert.equal(second.g.a, first.g.a);
  assert.equal(second.g.b, first.g.a);
  assert.equal(second.t.b, first.t.b, "b's confirmation time is not refreshed");
  // 7 days later b is dropped.
  const third = groupPanels(sets({ a: cats("A"), c: cats("C") }), second, 8 * DAY);
  assert.equal(third.g.b, undefined);
  // A relabel (the previous label was taken by another group) carries the offline member along.
  const prev = { v: 1, at: 0, g: { a: "L1", b: "L1", c: "L1" }, t: { a: 0, b: 0, c: 0 } };
  const next = groupPanels(sets({ a: cats("A"), c: cats("C") }), prev, H);
  assert.notEqual(next.g.a, next.g.c);
  assert.ok([next.g.a, next.g.c].includes("L1"));
  assert.equal(next.g.b, "L1");
});

test("the stored map: panelOf, membersOf by confirmation age", () => {
  installKino();
  const now = Date.now();
  writePanels({ v: 1, at: now, g: { a: "P", b: "P", c: "Q" }, t: { a: now, b: now - 3 * DAY, c: now } });
  const map = readPanels();
  assert.equal(panelOf("a", map), "P");
  assert.equal(panelOf("zz", map), null);
  assert.deepEqual(membersOf("P", map, now, DAY), ["a"]);
  assert.deepEqual(membersOf("P", map, now).sort(), ["a", "b"]);
});

test("dead accounts: a day, tied to the credential; blocked: until the next version", () => {
  const { store } = installKino();
  const srv = { url: "http://s.example", username: "u", password: "p" };
  assert.ok(usable(srv));
  noteDead(srv, 1000);
  assert.ok(isDead(srv, 1000 + H));
  assert.ok(!usable(srv, 1000 + H));
  assert.ok(!isDead(srv, 1000 + DAY + 1), "after 24 h it may be probed again");
  assert.ok(!isDead({ ...srv, password: "new" }, 1000 + H), "a new password is a new account");
  noteAlive(srv);
  assert.ok(!isDead(srv, 1000 + H));
  noteBlocked(srv);
  assert.ok(isBlocked(srv));
  store.set(ACCT_KEY, JSON.stringify({ v: 1, dead: {}, blocked: { [keyOf(srv)]: "0.0.1" } }));
  assert.ok(!isBlocked(srv), "a mark from another version does not count");
  assert.notEqual(PLUGIN_VERSION, "0.0.1");
});

test("noteAlive writes nothing when there was no mark", () => {
  const { writes } = installKino();
  noteAlive({ url: "http://s.example", username: "u", password: "p" });
  assert.deepEqual(writes, []);
});

test("account verdicts", () => {
  assert.equal(accountVerdict({ user_info: { auth: 0, status: "Invalid", message: "Invalid username or password" } }), "dead");
  assert.equal(accountVerdict({ user_info: { auth: 1, status: "Expired" } }), "dead");
  assert.equal(accountVerdict({ user_info: { auth: 1, status: "Active", exp_date: "1000" } }, 2000 * 1000), "dead");
  assert.equal(accountVerdict({ user_info: { auth: 1, status: "Active", exp_date: null } }), null);
  assert.equal(accountVerdict([{ category_id: "1" }]), null);
});
