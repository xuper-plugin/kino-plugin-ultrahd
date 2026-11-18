// A fake `kino` for node --test: string-only storage like Kino's (with the plugin's 262144-byte cap), a scripted fetch that
// records every request, kino.error, kino.lang and kino.config. Installed as globalThis.kino.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixture = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "panels.json"), "utf8"));

/** A Kino-like response (lower-cased header names). */
export function res(status, body = "", headers = {}) {
  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status <= 299, status, url: "", headers: h, text: () => text, json: () => JSON.parse(text) };
}

export function kinoError(code, message, extra = {}) {
  return Object.assign(new Error(message || code), { name: "KinoError_" + code, code }, extra);
}

/**
 * opts.routes: [(url, init) => response | Error | undefined]; the first that answers wins; no answer -> network error.
 * opts.storage: initial { key: string }. opts.cap: storage cap in bytes (default 262144). opts.lang: "es-CO" by default.
 */
export function installKino(opts = {}) {
  const store = new Map(Object.entries(opts.storage || {}));
  const requests = [];
  const writes = [];
  const cap = opts.cap || 262144;
  const bytes = () => { let n = 0; for (const [k, v] of store) n += Buffer.byteLength(k) + Buffer.byteLength(v); return n; };
  const kino = {
    lang: opts.lang || "es-CO",
    appVersion: "test",
    config: { get: (k) => (opts.config && k in opts.config ? opts.config[k] : undefined) },
    error: (code, message, o) => kinoError(code, message, o && o.userMessage ? { userMessage: o.userMessage } : {}),
    storage: {
      get: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      set: (k, v) => {
        const key = String(k);
        const prev = store.get(key);
        store.set(key, String(v));
        if (bytes() > cap) {
          if (prev === undefined) store.delete(key); else store.set(key, prev);
          throw kinoError("too_large", "plugin storage full");
        }
        writes.push(key);
      },
      remove: (k) => { store.delete(String(k)); },
      keys: () => Array.from(store.keys()),
    },
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      for (const r of opts.routes || []) {
        const out = await r(String(url), init);
        if (out instanceof Error) throw out;
        if (out) return out;
      }
      throw kinoError("network", "no route for " + String(url).slice(0, 60));
    },
  };
  globalThis.kino = kino;
  return { kino, store, requests, writes, bytes };
}

/** A query parameter of a request url. */
export const param = (url, name) => new URL(url).searchParams.get(name);

let n = 0;
/** A fresh copy of a src module (its own module state), with every relative import shared as usual. */
export const fresh = (rel) => import(new URL("../../src/" + rel, import.meta.url).href + "?t=" + ++n);

/**
 * Kino's network in virtual time, for timing tests: at most [parallel] of the plugin's requests in flight (Kino's FetchGate),
 * each taking [ms] of virtual time from when it starts. A route answers with `net.request(ms).then(() => response | Error)`.
 * run(promise) advances the clock event by event until the promise settles; now() is the clock (install it as Date.now).
 */
export function virtualNet({ start = 0, parallel = 6 } = {}) {
  let t = start;
  const timers = [];
  const queue = [];
  let inFlight = 0;
  const begin = (job) => {
    inFlight++;
    timers.push({ at: t + job.ms, fire: () => { inFlight--; job.done(); const n = queue.shift(); if (n) begin(n); } });
  };
  const request = (ms) => new Promise((done) => { const job = { ms, done }; if (inFlight < parallel) begin(job); else queue.push(job); });
  async function run(promise) {
    let settled = false;
    let value;
    let error;
    promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
    for (;;) {
      await new Promise((r) => setImmediate(r));
      if (settled) break;
      if (!timers.length) throw new Error("virtualNet: the promise waits on nothing in flight");
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      t = next.at;
      next.fire();
    }
    if (error) throw error;
    return value;
  }
  return { now: () => t, request, run };
}
