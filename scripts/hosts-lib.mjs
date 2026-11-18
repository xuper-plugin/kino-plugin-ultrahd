// The pure part of the "Servidores sanos" job (scripts/health-hosts.mjs): which hosts kino-plugin.json declares, from the
// service's list and this run's probes. Never touches the version: the author signature covers the plugin id, the version
// and plugin.js, not `hosts`, so new installs get the new list at once and installed copies get it with the next signed
// release. That release asks every person to approve each host it adds (Kino holds an update with new hosts), so the job
// adds as few as it can: only a host that answered and that the plugin uses.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.

export const CORE = "vegetatvv2.duckdns.org";
export const MIN_GOOD = 3;     // fewer answers: something is wrong with the service or with this run; change nothing
export const MAX_HOSTS = 50;   // the manifest has a 16 KB cap
export const MAX_SERVERS = 30; // the plugin keeps the first 30 accounts of the list (catalog.js MAX_SERVERS)
export const UNLISTED_LIMIT = 3; // a declared host the service stopped listing goes after this many runs in a row
const STATE_V = 3;

const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(":");

/**
 * The service's servers in the plugin's own order: https first (stable), then the service's order; one entry per host
 * with up to 3 of its accounts. `window`: one of its accounts is among the MAX_SERVERS the plugin keeps (accounts are
 * told apart by address and user, as catalog.js does; an IP takes a place there too). Kino does not accept an IP as a
 * declared host.
 */
export function hostsInPluginOrder(list) {
  const sorted = [...list].map((s, i) => ({ s, i })).sort((a, b) => (b.s.https ? 1 : 0) - (a.s.https ? 1 : 0) || a.i - b.i).map((x) => x.s);
  const byHost = new Map();
  const seen = new Set();
  for (const s of sorted) {
    const account = (s.base || s.host) + "|" + s.username;
    const kept = !seen.has(account) && seen.size < MAX_SERVERS;
    seen.add(account);
    if (!s.host || isIp(s.host)) continue;
    const e = byHost.get(s.host) || { host: s.host, https: s.https, window: false, accounts: [] };
    if (kept) e.window = true;
    if (e.accounts.length < 3 && !e.accounts.some((a) => a.username === s.username && a.password === s.password)) e.accounts.push(s);
    byHost.set(s.host, e);
  }
  return [...byHost.values()];
}

const hostName = (h) => (typeof h === "string" ? h : h.host);
const entryOf = (host, https) => (https ? { host } : { host, insecureHttp: true });

/**
 * [hosts]: hostsInPluginOrder(list) (an entry without `window`, from an older saved run, counts by its place in the list).
 * [good]: Set of hosts where any account answered. [state]: hosts-state.json (or null). [declared]: the manifest's current
 * `hosts`. Returns { hosts, state, changed, skipped, lines }.
 *
 * A declared host stays while the service lists it (a US runner cannot judge what answers from Latin America); one the
 * service stopped listing stays for UNLISTED_LIMIT runs. A new host (or a declared https one now listed over plain http)
 * goes in only when it answered in this run and the plugin uses it (inside its MAX_SERVERS accounts), after the declared
 * ones, and only while there is room under MAX_HOSTS: the cap never cuts a declared host. The state holds the unlisted
 * counts only, so a run with the same answers changes no file.
 */
export function nextHosts({ hosts, good, state, declared }) {
  const prevUnlisted = (state && (state.v === STATE_V || state.v === 2) && state.unlisted) || {};
  const next = { v: STATE_V, unlisted: {} };
  const inWindow = (h, i) => (typeof h.window === "boolean" ? h.window : i < MAX_SERVERS);
  const listed = new Map(hosts.map((h, i) => [h.host, { https: !!h.https, win: inWindow(h, i) }]));
  const lines = hosts.map((h, i) => `${good.has(h.host) ? "ok  " : "fail"} ${h.host}${inWindow(h, i) ? "" : " (beyond the plugin's servers)"}`);
  if (good.size < MIN_GOOD) {
    lines.push(`only ${good.size} answered (minimum ${MIN_GOOD}): nothing changes`);
    return { hosts: declared, state: state || next, changed: false, skipped: true, lines };
  }
  const out = [];
  const has = new Set();
  const push = (e) => { if (!has.has(e.host)) { has.add(e.host); out.push(e); } };
  if (!declared.some((d) => hostName(d) === CORE)) push({ host: CORE, insecureHttp: true });
  for (const d of declared) {
    const name = hostName(d);
    const e = typeof d === "string" ? { host: d, insecureHttp: true } : d;
    const l = listed.get(name);
    if (name === CORE || (l && (l.https || e.insecureHttp))) { push(e); continue; }
    if (l) {
      // Declared for https, listed now over plain http: insecure only once it answered inside the window (approval again).
      if (good.has(name) && l.win) { push({ ...e, insecureHttp: true }); lines.push(`now plain http ${name}: declared insecure`); } else push(e);
      continue;
    }
    const n = (Number(prevUnlisted[name]) || 0) + 1;
    if (n < UNLISTED_LIMIT) { next.unlisted[name] = n; push(e); lines.push(`unlisted ${name} (${n} in a row): kept`); } else lines.push(`unlisted ${name} (${n} in a row): dropped`);
  }
  for (const [name, l] of listed) {
    if (has.has(name)) continue;
    if (!good.has(name)) lines.push(`not added ${name}: no answer`);
    else if (!l.win) lines.push(`not added ${name}: beyond the plugin's ${MAX_SERVERS} servers`);
    else if (out.length >= MAX_HOSTS) lines.push(`not added ${name}: the manifest holds ${MAX_HOSTS} hosts`);
    else { push(entryOf(name, l.https)); lines.push(`added ${name}`); }
  }
  const changed = JSON.stringify(out) !== JSON.stringify(declared);
  return { hosts: out, state: next, changed, skipped: false, lines };
}

/** Whether an Xtream account answer (player_api.php with no action) says the account can play. */
export const accountOk = (json) => !!json && typeof json === "object" && !!json.user_info && String(json.user_info.auth) === "1";
