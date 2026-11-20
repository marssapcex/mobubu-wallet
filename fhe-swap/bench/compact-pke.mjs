// Optional client-side TFHE-rs transport probe. Not the CGGI evaluator benchmark.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

if (process.argv.length !== 3) throw new Error("usage: node compact-pke.mjs <node-tfhe package directory>");
const require = createRequire(import.meta.url);
const directory = resolve(process.argv[2]);
const { name, version } = require(join(directory, "package.json"));
assert.equal(name, "node-tfhe");
assert.equal(version, "1.8.2");
const tfhe = require(directory);
tfhe.init_panic_hook();
const limit = 4n * 1024n * 1024n; // Per serialized object, not a service quota.
const testValues = [0, 30_001, 50_000, 65_535];

function individualBytes(client, Type, value, compressed) {
  const encrypted = Type.encrypt_with_client_key(value, client);
  let decoded, inflated;
  try {
    const wire = encrypted.safe_serialize(limit);
    decoded = Type.safe_deserialize(wire, limit);
    if (compressed) inflated = decoded.decompress();
    assert.equal((inflated ?? decoded).decrypt(client), value);
    return wire.length;
  } finally {
    inflated?.free();
    decoded?.free();
    encrypted.free();
  }
}

function compactBytes(client, publicKey, values) {
  const builder = tfhe.CompactCiphertextList.builder(publicKey);
  let encrypted, decoded, expanded;
  try {
    for (const value of values) builder.push_u16(value);
    encrypted = builder.build(); // No packing/key switching or encryption proof in this probe.
    const wire = encrypted.safe_serialize(limit);
    decoded = tfhe.CompactCiphertextList.safe_deserialize(wire, limit);
    assert.equal(decoded.len(), values.length);
    expanded = decoded.expand();
    for (const [i, value] of values.entries()) {
      const item = expanded.get_uint16(i);
      try { assert.equal(item.decrypt(client), value); } finally { item.free(); }
    }
    return wire.length;
  } finally {
    expanded?.free();
    decoded?.free();
    encrypted?.free();
    builder.free();
  }
}

const client = tfhe.TfheClientKey.generate(tfhe.TfheConfig.default());
let publicKey;
try {
  publicKey = tfhe.TfheCompactPublicKey.new(client);
  console.log(`node-tfhe ${version}: serialized compact public key ${publicKey.safe_serialize(limit).length} bytes (one-time, not in table)`);
  const rows = [1, 4, 16, 64].map((count) => {
    const values = Array.from({ length: count }, (_, i) => testValues[i % testValues.length]);
    const sum = (Type, compressed = false) => values.reduce((bytes, value) => bytes + individualBytes(client, Type, value, compressed), 0);
    return {
      count,
      "individual bytes": sum(tfhe.FheUint16),
      "compressed (client-key) bytes": sum(tfhe.CompressedFheUint16, true),
      "compact public list bytes": compactBytes(client, publicKey, values),
    };
  });
  console.table(rows);
  console.log("All round trips matched. Transport sizes only; no evaluation, KMS, or proof was benchmarked.");
} finally {
  publicKey?.free();
  client.free();
}
