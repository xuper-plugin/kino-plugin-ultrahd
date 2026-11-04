// Health check de los servidores del servicio: pide la lista (como el plugin), prueba cada uno con UNA petición ligera y deja en
// kino-plugin.json → "hosts" el servicio de arranque más los servidores que responden (Kino solo permite HTTP con hosts declarados).
// Un host que falla se retira tras FAIL_LIMIT comprobaciones seguidas, para que un fallo pasajero no cambie el manifiesto.
// Si el conjunto cambia, sube la versión de parche. No imprime usuario ni contraseña.   node scripts/health-hosts.mjs [--dry]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "kino-plugin.json");
const STATE = join(root, "hosts-state.json");
const BOOTSTRAP = "http://vegetatvv2.duckdns.org/bootstrap.php";
const CORE = "vegetatvv2.duckdns.org";
const UA = "Mozilla/5.0 (compatible; VegetaTVCache/2.0)";
const FAIL_LIMIT = 3;
const MIN_GOOD = 3; // con menos, algo anda mal con el servicio o con esta ejecución: no se toca nada
const MAX_HOSTS = 50; // el manifiesto tiene un tope de 16 KB
const dry = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vegeta = (code) => ({ "X-Vegeta-Version-Code": String(code), "X-Vegeta-Servers-Direct": "1", "Cache-Control": "no-cache", "User-Agent": UA });

function parseLine(t) {
  try {
    const u = new URL(t);
    if (!/player_api\.php$|get\.php$/i.test(u.pathname)) return null;
    const username = u.searchParams.get("username") || u.searchParams.get("user") || "";
    if (!username) return null;
    return { base: `${u.protocol}//${u.host}`, host: u.hostname, username, password: u.searchParams.get("password") || u.searchParams.get("pass") || "" };
  } catch (_) { return null; }
}

async function getList() {
  let code = 21;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${BOOTSTRAP}?v=${Date.now()}`, { headers: { ...vegeta(code), Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    let data = null;
    try { data = await r.json(); } catch (_) { /* sin cuerpo */ }
    const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
    if (!r.ok || !data || data.ok === false) { if (attempt === 0 && want > code) { code = want; continue; } throw new Error("bootstrap " + r.status); }
    let text = typeof data.servers_text === "string" ? data.servers_text : "";
    if (!text.trim() && typeof data.servers_url === "string") text = await (await fetch(data.servers_url, { headers: vegeta(code), signal: AbortSignal.timeout(30000) })).text();
    const list = text.split(/\r?\n/).map((l) => parseLine(l.trim())).filter(Boolean);
    if (!list.length) { if (attempt === 0 && want > code) { code = want; continue; } throw new Error("bootstrap sin servidores"); }
    return list;
  }
  throw new Error("bootstrap sin servidores");
}

async function probe(s) {
  try {
    const p = new URLSearchParams({ username: s.username, password: s.password, action: "get_vod_categories" });
    const r = await fetch(`${s.base}/player_api.php?${p}`, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    return r.ok && Array.isArray(j) && j.length > 0;
  } catch (_) { return false; }
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { fails: {} };
const hostName = (h) => (typeof h === "string" ? h : h.host);
const declared = new Set(manifest.hosts.map(hostName));

const list = await getList();
const byHost = new Map();
for (const s of list) if (!byHost.has(s.host) && !/^[\d.]+(:\d+)?$/.test(s.host)) byHost.set(s.host, s); // un servidor por host; Kino no admite IPs en hosts
console.log(`${list.length} servidores en la lista, ${byHost.size} hosts distintos`);

const good = new Set();
for (const [host, s] of byHost) {
  const ok = await probe(s);
  if (ok) { good.add(host); state.fails[host] = 0; } else state.fails[host] = (state.fails[host] || 0) + 1;
  console.log(`${ok ? "ok   " : "falla"} ${host}`);
  await sleep(1500); // una petición cada 1,5 s: sin presionar a los servidores
}
if (good.size < MIN_GOOD) { console.log(`solo ${good.size} responden (mínimo ${MIN_GOOD}): no se cambia el manifiesto`); process.exit(0); }

const next = new Set([CORE]);
for (const h of good) next.add(h);
for (const h of declared) { // un host declarado que falló sigue hasta FAIL_LIMIT fallos seguidos, si el servicio aún lo lista
  if (h !== CORE && !good.has(h) && byHost.has(h) && (state.fails[h] || 0) < FAIL_LIMIT) next.add(h);
}
for (const h of Object.keys(state.fails)) if (!byHost.has(h)) delete state.fails[h];

const sorted = [...next].filter((h) => h !== CORE).sort().slice(0, MAX_HOSTS - 1);
// HTTPS no necesita insecureHttp; el resto sí (Kino lo compara exacto, sin comodines).
const httpsHost = (h) => byHost.get(h) && byHost.get(h).base.startsWith("https://");
const hosts = [{ host: CORE, insecureHttp: true }, ...sorted.map((h) => (httpsHost(h) ? { host: h } : { host: h, insecureHttp: true }))];

const before = JSON.stringify([...declared].sort());
const after = JSON.stringify([...next].sort());
writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
if (before === after) { console.log("sin cambios en los hosts"); process.exit(0); }

console.log(`hosts: ${declared.size} → ${next.size}`);
if (dry) { console.log("--dry: no se escribe el manifiesto"); process.exit(0); }
manifest.hosts = hosts;
const [a, b, c] = manifest.version.split(".").map(Number);
manifest.version = `${a}.${b}.${c + 1}`;
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = manifest.version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("versión nueva:", manifest.version);
