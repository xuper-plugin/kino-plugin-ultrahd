// "Servidores sanos": asks the service for its list (as the plugin does), checks up to 3 accounts per host with ONE light
// request each (player_api.php with no action), and writes kino-plugin.json -> "hosts" (the declared hosts the service still
// lists, plus a new one only when it answered and the plugin uses it: see hosts-lib.mjs) and hosts-state.json (the unlisted
// counts), each only when it changes. Never changes the version: the job needs no signing key. Never prints a user or a
// password.
//   node scripts/health-hosts.mjs [--dry] [--probes-out <file>] [--probes-in <file>]
// --probes-out saves this run's hosts and answers (no credentials); --probes-in recomputes from them without the network
// (the workflow uses it after a rebase conflict).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostsInPluginOrder, nextHosts, accountOk } from "./hosts-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "kino-plugin.json");
const STATE = join(root, "hosts-state.json");
const BOOTSTRAP = "http://vegetatvv2.duckdns.org/bootstrap.php";
const UA = "Mozilla/5.0 (compatible; VegetaTVCache/2.0)";
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const dry = argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vegeta = (code) => ({ "X-Vegeta-Version-Code": String(code), "X-Vegeta-Servers-Direct": "1", "Cache-Control": "no-cache", "User-Agent": UA });

function parseLine(t) {
  try {
    const u = new URL(t.split(/\s/)[0]);
    if (!/player_api\.php$|get\.php$/i.test(u.pathname)) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    if (!username) return null;
    return { base: `${u.protocol}//${u.host}`, host: u.hostname, https: u.protocol === "https:", username, password: u.searchParams.get("password") || u.searchParams.get("pass") || "" };
  } catch (_) { return null; }
}

async function getList() {
  let code = 21;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${BOOTSTRAP}?v=${Date.now()}`, { headers: { ...vegeta(code), Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    let data = null;
    try { data = await r.json(); } catch (_) { /* no body */ }
    const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
    if (!r.ok || !data || data.ok === false) { if (attempt === 0 && want > code) { code = want; continue; } throw new Error("bootstrap " + r.status); }
    let text = typeof data.servers_text === "string" ? data.servers_text : "";
    if (!text.trim() && typeof data.servers_url === "string") text = await (await fetch(data.servers_url, { headers: vegeta(code), signal: AbortSignal.timeout(30000) })).text();
    const list = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(parseLine).filter(Boolean);
    if (!list.length) { if (attempt === 0 && want > code) { code = want; continue; } throw new Error("bootstrap: no servers"); }
    return list;
  }
  throw new Error("bootstrap: no servers");
}

async function probe(s) {
  try {
    const p = new URLSearchParams({ username: s.username, password: s.password });
    const r = await fetch(`${s.base}/player_api.php?${p}`, { headers: { Accept: "application/json", "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(12000) });
    return r.ok && accountOk(await r.json());
  } catch (_) { return false; }
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;

let hosts;
const good = new Set();
if (opt("--probes-in")) {
  const saved = JSON.parse(readFileSync(opt("--probes-in"), "utf8"));
  hosts = saved.hosts;
  for (const h of saved.good) good.add(h);
  console.log(`recomputed from ${saved.hosts.length} saved hosts (no network)`);
} else {
  const list = await getList();
  hosts = hostsInPluginOrder(list);
  console.log(`${list.length} servers listed, ${hosts.length} distinct hosts`);
  for (const h of hosts) {
    for (const s of h.accounts) {
      if (await probe(s)) { good.add(h.host); break; }
      await sleep(1500); // one request every 1.5 s: no pressure on the servers
    }
    await sleep(1500);
  }
  hosts = hosts.map(({ host, https, window }) => ({ host, https, window }));
  if (opt("--probes-out")) writeFileSync(opt("--probes-out"), JSON.stringify({ hosts, good: [...good] }));
}

const out = nextHosts({ hosts, good, state, declared: manifest.hosts });
for (const l of out.lines) console.log(l);
if (out.skipped) process.exit(0);
if (dry) { console.log(`--dry: hosts ${manifest.hosts.length} -> ${out.hosts.length}, nothing written`); process.exit(0); }
const stateText = JSON.stringify(out.state, null, 2) + "\n";
if (!existsSync(STATE) || readFileSync(STATE, "utf8") !== stateText) writeFileSync(STATE, stateText);
if (!out.changed) { console.log("hosts unchanged"); process.exit(0); }
console.log(`hosts: ${manifest.hosts.length} -> ${out.hosts.length} (version ${manifest.version} unchanged)`);
manifest.hosts = out.hosts;
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n"); // the same serializer as sdk/seal.mjs
