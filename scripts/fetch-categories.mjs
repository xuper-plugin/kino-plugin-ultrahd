// Pide las categorías reales (VOD, series y en vivo) a todos los servidores HTTPS que respondan, con el kit del SDK.
// node scripts/fetch-categories.mjs [salida.json]   -> { servers: n, vod: [...], series: [...], live: [[name, serverIndex]...] }
// Solo escribe nombres e ids de categoría: nunca usuario ni contraseña.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = (f) => pathToFileURL(join(root, "sdk", f)).href;
const { createKino } = await import(sdk("kino-shim.mjs"));
const { validateManifest } = await import(sdk("contract.mjs"));

const checked = validateManifest(readFileSync(join(root, "kino-plugin.json"), "utf8"));
if (!checked.ok) throw new Error("manifest inválido: " + JSON.stringify(checked));
const tmp = mkdtempSync(join(tmpdir(), "uhd-cats-"));
const { kino, resetBudget } = createKino(checked.manifest, {
  storageFile: join(tmp, "s.json"), cookiesFile: join(tmp, "c.json"), secretsFile: join(tmp, "x.json"), config: {}, env: process.env,
});

const BOOTSTRAP = "http://vegetatvv2.duckdns.org/bootstrap.php";
const headers = (code) => ({ "X-Vegeta-Version-Code": String(code), "X-Vegeta-Servers-Direct": "1", "Cache-Control": "no-cache, no-store", Pragma: "no-cache" });

async function serverList() {
  let code = 21;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await kino.fetch(`${BOOTSTRAP}?v=${Date.now()}`, { headers: { ...headers(code), Accept: "application/json" } });
    let data = null;
    try { data = r.json(); } catch (_) { data = null; }
    if (!r.ok || !data || data.ok === false) {
      const want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
      if (attempt === 0 && want > code) { code = want; continue; }
      throw new Error("bootstrap " + r.status);
    }
    const r2 = await kino.fetch(data.servers_url, { headers: { ...headers(code), Accept: "text/plain" } });
    const out = [];
    for (const line of r2.text().split(/\r?\n/)) {
      const url = line.trim().split(/\s/)[0];
      if (!url.startsWith("https://")) continue;
      try {
        const u = new URL(url);
        const username = u.searchParams.get("username") || "";
        if (username) out.push({ base: u.protocol + "//" + u.host, username, password: u.searchParams.get("password") || "" });
      } catch (_) { /* línea rara */ }
    }
    return out;
  }
  return [];
}

async function categories(srv, action) {
  resetBudget();
  const q = new URLSearchParams({ username: srv.username, password: srv.password, action });
  const r = await kino.fetch(`${srv.base}/player_api.php?${q}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = r.json();
  if (!Array.isArray(data) || !data.length) throw new Error("vacío");
  return data.map((c) => ({ id: String(c.category_id), name: String(c.category_name || "").trim() }));
}

const servers = await serverList();
const out = { servers: 0, vod: {}, series: {}, live: {} };
for (const srv of servers.slice(0, 12)) {
  try {
    const [vod, series, live] = [await categories(srv, "get_vod_categories"), await categories(srv, "get_series_categories"), await categories(srv, "get_live_categories")];
    out.servers++;
    vod.forEach((c, i) => { out.vod[c.id] ||= { name: c.name, i }; });
    series.forEach((c, i) => { out.series[c.id] ||= { name: c.name, i }; });
    live.forEach((c, i) => { out.live[c.name] ||= { i, servers: 0 }; out.live[c.name].servers++; });
  } catch (_) { /* este servidor no responde: se ignora */ }
}
console.error(`servidores HTTPS que respondieron: ${out.servers} de ${servers.length}; vod ${Object.keys(out.vod).length}, series ${Object.keys(out.series).length}, live ${Object.keys(out.live).length}`);
const file = process.argv[2];
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
else console.log(JSON.stringify(out));
