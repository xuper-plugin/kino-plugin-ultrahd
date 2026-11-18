// Live failover inside resolve(). Every account of the service is public and shared (1-3 connections, far over), so the
// account playing a live channel often refuses it (407, 509, a dead body) or its edge keeps cutting. Then the same stream
// id plays on ANOTHER ACCOUNT OF THE SAME PANEL, else the same channel found BY NAME on one other panel; never the same id
// on a foreign panel (ids are per panel). Evidence first: Kino resolves a channel's neighbours ahead (zapping) and a
// reopen after a cut uses the same ref, so only CONSECUTIVE resolves of one channel count as a chain; the first repeat only
// re-checks the account, the second one switches. Nothing here changes the active server, home or any list: only the URL
// of that one play uses another account.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { put } from "./store.js";
import { keyOf, panelOf, membersOf, readPanels, usable, noteBlocked } from "./panels.js";
import { sameCategory, categoryTok, matchCategory, matchChannel } from "./channelMatch.js";

export const CHAIN_GAP_MS = 45000;     // covers the give-up watch's 30 s plus the player's open and fail time
export const STICKY_MS = 600000;       // a channel stays on the account it moved to for 10 min
const REFUSED_MS = 600000;
const VERIFIED_MS = 24 * 60 * 60 * 1000;
const NAME_MS = 30 * 60 * 1000;
const LIST_MS = 10 * 60 * 1000;
const CATS_FRESH_MS = 10 * 60 * 1000;  // older live categories are asked again (once) before a ref's category is called unknown
const DEADLINE_MS = 10000;             // Kino allows resolve 20 s; calls are serialised per plugin, so a zap waits on this
export const MAX_PER_RESOLVE = 6;
const MAX_PER_CHANNEL = 12;            // extra requests per channel per 10 min, over a whole reopen chain and give-up watch
const STICKY_KEY = "live:v1";
const UA = "Mozilla/5.0 (compatible; VegetaTVCache/2.0)";

/** `live:<id>~<catId>~<catTok>~<tok>` (an enriched ref, identical for every account of a panel) or a bare `live:<id>`. */
export function parseLiveRef(ref) {
  const s = String(ref || "");
  if (!s.startsWith("live:")) return null;
  const segs = s.slice(5).split("~");
  if (!/^\d+$/.test(segs[0])) return null;
  if (segs.length >= 4 && /^\d+$/.test(segs[1])) return { id: segs[0], catId: segs[1], catTok: segs[2], tok: segs[3], bare: false };
  return { id: segs[0], catId: "", catTok: "", tok: "", bare: true };
}

export const liveRef = (id, catId, catTok, tok) => (/^\d+$/.test(String(catId || "")) ? `live:${id}~${catId}~${catTok || ""}~${tok || ""}` : `live:${id}`);

const hostnameOf = (srv) => { try { return new URL(srv.url).hostname; } catch (_) { return ""; } };

const REFUSAL_IN_MESSAGE = /\b(401|403|406|407|429|509)\b|HTTP_PROXY_AUTH/i;

/**
 * One playlist probe's verdict. Good: `ok` (a real playlist) or `accepted` (the panel redirects to its edge, which the
 * plugin cannot follow: plain http to an IP). Bad: `refused`, `dead` (a 200 that is no playlist), `missing`, `blocked`.
 * Inconclusive: `unreachable`, `limited`. Kino turns a 407 into a thrown `network` error whose message names it.
 */
export function classifyProbe(res, err) {
  if (err) {
    if (err.code === "host_not_allowed") return "blocked";
    if (err.code === "rate_limited") return "limited";
    return REFUSAL_IN_MESSAGE.test(String(err.message || "")) ? "refused" : "unreachable";
  }
  const st = Number(res && res.status) || 0;
  if (st >= 300 && st < 400) return res.headers && res.headers.location ? "accepted" : "dead";
  if (st >= 200 && st < 300) {
    let body = "";
    try { body = String(res.text() || ""); } catch (_) { body = ""; }
    return /^\s*#EXTM3U/.test(body) && /#EXTINF|#EXT-X-STREAM-INF/.test(body) ? "ok" : "dead";
  }
  if (st === 404 || st === 400 || st === 410) return "missing";
  return "refused";
}

export const isGood = (v) => v === "ok" || v === "accepted";
export const isBad = (v) => v === "refused" || v === "dead" || v === "missing" || v === "blocked";

/**
 * deps: servers() -> { list, idx } (cached, no walk); cachedCats(srv) -> [{ category_id, category_name }] | null (no
 * request, any age); catsAt(srv) -> when those were fetched (ms) | null; storeCats(srv, data) keeps a refresh as that
 * server's categories; callServer(srv, action, extra, { timeoutMs }); playUrl(srv, id, format?); label(srv); host(srv);
 * online() -> Set of urls | null; flag(srv); priority(srv); seed(); now(); unavailable() / notFound() -> Error.
 * Optional: cachedList(srv, catId) -> the raw `get_live_streams` list of that account and category the plugin fetched in
 * the last minutes, or null (no request); keepList(srv, catId, data) keeps one this module fetched there.
 */
export function createLiveFailover(deps) {
  const now = () => deps.now();
  const plays = new Map();      // "<panel>|<id>" -> { count, moved: { k, id, a, at }, tried, triedPanels, spent, bad }
  let lastLive = null;          // { key, at } of the last live resolve: a chain is consecutive resolves of one channel
  const refused = new Map();    // server key -> ts: a probe blamed the account (refused, dead), for every channel
  const preferred = new Map();  // panel -> { k, ts }: the last account that passed a probe there
  const verified = new Map();   // "<server key>|<panel>" -> ts: the account lists the channel under the same id and name
  const nameHits = new Map();   // channel key -> { k, id, catId, catName, ts }
  const negName = new Map();    // "<server key>|<catTok>|<tok>" -> ts: no name match there
  const lists = new Map();      // "<server key>|<catId>" -> { ts, list }
  const catsMemo = new Map();   // server key -> { ts, cats }
  const refreshed = new Map();  // server key -> ts of the last categories refresh (answered or not)

  const fresh = (ts, ms) => typeof ts === "number" && now() - ts < ms;
  const trim = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  const isRefused = (k) => fresh(refused.get(k), REFUSED_MS);
  // An account this one channel kept dying on with no probe blaming the account: skipped for this channel only.
  const isBadFor = (st, k) => fresh(st.bad.get(k), REFUSED_MS);
  const isLabel = (p) => !!p && !/^[kc]:/.test(p);

  function rankWith(active) {
    const online = deps.online();
    const aflag = deps.flag(active);
    const seed = String(deps.seed());
    const tie = (s) => { let h = 0x811c9dc5; const t = seed + keyOf(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
    return (a, b) => {
      const oa = online ? (online.has(a.url) ? 0 : 1) : 0;
      const ob = online ? (online.has(b.url) ? 0 : 1) : 0;
      if (oa !== ob) return oa - ob;
      const fa = deps.flag(a) === aflag ? 0 : 1;
      const fb = deps.flag(b) === aflag ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return deps.priority(a) - deps.priority(b) || tie(a) - tie(b);
    };
  }

  // ---- budget ----
  const room = (ctx, needMs) => ctx.left > 0 && ctx.st.spent.length < MAX_PER_CHANNEL && ctx.until - now() >= needMs;
  function spend(ctx) {
    ctx.left--;
    ctx.st.spent.push(now());
  }

  // The playlist probe. Its network read is bounded by timeoutMs alone: both plugins seal a secret (feedKey), and then Kino
  // reads the whole body (up to its 5 MB cap) before applying maxBytes (DefaultPluginHost.secretSafeCut), so maxBytes only
  // trims the text handed to the plugin. A panel that streams a 200 body holds the account until the timeout: unreachable.
  async function probe(ctx, srv, id) {
    if (!room(ctx, 1500)) return "skipped";
    spend(ctx);
    const k = keyOf(srv);
    let v;
    try {
      const res = await kino.fetch(deps.playUrl(srv, id, "m3u8"), {
        redirect: "manual", cookies: false, maxBytes: 2048, timeoutMs: Math.max(1000, Math.min(4000, ctx.until - now() - 500)),
        headers: { "User-Agent": UA, "Accept": "*/*" },
      });
      v = classifyProbe(res, null);
    } catch (e) {
      v = classifyProbe(null, e);
      if (v === "blocked" && e && e.host && e.host !== hostnameOf(srv)) v = "unreachable"; // another host refused, not this one
    }
    if (v === "blocked") noteBlocked(srv);
    if (v === "refused" || v === "dead") refused.set(k, now());
    if (v === "limited") ctx.left = 0;
    ctx.probes.push(v);
    return v;
  }

  async function call(ctx, srv, action, extra) {
    if (!room(ctx, 2500)) return null;
    spend(ctx);
    try {
      return await deps.callServer(srv, action, extra || {}, { timeoutMs: Math.max(1000, Math.min(5000, ctx.until - now() - 1500)) });
    } catch (e) {
      if (e && e.code === "rate_limited") ctx.left = 0;
      return null;
    }
  }

  async function listOf(ctx, srv, catId) {
    const key = keyOf(srv) + "|" + catId;
    const m = lists.get(key);
    if (m && fresh(m.ts, LIST_MS)) return m.list;
    let data = typeof deps.cachedList === "function" ? deps.cachedList(srv, catId) : null;
    if (!Array.isArray(data)) {
      data = await call(ctx, srv, "get_live_streams", { category_id: String(catId) });
      if (Array.isArray(data) && typeof deps.keepList === "function") deps.keepList(srv, catId, data);
    }
    if (!Array.isArray(data)) return null;
    const list = data.map((s) => ({ stream_id: String((s && s.stream_id) || ""), name: String((s && s.name) || "") }));
    lists.delete(key);
    lists.set(key, { ts: now(), list });
    trim(lists, 8);
    return list;
  }

  const catsFrom = (data) => data.map((c) => ({ category_id: String((c && c.category_id) || ""), category_name: String((c && c.category_name) || "") }));
  function memoCats(k, cats) {
    catsMemo.delete(k);
    catsMemo.set(k, { ts: now(), cats });
    trim(catsMemo, 4);
  }

  async function catsOf(ctx, srv) {
    const k = keyOf(srv);
    const m = catsMemo.get(k);
    if (m && fresh(m.ts, NAME_MS)) return m.cats;
    let cats = deps.cachedCats(srv);
    if (!cats) {
      const data = await call(ctx, srv, "get_live_categories", {});
      if (!Array.isArray(data)) return null;
      cats = catsFrom(data);
    }
    memoCats(k, cats);
    return cats;
  }

  // [srv]'s categories asked again when its cached ones are older than 10 min (1 request, at most once per 10 min per
  // server), kept as its cache. null: fresh already, tried lately, or no answer.
  async function refreshCats(ctx, srv) {
    const k = keyOf(srv);
    const at = deps.catsAt(srv);
    if (typeof at === "number" && now() - at < CATS_FRESH_MS) return null;
    if (fresh(refreshed.get(k), CATS_FRESH_MS)) return null;
    if (!room(ctx, 2500)) return null;
    refreshed.set(k, now());
    trim(refreshed, 16);
    const data = await call(ctx, srv, "get_live_categories", {});
    if (!Array.isArray(data) || !data.length) return null;
    deps.storeCats(srv, data);
    const cats = catsFrom(data);
    memoCats(k, cats);
    return cats;
  }

  // The same channel by name on [srv]: its category matched by name (same concrete country), then the channel by name in
  // that one category. 0-2 requests. Remembers a miss for 30 min.
  async function byName(ctx, srv, r) {
    if (!r.tok || !r.catTok) return null;
    const neg = keyOf(srv) + "|" + r.catTok + "|" + r.tok;
    if (fresh(negName.get(neg), NAME_MS)) return null;
    const cats = await catsOf(ctx, srv);
    if (!cats) return null;
    const c = matchCategory(r.catTok, cats);
    const list = c ? await listOf(ctx, srv, c.id) : null;
    if (c && !list) return null; // not answered: not a miss
    const m = c ? matchChannel(r.tok, list) : { why: "none" };
    if (!m.id) {
      negName.set(neg, now());
      trim(negName, 32);
      return null;
    }
    return { id: m.id, catId: c.id, catName: c.name };
  }

  // Same id and same name in the same category on [srv]: it is an account of the channel's panel, and it carries the
  // channel. Checked once a day per account and panel. null: not checked (no budget left, no answer).
  async function verify(ctx, srv, r, P) {
    const vk = keyOf(srv) + "|" + P;
    if (fresh(verified.get(vk), VERIFIED_MS)) return true;
    const list = await listOf(ctx, srv, r.catId);
    if (!list) return null;
    const entry = list.find((s) => s.stream_id === r.id);
    if (!entry || (r.tok && !matchChannel(r.tok, [entry]).id)) return false;
    verified.set(vk, now());
    trim(verified, 64);
    return true;
  }

  // Whether [cats] list the ref's category: its id, under the same name when the ref carries one ("_": the listing knew no
  // name, so the id alone says it).
  const named = (r) => !!r.catTok && r.catTok !== "_";
  function listsCategory(cats, r) {
    const c = cats && cats.find((x) => String(x.category_id) === r.catId);
    return !!c && (!named(r) || sameCategory(r.catTok, c.category_name));
  }

  // Where the stream id lives: the active server when its categories list the ref's category (or are unknown, as before),
  // else a usable server whose cached categories do. Otherwise { foreign } (resolve looks for the same channel by name on the
  // active server), `sure` only on evidence that the id is another panel's: an account of ANOTHER panel the plugin cannot use
  // lists that category under that id and name. Before deciding, stale categories of the active server (over 10 min) are
  // asked again once, so a category added since is not taken for another panel's. [map]: the panel map (null: none).
  async function originOf(ctx, r, active, list, map) {
    const own = deps.cachedCats(active);
    if (!own || listsCategory(own, r)) return { srv: active };
    const ap = panelOf(keyOf(active), map);
    let sure = false;
    if (named(r)) {
      for (const s of list) {
        if (s === active || !listsCategory(deps.cachedCats(s), r)) continue;
        if (usable(s, now())) return { srv: s };
        const sp = panelOf(keyOf(s), map);
        if (sp && ap && sp === ap) return { srv: active };
        if (sp && ap) sure = true;
      }
    }
    if (listsCategory(await refreshCats(ctx, active), r)) return { srv: active };
    return { foreign: true, sure };
  }

  function chainState(pkey, t0) {
    const prev = lastLive;
    lastLive = { key: pkey, at: t0 };
    let st = plays.get(pkey);
    if (st) plays.delete(pkey);
    else {
      st = { count: 0, moved: null, tried: new Set(), triedPanels: new Set(), spent: [], bad: new Map() };
      try {
        const o = JSON.parse(kino.storage.get(STICKY_KEY) || "null");
        if (o && o.p === pkey && fresh(o.at, STICKY_MS)) st.moved = { k: o.k, id: o.id, a: o.a, at: o.at };
      } catch (_) { /* no sticky */ }
    }
    plays.set(pkey, st);
    trim(plays, 64);
    const chained = !!prev && prev.key === pkey && t0 - prev.at <= CHAIN_GAP_MS;
    st.count = chained ? st.count + 1 : 1;
    if (!chained) { st.tried.clear(); st.triedPanels.clear(); }
    st.spent = st.spent.filter((ts) => t0 - ts < STICKY_MS);
    return st;
  }

  function startAccount(st, P, origin, active, byKey, map, rank, r) {
    const ok = (s) => !!s && usable(s, now()) && !isRefused(keyOf(s)) && !isBadFor(st, keyOf(s));
    const ak = keyOf(active);
    const inP = (s) => { const k = keyOf(s); return P === "k:" + k || (isLabel(P) && panelOf(k, map) === P); };
    if (ok(active) && (origin === active || inP(active))) return { srv: active, id: r.id };
    if (ok(origin)) return { srv: origin, id: r.id };
    const pref = preferred.get(P);
    if (pref && fresh(pref.ts, REFUSED_MS) && ok(byKey.get(pref.k))) return { srv: byKey.get(pref.k), id: r.id };
    if (isLabel(P)) {
      const sure = membersOf(P, map, now(), VERIFIED_MS).filter((k) => k !== ak && fresh(verified.get(k + "|" + P), VERIFIED_MS))
        .map((k) => byKey.get(k)).filter(ok).sort(rank);
      if (sure.length) return { srv: sure[0], id: r.id };
    }
    return null;
  }

  // Step A: the same id on up to 2 other accounts of the same panel, verified and probed in parallel. Step B (only when
  // A had no candidate): the channel by name on ONE other panel. One network step per resolve. [blamed]: a probe blamed the
  // account this play leaves (refused, dead): only then does the account that passes become the panel's start for others.
  async function failover(ctx, st, P, r, active, byKey, map, rank, pkey, blamed) {
    if (isLabel(P)) {
      const cands = membersOf(P, map, now(), VERIFIED_MS).map((k) => byKey.get(k))
        .filter((s) => s && !st.tried.has(keyOf(s)) && usable(s, now()) && !isRefused(keyOf(s)) && !isBadFor(st, keyOf(s))).sort(rank).slice(0, 2);
      if (cands.length) {
        const results = await Promise.all(cands.map(async (s) => {
          const ok = await verify(ctx, s, r, P);
          return ok ? probe(ctx, s, r.id) : ok === null ? "skipped" : "unverified";
        }));
        for (let i = 0; i < cands.length; i++) {
          if (results[i] !== "skipped") st.tried.add(keyOf(cands[i]));
          if (isGood(results[i])) {
            if (blamed) preferred.set(P, { k: keyOf(cands[i]), ts: now() });
            return { srv: cands[i], id: r.id };
          }
        }
        return null;
      }
    }
    if (!r.tok || !r.catTok) return null;
    const hit = nameHits.get(pkey);
    const foreign = (s) => {
      const k = keyOf(s);
      if (st.tried.has(k) || !usable(s, now()) || isRefused(k) || isBadFor(st, k) || P === "k:" + k) return false;
      const pl = panelOf(k, map);
      return !(isLabel(P) && pl === P) && !(pl && st.triedPanels.has(pl));
    };
    let target = hit && fresh(hit.ts, NAME_MS) && byKey.get(hit.k) && foreign(byKey.get(hit.k)) ? byKey.get(hit.k) : null;
    if (!target) target = [...byKey.values()].filter(foreign).sort((a, b) => (a === active ? -1 : b === active ? 1 : rank(a, b)))[0];
    if (!target) return null;
    const tk = keyOf(target);
    st.tried.add(tk);
    st.triedPanels.add(panelOf(tk, map) || "k:" + tk);
    const m = hit && hit.k === tk && fresh(hit.ts, NAME_MS) ? hit : await byName(ctx, target, r);
    if (!m) return null;
    const v = await probe(ctx, target, m.id);
    if (!isGood(v)) return null;
    nameHits.set(pkey, { k: tk, id: m.id, catId: m.catId, catName: m.catName, ts: now() });
    trim(nameHits, 64);
    return { srv: target, id: m.id };
  }

  // The live "Servidor" menu: other accounts of the same panel (same id) and a verified name match. No request; at most 8.
  function alternatives(P, played, r, pkey, byKey, map, rank) {
    const out = [];
    const seen = new Set([keyOf(played.srv)]);
    const add = (s, id) => { const k = keyOf(s); if (s && !seen.has(k)) { seen.add(k); out.push({ s, id }); } };
    const online = deps.online();
    if (isLabel(P)) {
      membersOf(P, map, now()).map((k) => byKey.get(k))
        .filter((s) => s && usable(s, now()) && (!online || online.has(s.url))).sort(rank).forEach((s) => add(s, r.id));
    } else if (P.startsWith("k:") && keyOf(played.srv) !== P.slice(2)) add(byKey.get(P.slice(2)), r.id);
    const hit = nameHits.get(pkey);
    if (hit && fresh(hit.ts, NAME_MS) && byKey.get(hit.k) && usable(byKey.get(hit.k), now())) add(byKey.get(hit.k), hit.id);
    const countBy = {};
    for (const e of out) { const b = deps.label(e.s); countBy[b] = (countBy[b] || 0) + 1; }
    if (countBy[deps.label(played.srv)]) countBy[deps.label(played.srv)]++;
    return out.slice(0, 8).map((e) => {
      const b = deps.label(e.s);
      return { label: countBy[b] > 1 && deps.host(e.s) ? `${b} · ${deps.host(e.s)}` : b, ref: `at:${keyOf(e.s)}~l~${e.id}` };
    });
  }

  // [movedFrom]: the active server's key when this play is a failover's switch (kept 10 min, also in storage). The new
  // account starts its own evidence: the next consecutive resolve re-checks it, the one after moves on.
  function answer(st, c, P, r, pkey, byKey, map, rank, movedFrom) {
    if (movedFrom) {
      st.moved = { k: keyOf(c.srv), id: c.id, a: movedFrom, at: now() };
      st.count = 1;
      put(STICKY_KEY, JSON.stringify({ p: pkey, ...st.moved }));
    }
    const out = { url: deps.playUrl(c.srv, c.id) };
    const alts = alternatives(P, c, r, pkey, byKey, map, rank);
    if (alts.length) { out.alternatives = alts; out.label = deps.label(c.srv); }
    return out;
  }

  /** The play answer for a `live:` ref, failing over when there is evidence; throws not_found / unavailable. */
  async function resolve(ref) {
    const t0 = now();
    let r = parseLiveRef(ref);
    if (!r) throw deps.notFound();
    const { list, idx } = await deps.servers();
    if (!Array.isArray(list) || !list.length) throw deps.unavailable();
    const active = list[idx] || list[0];
    const byKey = new Map(list.map((s) => [keyOf(s), s]));
    const map = readPanels();
    const rank = rankWith(active);
    const ctx = { left: MAX_PER_RESOLVE, until: t0 + DEADLINE_MS, probes: [], st: { spent: [] } };

    // A bare ref (saved before 0.4.1): the active server, as always; Kino heals it to a full ref on its next listing.
    if (r.bare) {
      const P = panelOf(keyOf(active), map) || "k:" + keyOf(active);
      const st = chainState(P + "|" + r.id, t0);
      return answer(st, { srv: active, id: r.id }, P, r, P + "|" + r.id, byKey, map, rank, null);
    }

    let where = await originOf(ctx, r, active, list, map);
    if (where.foreign) {
      // The id may belong to a panel this device does not reach now (a favourite from another server): the same channel by
      // name on the person's own server. Not there: not found when the id is known to be another panel's (Kino then reopens
      // the saved channel by its identity), else the id on the active server, as before.
      const fk = "f|" + keyOf(active) + "|" + r.catId + "|" + r.id;
      const hit = nameHits.get(fk);
      const m = hit && fresh(hit.ts, NAME_MS) ? hit : await byName(ctx, active, r);
      if (m) {
        nameHits.set(fk, { ...m, k: keyOf(active), ts: hit && hit.ts ? hit.ts : now() });
        r = { id: m.id, catId: m.catId, catTok: categoryTok(m.catName), tok: r.tok, bare: false };
      } else if (where.sure) throw deps.notFound();
      where = { srv: active };
    }
    const origin = where.srv;
    const ok = keyOf(origin);
    const P = panelOf(ok, map) || "k:" + ok;
    const pkey = P + "|" + r.id;
    const st = chainState(pkey, t0);
    st.spent.push(...ctx.st.spent);
    ctx.st = st;

    // The account a failover moved this channel to (it passed a probe then) keeps it for 10 min, unless a probe or a chain
    // says otherwise or the person picked another server meanwhile.
    const sticky = st.moved && st.moved.a === keyOf(active) && fresh(st.moved.at, STICKY_MS) ? byKey.get(st.moved.k) : null;
    let cur = sticky && usable(sticky, now()) && !isRefused(st.moved.k) && !isBadFor(st, st.moved.k) ? { srv: sticky, id: st.moved.id } : null;
    if (!cur) cur = startAccount(st, P, origin, active, byKey, map, rank, r);
    // Every account known to refuse: re-check the channel's own account rather than giving up blind.
    if (!cur && usable(origin, now()) && !st.tried.has(ok)) cur = { srv: origin, id: r.id, recheck: true };
    const R = st.count;
    let curBad = !cur;
    let blamed = !cur && isRefused(ok); // no start account because the channel's own account refuses everything
    if (cur) {
      if (R === 1 && !cur.recheck) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
      if (R <= 2) {
        // R2 (one repeat: maybe the preheat, maybe the first reopen) or a known-refusing account: re-check only.
        const v = await probe(ctx, cur.srv, cur.id);
        if (!isBad(v)) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
        curBad = true;
        blamed = v === "refused" || v === "dead";
      } else {
        // R3+: this stream keeps dying there (its source, or an edge we cannot see) though nothing blamed the account: only
        // this channel leaves it; the person's other channels and Kino's preheat stay.
        st.bad.set(keyOf(cur.srv), now());
        trim(st.bad, 32);
      }
      st.tried.add(keyOf(cur.srv));
    }
    const next = await failover(ctx, st, P, r, active, byKey, map, rank, pkey, blamed);
    if (next) return answer(st, next, P, r, pkey, byKey, map, rank, keyOf(active));
    if (curBad && ctx.probes.length && ctx.probes.every(isBad)) throw deps.unavailable();
    if (R >= 3) {
      // Every candidate tried: start the walk again from the start account (the chain continues).
      st.tried.clear();
      st.triedPanels.clear();
      const again = startAccount(st, P, origin, active, byKey, map, rank, r);
      if (again) return answer(st, again, P, r, pkey, byKey, map, rank, null);
    }
    if (cur) return answer(st, cur, P, r, pkey, byKey, map, rank, null);
    throw deps.unavailable();
  }

  return { resolve };
}
