// Sealed feeds for tests: the producers' formats and a stand-in for Kino's native kino.crypto.decrypt, kino.crypto.gunzip and
// kino.secret("feedKey") as the plugin calls them (key as utf8 text, Kino's default keyEncoding).
// v1: { v:1, iv, data } with AES-256-GCM over the UTF-8 JSON, the 16-byte tag after the ciphertext.
// v2: { v:2, iv, data } the same, over gzip (mtime 0) of the UTF-8 JSON (published beside v1 as <path>.v2.enc.json).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export function sealer() {
  const key = randomBytes(16).toString("hex"); // 32 characters = 32 bytes as utf8
  const box = (v, plain) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return JSON.stringify({ v, iv: iv.toString("base64"), data: Buffer.concat([ct, c.getAuthTag()]).toString("base64") });
  };
  const seal = (obj) => box(1, Buffer.from(JSON.stringify(obj), "utf8"));
  const sealV2 = (obj) => box(2, gzipSync(Buffer.from(JSON.stringify(obj), "utf8")));
  // [opts.gunzip] false: a Kino without kino.crypto.gunzip.
  const withCrypto = (kino, opts = {}) => {
    kino.secret = (name) => (name === "feedKey" ? key : null);
    kino.crypto = {
      decrypt: (alg, o) => {
        const b = Buffer.from(o.data, "base64");
        const d = createDecipheriv(alg, Buffer.from(o.key, "utf8"), Buffer.from(o.iv, o.ivEncoding || "utf8"));
        d.setAuthTag(b.subarray(b.length - 16));
        return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString(o.outputEncoding || "utf8");
      },
      ...(opts.gunzip === false ? {} : { gunzip: (data, o = {}) => gunzipSync(Buffer.from(data, o.inputEncoding || "base64")).toString(o.outputEncoding || "utf8") }),
    };
    return kino;
  };
  return { seal, sealV2, withCrypto };
}
