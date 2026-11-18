import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SealFheClient, SealFheEvaluator } from "../src/fhe/seal.js";

describe("SEAL BFV encrypted computation", () => {
  let client: SealFheClient;
  let evaluator: SealFheEvaluator;

  before(async () => {
    client = await SealFheClient.create();
    evaluator = await SealFheEvaluator.fromBundle(client.publicBundle());
  });

  it("encrypts and decrypts a vector", () => {
    const values = [1n, 2n, 3n, 4n];
    const ct = client.encrypt(values);
    assert.deepEqual(client.decrypt(ct), values);
  });

  it("evaluator has no decrypt capability", () => {
    assert.equal("decrypt" in evaluator, false);
  });

  it("adds ciphertexts without plaintext", () => {
    const a = client.encrypt([10n, 20n, 30n]);
    const b = client.encrypt([1n, 2n, 3n]);
    const sum = evaluator.add(a, b);
    assert.deepEqual(client.decrypt(sum), [11n, 22n, 33n]);
  });

  it("multiplies ciphertext by plaintext vector", () => {
    const a = client.encrypt([10n, 20n, 30n]);
    const out = evaluator.multiplyPlain(a, [2n, 3n, 4n]);
    assert.deepEqual(client.decrypt(out), [20n, 60n, 120n]);
  });

  it("multiplies ciphertexts and relinearizes", () => {
    const a = client.encrypt([3n, 4n]);
    const b = client.encrypt([5n, 6n]);
    const out = evaluator.multiply(a, b);
    assert.deepEqual(client.decrypt(out), [15n, 24n]);
  });

  it("serializes and deserializes ciphertexts", () => {
    const a = client.encrypt([7n, 8n]);
    const blob = evaluator.serialize(a);
    const restored = evaluator.deserialize(blob);
    assert.deepEqual(client.decrypt(restored), [7n, 8n]);
  });

  it("rejects values outside plaintext modulus", () => {
    assert.throws(() => client.encrypt([client.plainModulus]));
    assert.throws(() => client.encrypt([-1n]));
  });
});
