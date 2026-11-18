// Name matching across panels: every must / must-not case from the design, on real public names (fixtures/panels.json).
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/fake-kino.mjs";
import { normChannel, channelTok, parseChannelTok, matchChannel, normCategory, categoryTok, matchCategory, sameCategory } from "../src/channelMatch.js";

const fx = fixture();
const streams = (srv, cat) => fx.streams[srv][cat].map(([stream_id, name]) => ({ stream_id, name }));
const cats = (srv) => fx.categories[srv].map(([category_id, category_name]) => ({ category_id, category_name }));
const A = streams("A", 2956);
const C = streams("C", 196);
const idOf = (list, name) => list.find((s) => s.name === name).stream_id;
const match = (name, list) => matchChannel(channelTok(name), list);

test("channel names: prefix, quality, noise and events", () => {
  assert.deepEqual(normChannel("ES ▎DAZN 1 HD"), { cc: "es", q: "hd", key: "dazn 1", event: false });
  assert.deepEqual(normChannel("┃ES┃ M+ LaLiga FHD"), { cc: "es", q: "fhd", key: "m plus laliga", event: false });
  assert.deepEqual(normChannel("DAZN SD 2"), { cc: "", q: "sd", key: "dazn 2", event: false });
  assert.equal(normChannel("UCL: Champions HEVC 50fps").key, "ucl champions"); // UCL is no country: it stays
  assert.equal(normChannel("TNT SPORTS HD").key, "tnt sports");
  assert.equal(normChannel("DAZN EVENTOS 1").event, true);
  assert.equal(channelTok("DAZN EVENTOS 1"), "");
  assert.equal(channelTok("ES ▎DAZN 1 HD"), "es.hd.dazn.1");
  assert.deepEqual(parseChannelTok("es.hd.dazn.1"), { cc: "es", q: "hd", key: "dazn 1" });
  assert.equal(parseChannelTok("bad tok"), null);
});

test("channels that must match across panels (A -> C and back)", () => {
  const pairs = [
    ["ES ▎DAZN 1 HD", "DAZN 1 HD"],
    ["ES ▎DAZN 1 FHD", "DAZN 1 FHD"],
    ["ES ▎DAZN 2 HD", "DAZN 2 HD"],
    ["ES ▎DAZN 3 FHD", "DAZN 3 FHD"],
    ["ES ▎DAZN 4 HD", "DAZN 4 HD"],
    ["ES ▎DAZN F1 HD", "Dazn F1 HD"],
    ["ES ▎DAZN F1 FHD", "DAZN F1 FHD"],
    ["ES ▎DAZN MOTOGP HD", "Dazn MotoGP HD"],
    ["ES ▎DAZN MOTOGP FHD", "Dazn MotoGP FHD"],
  ];
  for (const [src, dst] of pairs) assert.equal(match(src, C).id, idOf(C, dst), src);
  // Reverse: no quality prefers the same, then FHD; "SD" anywhere is the quality and walks the ladder.
  assert.equal(match("DAZN 1", A).id, idOf(A, "ES ▎DAZN 1 FHD"));
  assert.equal(match("DAZN SD 2", A).id, idOf(A, "ES ▎DAZN 2 HD"));
});

test("channels that must not match", () => {
  const tok = channelTok("ES ▎DAZN 1 HD");
  const traps = ["DAZN 10", "DAZN EVENTOS 1", "DAZN ACB 1", "DAZN F1 HD", "DAZN SERIE A 1 HD", "DAZN PREMIER 1 FHD", "DAZN BUNDESLIGA 1 HD"]
    .map((name, i) => ({ stream_id: String(900 + i), name }));
  assert.ok(!matchChannel(tok, traps).id);
  // Accepted misses (no alias table): LALIGA vs LIGA, ACB in its own category, the "DANZ" typo.
  assert.ok(!match("ES ▎DAZN LALIGA HD", C).id);
  assert.ok(!match("ES ▎DAZN LALIGA 2 HD", C).id);
  assert.ok(!match("ES ▎DAZN ACB 1", C).id);
  // An event is never matched, and "DAZN EVENTOS 1" is three times on C anyway.
  assert.equal(matchChannel(channelTok("DAZN EVENTOS 1"), C).why, "bad");
  // Two ids at the chosen quality: ambiguous, no guess.
  assert.equal(matchChannel("_.hd.foo", [{ stream_id: "1", name: "FOO HD" }, { stream_id: "2", name: "FOO HD" }]).why, "ambiguous");
  // Prefix countries that disagree never match.
  assert.ok(!matchChannel(channelTok("AR | ESPN HD"), [{ stream_id: "5", name: "MX | ESPN HD" }]).id);
});

test("category names: country, topic, events", () => {
  assert.deepEqual([...normCategory("ES ▎DAZN").topic], ["dazn"]);
  assert.equal(normCategory("ES ▎DAZN").cc, "es");
  assert.equal(normCategory("ESPAÑA DAZN").cc, "es");
  assert.equal(normCategory("DEPORTES DE MEXICO").cc, "mx"); // "de" inside a name is a word, not Germany
  assert.equal(normCategory("┃DE┃ DAZN LA LIGA").cc, "de");
  assert.equal(normCategory("LATINO DEPORTES").cc, "lat");
  assert.equal(categoryTok("ES ▎DAZN"), "es.dazn");
  assert.equal(categoryTok("ES ▎GENERAL"), "es");
  assert.ok(sameCategory(categoryTok("ES ▎DAZN"), "ES ▎DAZN"));
  assert.ok(!sameCategory(categoryTok("ES ▎DAZN"), "MULTI ▎ VIAPLAY"));
});

test("categories that must match", () => {
  const C_ = cats("C");
  const A_ = cats("A");
  const m = (src, list) => (matchCategory(categoryTok(src), list) || {}).id;
  assert.equal(m("ES ▎DAZN", C_), "196");
  assert.equal(m("ES ▎DEPORTE", C_), "3");
  assert.equal(m("ES ▎GENERAL", C_), "2");
  assert.equal(m("MEXICO", C_), "163");
  assert.equal(m("┃ES┃ DAZN ESPAÑA", A_), "2956");
  assert.equal(m("┃ES┃ DAZN ESPAÑA", C_), "196");
  assert.equal(m("┃ES┃ LA LIGA+", A_), "2945");
});

test("categories that must not match", () => {
  const all = [...cats("A"), ...cats("C")];
  const none = (src, list = all) => assert.equal(matchCategory(categoryTok(src), list), null, src);
  none("┃DE┃ DAZN LA LIGA", all.filter((c) => normCategory(c.category_name).cc === "es"));
  none("┃ES┃ DAZN LA LIGA", [{ category_id: "2945", category_name: "ES ▎LALIGA+" }]);
  none("ES ▎LALIGA+", [{ category_id: "195", category_name: "LALIGA HYPERMOTION Y  RFEF TV" }]);
  none("ES ▎M+ CAMPEONES", cats("C"));
  none("US ▎SPORTS", [{ category_id: "28", category_name: "USA" }]);
  none("ES ▎EVENTS");
  none("┃UK┃ UEFA EVENTS");
  none("EVENTOS ESPAÑA VIP");
  // Never on a region, a language or no country: the same brand airs different national feeds.
  none("DEPORTES", [{ category_id: "1", category_name: "DEPORTES" }]);
  none("LATINO DEPORTES", [{ category_id: "1", category_name: "DEPORTES LATINOS" }]);
  none("AR ▎ESPN", [{ category_id: "1", category_name: "MX ▎ESPN" }]);
});

test("a category without country still travels (and is never matched by name)", () => {
  assert.equal(categoryTok("DEPORTES"), "_.deporte");
  assert.ok(sameCategory("_.deporte", "DEPORTES"));
  assert.equal(matchCategory("_.deporte", [{ category_id: "1", category_name: "DEPORTES" }]), null);
});
