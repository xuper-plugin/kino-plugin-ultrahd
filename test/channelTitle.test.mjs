// What a live channel's title shows (src/channelTitle.js): the panels' decorations go, real names stay, two channels of one
// list never end up looking alike because of it, and Kino still finds every favourite (its id and ref never change).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers/fake-kino.mjs";
import { cleanChannelTitle, channelTitles, cleanCards, cleanRails, categoryKey, normName } from "../src/channelTitle.js";
import { channelTok } from "../src/channelMatch.js";

const titles = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "channel-titles.json"), "utf8"));
const fx = fixture();
const namesOf = (srv, cat) => fx.streams[srv][cat].map(([, name]) => name);
const A = namesOf("A", 2956);
const C = namesOf("C", 196);
const allReal = () => {
  const out = new Set([...titles.strip.map(([raw]) => raw), ...titles.keep.map(([raw]) => raw)]);
  for (const list of Object.values(fx.categories)) for (const [, name] of list) out.add(name);
  for (const srv of Object.values(fx.streams)) for (const list of Object.values(srv)) for (const [, name] of list) out.add(name);
  return [...out];
};

test("decorations are dropped: bars, the codes they frame, at either end, repeated or mixed", () => {
  for (const [raw, want, src] of titles.strip) assert.equal(cleanChannelTitle(raw).title, want, `${raw} (${src})`);
});

test("real names stay: a code alone, a code without a separator, codes inside a name, unknown tags", () => {
  for (const [raw, src] of titles.keep) assert.equal(cleanChannelTitle(raw).title, raw, `${raw} (${src})`);
});

test("real panels: every 'ES ▎' channel of A loses its prefix and nothing else; C's names stay as the panel wrote them", () => {
  for (const raw of A) assert.equal(cleanChannelTitle(raw).title, raw.replace(/^ES ▎/, ""), raw);
  for (const raw of C) assert.equal(cleanChannelTitle(raw).title, raw.replace(/\s+/g, " ").trim(), raw);
  assert.deepEqual(cleanChannelTitle("ES ▎DAZN 1 HD").marks, ["es"]);
  assert.deepEqual(cleanChannelTitle("BE ▎DAZN EVENTS [FR]").marks, ["be", "fr"]);
  assert.deepEqual(cleanChannelTitle("4K ▎DAZN 1").marks, [], "a quality is information, not a mark");
});

test("never empty, never twice: every real name keeps text and cleaning a clean title changes nothing", () => {
  const all = allReal();
  assert.ok(all.length > 400);
  for (const raw of all) {
    const once = cleanChannelTitle(raw).title;
    assert.ok(/[\p{L}\p{N}]/u.test(once), raw);
    assert.equal(cleanChannelTitle(once).title, once, raw);
  }
  for (const raw of ["", "┃", " ▎ ", "┃ES┃", "ES ▎", "[ES]"]) { const t = cleanChannelTitle(raw).title; assert.ok(t === raw.trim() || /[\p{L}\p{N}]/u.test(t), raw); }
  assert.equal(cleanChannelTitle("┃ES┃").title, "ES");
  assert.equal(cleanChannelTitle(null).title, "");
});

test("the ref keeps reading the raw name: a cleaned name would lose the country the cross-panel match uses", () => {
  // Why liveItem builds the ref from the panel's raw name, never from the shown title.
  assert.equal(channelTok("ES ▎DAZN 1 HD"), "es.hd.dazn.1");
  assert.equal(channelTok(cleanChannelTitle("ES ▎DAZN 1 HD").title), "_.hd.dazn.1");
});

test("a category of the prefix's own country drops it; a mixed list brings it back only where two would look alike", () => {
  // A's own category (ES ▎DAZN): no suffix anywhere, every title is the clean one.
  const own = channelTitles(A, { cat: categoryKey("ES ▎DAZN"), lang: "es" });
  assert.deepEqual(own, A.map((n) => n.replace(/^ES ▎/, "")));
  assert.equal(categoryKey("ES ▎DAZN"), "es");
  assert.equal(categoryKey("┃ES┃ M+ DEPORTES"), "es");
  assert.equal(categoryKey("ESPAÑA DAZN"), "es");
  assert.equal(categoryKey("RELAX TIME"), "");
  // One mixed list (a search): A's "ES ▎DAZN 1 HD" next to C's "DAZN 1 HD".
  assert.deepEqual(channelTitles(["ES ▎DAZN 1 HD", "DAZN 1 HD", "ES ▎DAZN 2 HD"], { lang: "es" }), ["DAZN 1 HD · España", "DAZN 1 HD", "DAZN 2 HD"]);
  assert.deepEqual(channelTitles(["ES ▎DAZN 1 HD", "DAZN 1 HD"], { cat: "es", lang: "es" }), ["DAZN 1 HD", "DAZN 1 HD"], "in Spain's own category a plain name is Spain's too");
  assert.deepEqual(channelTitles(["┃MX┃ ESPN", "┃AR┃ ESPN", "ESPN 2"], { lang: "es" }), ["ESPN · México", "ESPN · AR", "ESPN 2"]);
  assert.deepEqual(channelTitles(["┃MX┃ ESPN", "┃AR┃ ESPN"], { lang: "en" }), ["ESPN · Mexico", "ESPN · AR"]);
  assert.deepEqual(channelTitles(["┃MX┃ ESPN", "┃AR┃ ESPN"], { cat: "mx", lang: "es" }), ["ESPN", "ESPN · AR"]);
  assert.deepEqual(channelTitles(["UK ▎SKY SPORTS", "┃US┃ SKY SPORTS"], { lang: "en" }), ["SKY SPORTS · UK", "SKY SPORTS · USA"]);
  // The same code in two styles tells nothing apart: no suffix. Names that were already identical stay so.
  assert.deepEqual(channelTitles(["ES ▎DAZN 1", "┃ES┃ DAZN 1"], { lang: "es" }), ["DAZN 1", "DAZN 1"]);
  assert.deepEqual(channelTitles(["DAZN EVENTOS 1", "DAZN EVENTOS 1"], { lang: "es" }), ["DAZN EVENTOS 1", "DAZN EVENTOS 1"]);
  // A quality stays in the name, so it never collides.
  assert.deepEqual(channelTitles(["4K ▎DAZN 1", "HD ▎DAZN 1", "DAZN 1"], { lang: "es" }), ["DAZN 1 4K", "DAZN 1 HD", "DAZN 1"]);
  // Twice over is the same list.
  const once = channelTitles(["ES ▎DAZN 1 HD", "DAZN 1 HD", "PT ▎DAZN 1 HD"], { lang: "es" });
  assert.deepEqual(channelTitles(once, { lang: "es" }), once);
});

test("a group before a panel bar goes (BEIN, UEFA, VIA, F1, UCL, SPORTS, MGP); a name before a bar and a code stays", () => {
  // zee-ott files a fifth of its channels under such a group (real names, 2026-11-17)
  assert.deepEqual(cleanChannelTitle("BEIN ▎BEIN SPORTS 1 HD"), { title: "BEIN SPORTS 1 HD", marks: ["=BEIN"] });
  assert.equal(cleanChannelTitle("┃UCL┃ CHAMPIONS LEAGUE").title, "CHAMPIONS LEAGUE");
  assert.equal(cleanChannelTitle("┃ES┃ MULTI ▎ VIAPLAY ┃ES┃").title, "VIAPLAY");
  // the word before the bar is the name when a code, a code in bars or a number follows
  assert.equal(cleanChannelTitle("ESPN ▎MX").title, "ESPN");
  assert.equal(cleanChannelTitle("ESPN ┃MX┃").title, "ESPN");
  assert.equal(cleanChannelTitle("ESPN ┃MX┃ 2").title, "ESPN 2");
  assert.equal(cleanChannelTitle("ESPN ┃F1┃ 2").title, "ESPN · F1 · 2");
  assert.equal(cleanChannelTitle("DAZN ▎ 2").title, "DAZN · 2");
  // "TV" names a channel; a plain "|" marks no group
  assert.equal(cleanChannelTitle("TV ▎ NOTICIAS").title, "TV · NOTICIAS");
  assert.equal(cleanChannelTitle("ESPN | Fútbol").title, "ESPN · Fútbol");
  // in one list (a search) two feeds that only the group or code told apart get it back, the group as written
  assert.deepEqual(channelTitles(["BEIN ▎BEIN SPORTS 1 HD", "TR ▎BEIN SPORTS 1 HD", "BEIN ▎BEIN SPORTS 2 HD"], { lang: "es" }),
    ["BEIN SPORTS 1 HD · BEIN", "BEIN SPORTS 1 HD · Turquía", "BEIN SPORTS 2 HD"]);
  assert.deepEqual(channelTitles(["BEIN ▎BEIN SPORTS 1 HD", "TR ▎BEIN SPORTS 1 HD"], { lang: "en" }), ["BEIN SPORTS 1 HD · BEIN", "BEIN SPORTS 1 HD · Turkey"]);
});

test("ex-Yugoslav codes: (SR), (SL), (BIH) go; feeds told apart by them are named by country, not by the group they share", () => {
  // zee-ott's "EXYU ▎SPORTSKI KANALI" (real, 2026-11-17): Serbian and Croatian feeds of one channel side by side
  const exyu = ["EXYU ▎ARENA SPORT 1 HD (SR)", "EXYU ▎ARENA SPORT 2 HD (SR)", "EXYU ▎ARENA SPORT 1 HD (HR)", "EXYU ▎ARENA SPORT 2 HD (HR)",
    "EXYU ▎ARENA SPORT 6 HD (HR)", "EXYU ▎ARENA SPORTS 1 FHD (SL)", "EXYU ▎ARENA 1 PREMIUM (BIH)", "EXYU ▎ARENA SPORT 1 BIH", "EXYU ▎EUROSPORT 1 HD"];
  assert.deepEqual(channelTitles(exyu, { lang: "es" }), ["ARENA SPORT 1 HD · Serbia", "ARENA SPORT 2 HD · Serbia", "ARENA SPORT 1 HD · Croacia",
    "ARENA SPORT 2 HD · Croacia", "ARENA SPORT 6 HD", "ARENA SPORTS 1 FHD", "ARENA 1 PREMIUM", "ARENA SPORT 1 BIH", "EUROSPORT 1 HD"]);
  assert.deepEqual(channelTitles(exyu.slice(0, 3), { lang: "en" }), ["ARENA SPORT 1 HD · Serbia", "ARENA SPORT 2 HD", "ARENA SPORT 1 HD · Croatia"]);
  assert.deepEqual(cleanChannelTitle("EXYU ▎ARENA SPORTS 1 FHD (SL)").marks, ["exyu", "si"]);
  assert.deepEqual(cleanChannelTitle("EXYU ▎ARENA 1 PREMIUM (BIH)").marks, ["exyu", "ba"]);
});

test("\"!\" frames a known code only: \"!ES! DAZN 1\" loses it, \"Yu-Gi-Oh!\" keeps its \"!\"", () => {
  assert.deepEqual(cleanChannelTitle("!ES! DAZN 1"), { title: "DAZN 1", marks: ["es"] });
  assert.equal(cleanChannelTitle("DAZN 1 !ES!").title, "DAZN 1");
  assert.equal(cleanChannelTitle("!ES! ┃HD┃ DAZN 2").title, "DAZN 2 HD");
  assert.equal(cleanChannelTitle("Yu-Gi-Oh!").title, "Yu-Gi-Oh!");
  assert.equal(cleanChannelTitle("!WOW! TV").title, "!WOW! TV");
  assert.equal(cleanChannelTitle("!ES!").title, "!ES!", "nothing would be left: as written");
});

test("a name cleaned again is remembered: the same answer, and changing one answer's marks changes no later one", () => {
  const all = allReal();
  const first = all.map((n) => cleanChannelTitle(n));
  const again = all.map((n) => cleanChannelTitle(n));
  assert.deepEqual(again, first);
  const one = cleanChannelTitle("ES ▎DAZN 1 HD");
  one.marks.push("mx");
  one.title = "x";
  assert.deepEqual(cleanChannelTitle("ES ▎DAZN 1 HD"), { title: "DAZN 1 HD", marks: ["es"] });
  // remembered, not parsed again: Kino asks a 3,000-channel category page by page and each page cleans the whole list
  const name = "BEIN ▎BEIN SPORTS 9 HD";
  cleanChannelTitle(name);
  const replace = String.prototype.replace;
  let parsed = 0;
  String.prototype.replace = function (...args) { parsed++; return replace.apply(this, args); };
  try { cleanChannelTitle(name); } finally { String.prototype.replace = replace; }
  assert.equal(parsed, 0, "a name cleaned before is not parsed again");
  // past the bound the memory starts over, with the same answers
  for (let i = 0; i < 20005; i++) cleanChannelTitle("ES ▎CANAL " + i);
  assert.deepEqual(cleanChannelTitle("ES ▎CANAL 7"), { title: "CANAL 7", marks: ["es"] });
  assert.deepEqual(all.map((n) => cleanChannelTitle(n)), first);
});

test("cards and rails: only titles change, every card keeps its id and ref; a rail's own country comes from its title", () => {
  const cards = A.slice(0, 6).map((name, i) => ({ id: "live-" + i, ref: "live:" + i + "~2956~es.dazn~" + channelTok(name), title: name, kind: "live" }));
  const out = cleanCards(cards, { cat: "es", lang: "es" });
  assert.deepEqual(out.map((c) => c.ref), cards.map((c) => c.ref));
  assert.deepEqual(out.map((c) => c.id), cards.map((c) => c.id));
  assert.deepEqual(out.map((c) => c.title), A.slice(0, 6).map((n) => n.replace(/^ES ▎/, "")));
  const rails = cleanRails([{ id: "lcat-2956", title: "ES DAZN", items: cards }, { id: "x", title: "Mixed", items: [{ id: "a", ref: "r", title: "|MX| ESPN" }, { id: "b", ref: "s", title: "ESPN" }] }], "en");
  assert.equal(rails[0].items[0].title, "DAZN LALIGA FHD");
  assert.deepEqual(rails[1].items.map((c) => c.title), ["ESPN · Mexico", "ESPN"]);
  assert.equal(cleanRails(null, "es"), null);
  assert.deepEqual(cleanCards([], {}), []);
});

// ---- Kino's side ------------------------------------------------------------------------------------------------------
// LiveChannelIdentity (kino-app origin/main, app/src/main/java/com/arkiv/player/data/live/LiveChannelIdentity.kt): a saved
// channel is the listed one under its id when the names agree, else the one with its ref, else the one with its name.
const kinoNorm = (s) => String(s).normalize("NFD").replace(/\p{Mn}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const sameName = (a, b) => { const x = kinoNorm(a); return x !== "" && x === kinoNorm(b); };
function kinoFind(saved, listed) {
  const atCode = listed.find((c) => c.code === saved.code) || null;
  if (!saved.name || saved.name === saved.code) return atCode;
  if (atCode && sameName(atCode.name, saved.name)) return atCode;
  if (saved.ref) { const r = listed.find((c) => c.ref === saved.ref); if (r) return r; }
  return listed.find((c) => sameName(c.name, saved.name)) || null;
}

test("Kino's favourites: a favourite saved under the decorated name still finds its channel (same id, same ref)", () => {
  const ref = (i, name) => `live:${100 + i}~2956~es.dazn~${channelTok(name)}`;
  const before = A.map((name, i) => ({ code: "live-" + (100 + i), name, ref: ref(i, name) }));
  const shown = channelTitles(A, { cat: "es", lang: "es" });
  const after = A.map((name, i) => ({ code: "live-" + (100 + i), name: shown[i], ref: ref(i, name) }));
  for (const fav of before) {
    const found = kinoFind(fav, after);
    assert.ok(found && found.code === fav.code, fav.name);
  }
  // Saved after the change: matched by id + name, as any channel.
  for (const fav of after) assert.equal(kinoFind(fav, after), after.find((c) => c.code === fav.code));
  // Kino's comparison ignores none of the decorations itself: only accents, case and spacing.
  assert.equal(sameName("ES ▎DAZN 1 HD", "DAZN 1 HD"), false);
  assert.equal(sameName("Dazn 1  HD", "DAZN 1 HD"), true);
  // normName is Kino's comparison.
  for (const n of allReal()) assert.equal(normName(n), kinoNorm(n), n);
});

test("HTML entities a panel left in a name are decoded, once or twice escaped (A&AMP;E is A&E)", () => {
  assert.equal(cleanChannelTitle("A&AMP;E").title, "A&E");
  assert.equal(cleanChannelTitle("A&amp;E").title, "A&E");
  assert.equal(cleanChannelTitle("A&amp;amp;E HD").title, "A&E HD");
  assert.equal(cleanChannelTitle("Rock &#39;n&#39; Roll &#x26; Co").title, "Rock 'n' Roll & Co");
  assert.equal(cleanChannelTitle("AT&T &unknown; &#0;").title, "AT&T &unknown; &#0;", "anything else stays as written");
});

test("a full country name before a bar, ':' or '·', or between brackets, is a decoration like its code", () => {
  for (const [raw, title, mark] of [
    ["BOLIVIA | PAT PLUS", "PAT PLUS", "bo"], ["BOLIVIA · PAT PLUS", "PAT PLUS", "bo"], ["BOLIVIA: PAT PLUS", "PAT PLUS", "bo"],
    ["MÉXICO: AZTECA 7", "AZTECA 7", "mx"], ["MEXICO ┃ AZTECA 7", "AZTECA 7", "mx"], ["[COSTA RICA] TELETICA", "TELETICA", "cr"],
    ["COSTA RICA ┃ TELETICA", "TELETICA", "cr"], ["PERU | TV PERU", "TV PERU", "pe"], ["ESPAÑA ▎ LA 1", "LA 1", "es"],
  ]) assert.deepEqual(cleanChannelTitle(raw), { title, marks: [mark] }, raw);
  // Never before a dash, never when another country follows (a match), never without a separator, never the whole name.
  for (const raw of ["ESPAÑA - ITALIA", "BOLIVIA TV", "CANADA", "TV PERU", "COLOMBIA"]) assert.equal(cleanChannelTitle(raw).title, raw, raw);
  assert.equal(cleanChannelTitle("ESPAÑA | ITALIA").title, "ESPAÑA · ITALIA");
  // Applying it twice changes nothing.
  for (const raw of ["BOLIVIA | PAT PLUS", "A&AMP;E", "[COSTA RICA] TELETICA"]) {
    const once = cleanChannelTitle(raw).title;
    assert.equal(cleanChannelTitle(once).title, once, raw);
  }
});

test("the dropped country name comes back only to tell two channels apart, and never as the list's own country", () => {
  assert.deepEqual(channelTitles(["BOLIVIA | PAT PLUS", "PERU | PAT PLUS"]), ["PAT PLUS · Bolivia", "PAT PLUS · Perú"]);
  assert.deepEqual(channelTitles(["BOLIVIA | PAT PLUS", "BOLIVIA | RTP"], { cat: "bo" }), ["PAT PLUS", "RTP"]);
  assert.equal(categoryKey("Bolivia"), "bo");
});
