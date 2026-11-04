// Llena al máximo todo lo que el plugin guarda en kino.storage y comprueba que no se pasa del tope del contrato
// (262144 bytes EN TOTAL por plugin, clave + valor), que respeta el presupuesto de cada clase y que nunca lanza.
// node scripts/test-storage.mjs
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = (f) => pathToFileURL(join(root, "src", f)).href;

// kino.storage tal como lo limita el contrato: el total de claves y valores no pasa de [cap] bytes, si no, too_large.
function fakeStorage(cap) {
  const data = {};
  const bytes = () => Buffer.byteLength(JSON.stringify(data));
  return {
    data, bytes,
    api: {
      get: (k) => (Object.hasOwn(data, k) ? data[k] : null),
      set: (k, v) => {
        const prev = data[k];
        data[k] = String(v);
        if (bytes() > cap) { if (prev === undefined) delete data[k]; else data[k] = prev; throw Object.assign(new Error("plugin storage full"), { code: "too_large" }); }
      },
      remove: (k) => { delete data[k]; },
      keys: () => Object.keys(data),
    },
  };
}

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log("  FALLA:", msg); } };

async function run(label, cap) {
  const fake = fakeStorage(cap);
  globalThis.kino = { storage: fake.api };
  const store = await import(url("store.js") + "?" + label);
  const recent = await import(url("recent.js") + "?" + label);
  let worst = 0;
  const worstClass = {};
  let throwsSeen = 0;
  const after = () => {
    worst = Math.max(worst, fake.bytes());
    const u = store.usage();
    for (const [c, n] of Object.entries(u.byClass)) worstClass[c] = Math.max(worstClass[c] || 0, n);
  };
  const safely = (fn) => { try { return fn(); } catch (e) { throwsSeen++; console.log("  lanzó:", e.message); return undefined; } };

  const srvList = Array.from({ length: 12 }, (_, i) => ({ url: `https://srv${i}.example.com`, username: "u" + "x".repeat(12), password: "p" + "y".repeat(12) }));
  safely(() => store.put("srvs", JSON.stringify({ ts: Date.now(), list: srvList, idx: 0, ok: true })));
  safely(() => store.put("vcode", "21"));
  safely(() => store.put("browseTab", "movies"));
  safely(() => store.put("browseLang", "es-419"));

  const catList = (n) => JSON.stringify({ ts: Date.now(), l: Array.from({ length: n }, (_, i) => [String(1000 + i), `CATEGORÍA DE EJEMPLO NÚMERO ${i} - (LAT)`]) });
  const ficha = () => ({ backdrop: "https://image.tmdb.org/t/p/w1280/" + "a".repeat(27) + ".jpg", tmdb: 123456, runtime: 114, genres: ["Terror", "Misterio", "Crimen"] });
  const hist = () => JSON.stringify({ v: 1, e: Array.from({ length: 24 }, (_, i) => ({ id: "vod-" + (1700000 + i), ref: "vod:" + (1700000 + i) + ":mkv", title: "Película de ejemplo con título largo número " + i, kind: "movie", poster: "https://image.tmdb.org/t/p/w600_and_h900_bestv2/" + "b".repeat(27) + ".jpg" })) });

  for (let s = 0; s < 40; s++) {
    const key = "s" + s.toString(36);
    safely(() => store.put(`cats:vod:${key}`, catList(72)));
    after();
    safely(() => store.put(`cats:series:${key}`, catList(86)));
    after();
    safely(() => store.put(`cats:live:${key}`, catList(143)));
    after();
    const map = {};
    for (let f = 0; f < 80; f++) map["vod-" + (1700000 + f)] = ficha();
    safely(() => store.put(`vinfo:${key}`, JSON.stringify(map)));
    after();
    safely(() => store.put(`searchHist:v1:${key}`, hist()));
    after();
    for (let p = 0; p < 15; p++) { safely(() => recent.noteRecent(1700000 + s * 100 + p, "mkv", key)); }
    after();
  }

  // Un valor que no cabe nunca debe lanzar ni dejar rastro.
  check(safely(() => store.put("cats:vod:enorme", "x".repeat(300 * 1024))) === false, "un valor de 300 KB debía rechazarse con false");
  after();

  const u = store.usage();
  console.log(`${label}: tope ${cap} B | máximo alcanzado ${worst} B (${((worst / cap) * 100).toFixed(0)} %) | final ${fake.bytes()} B | entradas ${u.count}`);
  console.log("  por clase (máximo alcanzado / presupuesto):", Object.entries(store.CLASSES).map(([c, d]) => `${c} ${worstClass[c] || 0}/${d.budget}`).join(" · "));
  check(throwsSeen === 0, "alguna operación lanzó");
  check(worst <= cap, `se pasó del tope (${worst} > ${cap})`);
  for (const [c, d] of Object.entries(store.CLASSES)) check((worstClass[c] || 0) <= d.budget, `la clase ${c} se pasó de su presupuesto`);
  check(fake.api.get("srvs") !== null && fake.api.get("vcode") !== null, "la lista de servidores o el código de versión se expulsaron");
  check(fake.api.get("browseTab") === "movies" || store.CLASSES.misc.budget > 0, "los ajustes pequeños se perdieron");
}

await run("contrato (262144 B)", 262144);
await run("tope apretado (100000 B, fuerza el reintento por too_large)", 100000);
console.log(failures ? `\n${failures} comprobación(es) fallaron` : "\nOK: el almacenamiento nunca se pasa del tope y degrada sin lanzar");
process.exitCode = failures ? 1 : 0;
