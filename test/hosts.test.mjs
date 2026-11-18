// The "Servidores sanos" job: it never bumps the version (so it never needs the signing key), keeps its state, never drops
// a host the service still lists, and its workflow rebases before pushing. Plus the local release script's refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hostsLib from "../scripts/hosts-lib.mjs";
import { newer, newHosts, bindingOf, publicKeyOf } from "../scripts/release.mjs";
import { signEntry, verifyEntry } from "../sdk/seal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { hostsInPluginOrder, nextHosts, CORE, MAX_HOSTS, MIN_GOOD } = hostsLib;
const line = (host, https = false, u = "u") => ({ host, https, username: u, password: "p", base: (https ? "https://" : "http://") + host });

test("the plugin's order: https first, then the service's order; no IPs; up to 3 accounts per host", () => {
  const list = [line("b.example"), line("a.example", true), line("1.2.3.4"), line("b.example", false, "u2"), line("b.example", false, "u3"), line("b.example", false, "u4"), line("c.example")];
  const hosts = hostsInPluginOrder(list);
  assert.deepEqual(hosts.map((h) => h.host), ["a.example", "b.example", "c.example"]);
  assert.equal(hosts[1].accounts.length, 3);
});

test("the plugin's window: the hosts of the first 30 accounts it keeps (an IP takes a place there too)", () => {
  const list = [line("1.2.3.4"), ...Array.from({ length: 31 }, (_, i) => line(`s${String(i).padStart(2, "0")}.example`)), line("s00.example", false, "u2")];
  const hosts = hostsInPluginOrder(list);
  assert.equal(hostsLib.MAX_SERVERS, 30);
  assert.deepEqual(hosts.filter((h) => h.window).map((h) => h.host), Array.from({ length: 29 }, (_, i) => `s${String(i).padStart(2, "0")}.example`));
  assert.deepEqual(hosts.filter((h) => !h.window).map((h) => h.host), ["s29.example", "s30.example"]);
});

const H = (host, https = false, window = true) => ({ host, https, window });
const entry = (host, https = false) => (https ? { host } : { host, insecureHttp: true });
const hostsOf = (out) => out.hosts.map((h) => h.host);

test("a new host is declared only when it answered this run and the plugin uses it (inside its 30 accounts)", () => {
  const declared = [entry(CORE), entry("d1.example"), entry("d2.example")];
  const hosts = [H("d1.example"), H("new-ok.example", true), H("new-fail.example"), H("d2.example"), H("far-ok.example", false, false)];
  const good = new Set(["d1.example", "d2.example", "new-ok.example", "far-ok.example"]);
  const out = nextHosts({ hosts, good, state: null, declared });
  assert.deepEqual(hostsOf(out), [CORE, "d1.example", "d2.example", "new-ok.example"]);
  assert.deepEqual(out.hosts[3], { host: "new-ok.example" });
  assert.ok(out.lines.some((l) => /new-fail\.example/.test(l)) && out.lines.some((l) => /far-ok\.example/.test(l)), "each refusal is logged");
});

test("a declared host stays while the service lists it, failing or not; an unlisted one goes after 3 runs", () => {
  const declared = [entry(CORE), entry("old.example"), entry("failing.example"), entry("far.example")];
  const hosts = [H("failing.example"), H("a.example"), H("b.example"), H("c.example"), H("far.example", false, false)];
  const good = new Set(["a.example", "b.example", "c.example"]);
  let out = nextHosts({ hosts, good, state: null, declared });
  assert.deepEqual(hostsOf(out), [CORE, "old.example", "failing.example", "far.example", "a.example", "b.example", "c.example"]);
  assert.equal(out.state.unlisted["old.example"], 1);
  out = nextHosts({ hosts, good, state: out.state, declared: out.hosts });
  assert.ok(hostsOf(out).includes("old.example"));
  out = nextHosts({ hosts, good, state: out.state, declared: out.hosts });
  assert.ok(!hostsOf(out).includes("old.example"), "dropped on the third run without the service listing it");
  assert.ok(hostsOf(out).includes("failing.example") && hostsOf(out).includes("far.example"));
  const same = nextHosts({ hosts, good, state: out.state, declared: out.hosts });
  assert.equal(same.changed, false);
});

test("the cap never cuts a declared host the service still lists; it only holds back new ones", () => {
  const declared = [entry(CORE), ...Array.from({ length: MAX_HOSTS - 1 }, (_, i) => entry(`d${String(i).padStart(2, "0")}.example`))];
  const hosts = [H("new.example"), ...declared.slice(1).reverse().map((d) => H(d.host))];
  const out = nextHosts({ hosts, good: new Set(hosts.map((h) => h.host)), state: null, declared });
  assert.equal(out.hosts.length, MAX_HOSTS);
  assert.deepEqual(hostsOf(out), declared.map((d) => d.host), "every declared host kept, in its order; the new one waits");
  assert.equal(out.changed, false);
  assert.ok(out.lines.some((l) => /new\.example/.test(l)));
});

test("a declared https host the service now lists over http turns insecure only once it answers inside the window", () => {
  const declared = [entry(CORE), entry("s.example", true)];
  const hosts = [H("s.example"), H("x.example"), H("y.example"), H("z.example")];
  const quiet = nextHosts({ hosts, good: new Set(["x.example", "y.example", "z.example"]), state: null, declared: [...declared] });
  assert.deepEqual(quiet.hosts[1], { host: "s.example" });
  const out = nextHosts({ hosts, good: new Set(["s.example", "x.example", "y.example"]), state: null, declared: [...declared] });
  assert.deepEqual(out.hosts[1], { host: "s.example", insecureHttp: true });
});

test("a broken run (fewer than MIN_GOOD answers) changes nothing", () => {
  const hosts = [H("a.example")];
  const declared = [entry(CORE)];
  const out = nextHosts({ hosts, good: new Set(), state: null, declared });
  assert.equal(out.skipped, true);
  assert.equal(out.hosts, declared);
  assert.ok(MIN_GOOD >= 1);
});

test("two runs with the same answers keep the same state: the job has nothing to commit", () => {
  const declared = [entry(CORE), entry("a.example"), entry("gone.example")];
  const hosts = [H("a.example"), H("b.example"), H("c.example"), H("dead.example")];
  const good = new Set(["a.example", "b.example", "c.example"]);
  const day1 = nextHosts({ hosts, good, state: null, declared });
  const day2 = nextHosts({ hosts, good, state: day1.state, declared: day1.hosts });
  assert.equal(day2.changed, false);
  assert.ok(day2.state.unlisted["gone.example"] === 2, "the unlisted count is the only state that moves");
  const day3 = nextHosts({ hosts, good, state: day2.state, declared: day2.hosts });
  const day4 = nextHosts({ hosts, good, state: day3.state, declared: day3.hosts });
  assert.deepEqual(day4.state, day3.state, "failing hosts move no counter");
  // A state file from the previous format keeps its unlisted counts.
  const old = nextHosts({ hosts, good, state: { v: 2, probe: "player_api", fails: { "dead.example": 9 }, unlisted: { "gone.example": 1 } }, declared });
  assert.equal(old.state.unlisted["gone.example"], 2);
  assert.equal(old.state.fails, undefined);
});

function jobDir() {
  const dir = mkdtempSync(join(tmpdir(), "stv-hosts-"));
  mkdirSync(join(dir, "scripts"));
  for (const f of ["health-hosts.mjs", "hosts-lib.mjs"]) cpSync(join(root, "scripts", f), join(dir, "scripts", f));
  const manifest = JSON.parse(readFileSync(join(root, "kino-plugin.json"), "utf8"));
  writeFileSync(join(dir, "kino-plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir, manifest };
}
const job = (dir, file) => execFileSync("node", ["scripts/health-hosts.mjs", "--probes-in", file], { cwd: dir, encoding: "utf8" });

test("the job script rewrites hosts and state but never the version (run offline from saved answers)", () => {
  const { dir, manifest } = jobDir();
  try {
    const probes = { hosts: [{ host: "new.example", https: true, window: true }, ...manifest.hosts.slice(1).map((h) => ({ host: h.host, https: !h.insecureHttp, window: true }))], good: ["new.example", ...manifest.hosts.slice(1, 6).map((h) => h.host)] };
    writeFileSync(join(dir, "probes.json"), JSON.stringify(probes));
    job(dir, "probes.json");
    const after = JSON.parse(readFileSync(join(dir, "kino-plugin.json"), "utf8"));
    assert.equal(after.version, manifest.version);
    assert.deepEqual(after.signature, manifest.signature);
    assert.deepEqual(after.hosts.slice(0, manifest.hosts.length), manifest.hosts, "the declared hosts keep their order");
    assert.deepEqual(after.hosts[manifest.hosts.length], { host: "new.example" });
    const state = JSON.parse(readFileSync(join(dir, "hosts-state.json"), "utf8"));
    assert.equal(state.v, 3);
    const src = readFileSync(join(root, "scripts", "health-hosts.mjs"), "utf8");
    assert.ok(!/\.version\s*=/.test(src) && !/package\.json/.test(src));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run with the same answers as the last one leaves both files as they were (no daily commit)", () => {
  const { dir, manifest } = jobDir();
  try {
    const probes = { hosts: manifest.hosts.slice(1).map((h) => ({ host: h.host, https: !h.insecureHttp, window: true })), good: manifest.hosts.slice(1, 4).map((h) => h.host) };
    writeFileSync(join(dir, "probes.json"), JSON.stringify(probes));
    job(dir, "probes.json");
    const read = () => [readFileSync(join(dir, "kino-plugin.json"), "utf8"), readFileSync(join(dir, "hosts-state.json"), "utf8")];
    const day1 = read();
    job(dir, "probes.json");
    assert.deepEqual(read(), day1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the workflow runs by hand only, rebases before pushing, publishes the state file, and never touches the version", () => {
  const yml = readFileSync(join(root, ".github", "workflows", "hosts.yml"), "utf8");
  assert.doesNotMatch(yml, /^\s*schedule:/m, "no schedule until the release that carries the job is out (README)");
  assert.match(yml, /^\s*workflow_dispatch:/m);
  assert.match(yml, /git pull --rebase origin main/);
  assert.match(yml, /git add kino-plugin\.json hosts-state\.json/);
  assert.match(yml, /git status --porcelain -- kino-plugin\.json hosts-state\.json/);
  assert.match(yml, /--probes-in/);
  assert.doesNotMatch(yml, /package\.json|seal\.mjs|--sign|AUTHOR_KEY/);
});

// ---- release.mjs ----

const pem = () => generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });

test("release helpers", () => {
  assert.ok(newer("0.4.2", "0.4.1") && newer("0.10.0", "0.9.9") && !newer("0.4.1", "0.4.1") && !newer("0.4.0", "0.4.1"));
  assert.deepEqual(newHosts([{ host: "a" }, { host: "b" }], [{ host: "a" }]), ["b"]);
  assert.equal(bindingOf({ homepage: "https://github.com/xuper-plugin/kino-plugin-supertv" }), "xuper-plugin/kino-plugin-supertv");
  const k = pem();
  assert.equal(publicKeyOf(k), signEntry(Buffer.from("x"), "o/r", "super-tv", "1.0.0", k).authorKey);
});

function releaseRepo({ hostsAfter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stv-release-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src"));
  cpSync(join(root, "scripts", "release.mjs"), join(dir, "scripts", "release.mjs"));
  cpSync(join(root, "sdk"), join(dir, "sdk"), { recursive: true });
  cpSync(join(root, "contract.json"), join(dir, "contract.json"));
  writeFileSync(join(dir, "plugin.js"), "export const x = 1;\n");
  writeFileSync(join(dir, "src", "version.js"), 'export const PLUGIN_VERSION = "1.0.0";\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", type: "module", version: "1.0.0" }));
  const keyA = pem();
  writeFileSync(join(dir, "a.pem"), keyA);
  writeFileSync(join(dir, "b.pem"), pem());
  const m = { id: "super-tv", version: "1.0.0", apiVersion: 13, entry: "plugin.js", homepage: "https://github.com/o/r", hosts: [{ host: "a.example", insecureHttp: true }] };
  m.signature = signEntry(Buffer.from("export const x = 1;\n"), "o/r", m.id, m.version, keyA);
  writeFileSync(join(dir, "kino-plugin.json"), JSON.stringify(m, null, 2) + "\n");
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "release 1.0.0");
  if (hostsAfter) {
    m.hosts = hostsAfter;
    writeFileSync(join(dir, "kino-plugin.json"), JSON.stringify(m, null, 2) + "\n");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "hosts job");
  }
  return dir;
}
const release = (dir, args) => spawnSync("node", ["scripts/release.mjs", ...args], { cwd: dir, encoding: "utf8" });
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

test("release refuses another author key, an older version and unreleased hosts, before writing anything", () => {
  const dir = releaseRepo({ hostsAfter: [{ host: "a.example", insecureHttp: true }, { host: "b.example", insecureHttp: true }] });
  try {
    const before = sha(join(dir, "kino-plugin.json"));
    let r = release(dir, ["1.0.1", "--key", "b.pem"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not this plugin's author key/);
    assert.doesNotMatch(r.stderr + r.stdout, /PRIVATE KEY/);
    r = release(dir, ["1.0.0", "--key", "a.pem"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not newer/);
    r = release(dir, ["1.0.1", "--key", "a.pem"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /b\.example/);
    assert.equal(sha(join(dir, "kino-plugin.json")), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the version files name the last signed release, so `npm run release -- <next>` makes the bump", () => {
  const m = JSON.parse(readFileSync(join(root, "kino-plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const code = /PLUGIN_VERSION = "([^"]*)"/.exec(readFileSync(join(root, "src", "version.js"), "utf8"));
  assert.equal(pkg.version, m.version, "package.json");
  assert.equal(code && code[1], m.version, "src/version.js");
  // The manifest's signature is for its version: over plugin.js as signed (the working copy right after a release, else the
  // one committed with that version).
  const scripts = [readFileSync(join(root, m.entry))];
  try {
    const sha = execFileSync("git", ["log", "-1", "--format=%H", "-G", '"version":', "--", "kino-plugin.json"], { cwd: root, encoding: "utf8" }).trim();
    if (sha) scripts.push(execFileSync("git", ["show", `${sha}:${m.entry}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
  } catch (_) { /* no history here: the working copy only */ }
  assert.ok(scripts.some((b) => verifyEntry(m.signature, b, bindingOf(m), m.id, m.version)),
    `${m.version} is not a signed release: the version files stay at the last release and npm run release bumps them`);
});
