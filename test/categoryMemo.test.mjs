// The category lists of the last minutes, in memory (cache study #9): a category's whole list was downloaded again for every
// page Kino asked of it (browse, liveChannels), and Kino's live pages were 200 channels while it takes 500. Now one download
// serves every page for 3 min, per account; the En vivo row of the plugin's own catalog pages through the whole category.
import test from "node:test";
import assert from "node:assert/strict";
import { installKino, res, param, fresh } from "./helpers/fake-kino.mjs";
import { keyOf } from "../src/panels.js";

let T = Date.UTC(2026, 10, 18, 0);
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => T; });
test.afterEach(() => { Date.now = realNow; });

function world({ prefix, channels }) {
  const list = ["a", "b"].map((id) => ({ url: `http://${prefix}${id}.example`, username: "u" + id, password: "p" + id, name: "🇲🇽" }));
  const log = [];
  const routes = [(url) => {
    const u = new URL(url);
    const e = { host: u.hostname, action: param(url, "action"), cat: param(url, "category_id") };
    log.push(e);
    if (e.action === "get_live_categories") return res(200, [{ category_id: "9", category_name: "DEPORTES" }]);
    if (e.action === "get_live_streams") return res(200, Array.from({ length: channels }, (_, i) => ({ stream_id: 9000 + i, name: "Canal " + i, category_id: "9" })));
    return res(200, []);
  }];
  const k = installKino({ routes, storage: { srvs: JSON.stringify({ ts: T, list, idx: 0, ok: true, okAt: T, v: 2, mig: 1, chosen: keyOf(list[0]), homeAt: T }) } });
  return { ...k, log, streams: () => log.filter((e) => e.action === "get_live_streams") };
}

test("liveChannels: pages of 500 (Kino's), every page of a 1200-channel category from one download", async () => {
  const w = world({ prefix: "m1", channels: 1200 });
  const cat = await fresh("catalog.js");
  const p1 = await cat.liveChannels({ categoryId: "9" });
  const p2 = await cat.liveChannels({ categoryId: "9", cursor: p1.next });
  const p3 = await cat.liveChannels({ categoryId: "9", cursor: p2.next });
  assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [500, 500, 200]);
  assert.deepEqual([p1.next, p2.next, p3.next], ["500", "1000", undefined]);
  assert.equal(w.streams().length, 1, "one download for the three pages (it was one per page, of 200)");
  assert.equal(p3.items.at(-1).id, "live-10199");
});

test("browse of an En vivo row: the whole category, 60 at a time, from one download; past 3 min it is asked again", async () => {
  const w = world({ prefix: "m2", channels: 300 });
  const cat = await fresh("catalog.js");
  const pages = [];
  let cursor = "1";
  while (cursor) {
    const p = await cat.browse("lcat:9", cursor);
    pages.push(p.items.length);
    cursor = p.next;
  }
  assert.deepEqual(pages, [60, 60, 60, 60, 60], "all 300 channels (it stopped at the first 200)");
  assert.equal(w.streams().length, 1);
  T += 3 * 60 * 1000;
  await cat.browse("lcat:9", "1");
  assert.equal(w.streams().length, 2, "a list older than 3 min is fetched again");
});

test("lists are kept per account: another account's list of the same category is its own download", async () => {
  const w = world({ prefix: "m3", channels: 50 });
  const cat = await fresh("catalog.js");
  await cat.liveChannels({ categoryId: "9" });
  const st = JSON.parse(w.store.get("srvs"));
  st.idx = 1;
  w.store.set("srvs", JSON.stringify(st));
  await cat.liveChannels({ categoryId: "9" });
  assert.deepEqual(w.streams().map((e) => e.host), ["m3a.example", "m3b.example"]);
});
