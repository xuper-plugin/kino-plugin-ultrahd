// Sealed feeds for tests: the producers' format ({ v:1, iv, data } with AES-256-GCM, the 16-byte tag after the ciphertext)
// and a stand-in for Kino's native kino.crypto.decrypt / kino.secret("feedKey") as the plugin calls them (key as utf8 text,
// Kino's default keyEncoding).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function sealer() {
  const key = randomBytes(16).toString("hex"); // 32 characters = 32 bytes as utf8
  const seal = (obj) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString("base64"), data: Buffer.concat([ct, c.getAuthTag()]).toString("base64") });
  };
  const withCrypto = (kino) => {
    kino.secret = (name) => (name === "feedKey" ? key : null);
    kino.crypto = {
      decrypt: (alg, o) => {
        const b = Buffer.from(o.data, "base64");
        const d = createDecipheriv(alg, Buffer.from(o.key, "utf8"), Buffer.from(o.iv, o.ivEncoding || "utf8"));
        d.setAuthTag(b.subarray(b.length - 16));
        return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString("utf8");
      },
    };
    return kino;
  };
  return { seal, withCrypto };
}
