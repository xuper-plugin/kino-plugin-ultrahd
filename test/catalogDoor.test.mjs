// The catalog door (Kino's plugin protocol): Da-Video's search reaches Ultra Hd through proto_catalog_search, answered from the
// title index only (kino.catalog), never from a live walk over the servers' categories.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installKino, fresh } from "./helpers/fake-kino.mjs";

test("the manifest provides the catalog door from apiVersion 20 and plugin.js exports proto_catalog_search", () => {
  const m = JSON.parse(readFileSync(new URL("../kino-plugin.json", import.meta.url)));
  const p = m.enhancements["20"].provides;
  assert.deepEqual(Object.keys(p), ["catalog"]);
  assert.deepEqual(Object.keys(p.catalog.calls), ["search"]);
  assert.deepEqual(p.catalog.calls.search.in, { q: "string", type: "string?" });
  const src = readFileSync(new URL("../src/plugin.js", import.meta.url), "utf8");
  assert.match(src, /export const proto_catalog_search = once\(catalogDoor\(cat\.catalogSearch\)\);/);
  assert.match(readFileSync(new URL("../plugin.js", import.meta.url), "utf8"), /proto_catalog_search/);
});

// A kino.catalog over [rows] whose search matches the words in the title, and an index state that is complete and fresh.
function withIndex(rows, { done = true } = {}) {
  const env = installKino({
    storage: { "idx:state": JSON.stringify({ v: 1, done, rev: "20261124T000000Z", src: "x", checked: Date.now(), total: rows.length }) },
  });
  const searches = [];
  env.kino.catalog = {
    search: async ({ q }) => {
      searches.push(q);
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      const items = rows.filter((r) => words.every((w) => r.title.toLowerCase().includes(w)));
      return { items, total: items.length };
    },
    count: async () => rows.length,
    get: async () => [],
  };
  return { ...env, searches };
}

const ROWS = [
  { id: "m-spider-man-brand-new-day-2026", title: "Spider-Man: Brand New Day", sort: 2026, data: JSON.stringify({ y: 2026, c: [12, 40], t: 969681 }) },
  { id: "s-la-casa-de-papel-corea-2022", title: "La casa de papel: Corea", sort: 2022, data: JSON.stringify({ y: 2022, c: [7] }) },
];

test("the door answers from the index: idx refs, kinds, years and the TMDB id, with no request to any server", async () => {
  const { requests, searches } = withIndex(ROWS);
  const { catalogDoor } = await fresh("door.js");
  const cat = await fresh("catalog.js");
  const door = catalogDoor(cat.catalogSearch);
  const found = await door({ q: "spider-man" });
  assert.deepEqual(searches, ["spider-man"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].title, "Spider-Man: Brand New Day");
  assert.equal(found[0].kind, "movie");
  assert.equal(found[0].year, "2026");
  assert.equal(found[0].tmdb, 969681);
  assert.match(found[0].ref, /^idx:m:spider man brand new day\|2026\|12,40$/);
  const series = await door({ q: "casa de papel", type: "series" });
  assert.deepEqual(series.map((x) => [x.kind, x.ref.slice(0, 6)]), [["series", "idx:s:"]]);
  assert.deepEqual(await door({ q: "casa de papel", type: "movie" }), []);
  assert.equal(requests.length, 0);
});

test("empty words and an index that is not ready answer nothing, without the live search", async () => {
  const { requests, searches } = withIndex(ROWS, { done: false });
  const { catalogDoor } = await fresh("door.js");
  const cat = await fresh("catalog.js");
  const door = catalogDoor(cat.catalogSearch);
  assert.deepEqual(await door({ q: "  " }), []);
  assert.deepEqual(await door({ q: "spider" }), []);
  assert.deepEqual(searches, []);
  // Only the index's own download may have been tried (one short step), never a server of the service.
  assert.ok(requests.every((r) => r.url.startsWith("https://raw.githubusercontent.com/xuper-plugin/kino-plugin-ultrahd-data/")), requests.map((r) => r.url).join("\n"));
});
