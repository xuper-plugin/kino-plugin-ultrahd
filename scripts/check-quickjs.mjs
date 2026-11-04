// Comprueba que plugin.js se puede compilar en QuickJS, el motor de Kino. El kit corre en Node, que acepta expresiones regulares
// que QuickJS rechaza ("invalid escape sequence in regular expression"): el plugin no instala y el kit no avisa.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getQuickJS } from "quickjs-emscripten";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "plugin.js"), "utf8").replace(/^export\s*\{[\s\S]*?\};?\s*$/m, "");
const QuickJS = await getQuickJS();
const vm = QuickJS.newContext();
const r = vm.evalCode(`(function(){ try { new Function(${JSON.stringify(src)}); return "ok"; } catch (e) { return "ERR " + e.message; } })()`);
const out = r.error ? "ERR " + JSON.stringify(vm.dump(r.error)) : vm.dump(r.value);
vm.dispose();
if (out !== "ok") { console.error("✗ QuickJS no compila plugin.js:", out); process.exit(1); }
console.log("✓ QuickJS compila plugin.js");
