// A signed release, on the owner's machine (never in CI: the author key stays local).
//   git pull --ff-only            (the "Servidores sanos" job edits kino-plugin.json)
//   npm run release -- <next x.y.z> [--allow-new-hosts] [--key <author key .pem>]
// Until then the version files name the last signed release (test/hosts.test.mjs checks it). Bumps the version
// (kino-plugin.json, package.json, src/version.js), builds, signs with the author key, checks the signature, validates and
// tests. Refuses: a version that is not newer; a key that is not the one this plugin is already signed with (Kino pins it: a
// new key breaks every update); hosts that the last release did not declare (an update with new hosts waits for each
// person's approval) unless --allow-new-hosts. Prints only key paths and fingerprints.
// Kept identical in kino-plugin-supertv and kino-plugin-ultrahd.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { rawAuthorKey, fingerprint, verifyEntry } from "../sdk/seal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY = "~/.config/maraton-signing/xuper-plugin-author-key.pem";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export const newer = (a, b) => {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
};
const hostName = (h) => (typeof h === "string" ? h : h.host);
export const newHosts = (current, released) => { const was = new Set(released.map(hostName)); return current.map(hostName).filter((h) => !was.has(h)); };
export const bindingOf = (manifest) => { const m = /github\.com\/([^/]+\/[^/#?]+)/.exec(String(manifest.homepage || "")); return m ? m[1].replace(/\.git$/, "") : null; };
/** The public half of a PKCS#8 Ed25519 key, hex, as the manifest's signature.authorKey. */
export const publicKeyOf = (pem) => rawAuthorKey(createPrivateKey(pem)).toString("hex");
const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

// The hosts of the last release: kino-plugin.json at the last commit that changed its "version".
function releasedHosts() {
  const sha = git(["log", "-1", "--format=%H", "-G", '"version":', "--", "kino-plugin.json"]);
  return sha ? JSON.parse(git(["show", `${sha}:kino-plugin.json`])).hosts : null;
}

function run(cmd, args) {
  console.log("$ " + [cmd, ...args].join(" "));
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

async function main(argv) {
  const version = argv.find((a) => SEMVER.test(a));
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const manifestFile = join(root, "kino-plugin.json");
  const m = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!version) throw new Error("usage: npm run release -- <x.y.z> [--allow-new-hosts] [--key <pem>]");
  if (!newer(version, m.version)) throw new Error(`${version} is not newer than ${m.version}`);
  const binding = bindingOf(m);
  if (!binding) throw new Error('kino-plugin.json "homepage" names no GitHub repository');

  const keyFile = expand(opt("--key") || process.env.KINO_AUTHOR_KEY || DEFAULT_KEY);
  if (!existsSync(keyFile)) throw new Error(`no author key at ${keyFile}`);
  const pub = publicKeyOf(readFileSync(keyFile, "utf8"));
  if (m.signature && m.signature.authorKey && m.signature.authorKey !== pub) {
    throw new Error(`the key at ${keyFile} (${fingerprint(Buffer.from(pub, "hex"))}) is not this plugin's author key (${fingerprint(Buffer.from(m.signature.authorKey, "hex"))}): Kino would refuse the update`);
  }

  const released = releasedHosts();
  const added = released ? newHosts(m.hosts, released) : [];
  if (added.length && !argv.includes("--allow-new-hosts")) {
    throw new Error(`hosts not in the last release (each person must approve them before updating): ${added.join(", ")}. Pass --allow-new-hosts to release them anyway.`);
  }
  try {
    if (Number(git(["rev-list", "--count", "HEAD..@{u}"])) > 0) throw new Error("this branch is behind its upstream: git pull --ff-only first (the hosts job edits kino-plugin.json)");
  } catch (e) { if (/behind/.test(e.message)) throw e; /* no upstream: nothing to compare */ }
  const dirty = git(["status", "--porcelain", "--", "src"]);
  if (dirty) console.warn("note: src/ has uncommitted changes; they go into this release:\n" + dirty);

  m.version = version;
  writeFileSync(manifestFile, JSON.stringify(m, null, 2) + "\n");
  const pkgFile = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.version = version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  const vFile = join(root, "src", "version.js");
  writeFileSync(vFile, readFileSync(vFile, "utf8").replace(/PLUGIN_VERSION = "[^"]*"/, `PLUGIN_VERSION = "${version}"`));

  run("npm", ["run", "build"]);
  run("node", ["sdk/seal.mjs", "--sign", "--repo", binding, "--key", keyFile]);
  const signed = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!verifyEntry(signed.signature, readFileSync(join(root, signed.entry)), binding, signed.id, signed.version)) throw new Error("the new signature does not verify");
  run("node", ["sdk/validate.mjs", "."]);
  run("node", ["scripts/check-quickjs.mjs"]);
  run("npm", ["test"]);
  console.log(`\nsigned ${signed.id} ${version} for ${binding} with ${fingerprint(Buffer.from(pub, "hex"))}.`);
  console.log("next: commit kino-plugin.json, package.json, plugin.js and src/ as xuper-plugin, push, then check that the raw");
  console.log("kino-plugin.json and plugin.js on main verify (verifyEntry) before telling anyone to update.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error("release: " + e.message); process.exit(1); });
}
