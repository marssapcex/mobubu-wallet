import assert from "node:assert/strict";
import { test } from "node:test";
import { SCALAR_FIELD, createVaultCrypto, proveWithdrawal } from "../packages/client/src/zk-vault.mjs";
import { encodeStatement } from "../packages/client/src/zk-wire.mjs";

const valid = {
  root: "1", nullifierHash: "2", recipient: "3", domain: "0", nullifier: "5", secret: "6",
  pathElements: Array(20).fill("0"), pathIndices: Array(20).fill("1"),
};

test("SDK rejects aliases, incorrect witness shape and out-of-range values before reading artifacts", async () => {
  const unreadable = { get wasm() { throw new Error("artifact was read"); }, zkey: null };
  for (const [change, why] of [
    [{ root: "0" }, /root must be nonzero/],
    [{ recipient: 1n << 160n }, /recipient is out of range/],
    [{ nullifierHash: "02" }, /canonical/],
    [{ secret: "0" }, /secret must be nonzero/],
    [{ nullifier: SCALAR_FIELD + 5n }, /nullifier is out of range/],
    [{ pathElements: [...valid.pathElements.slice(1), SCALAR_FIELD] }, /pathElements is out of range/],
    [{ pathIndices: [...valid.pathIndices.slice(1), "2"] }, /pathIndices is out of range/],
    [{ pathElements: Array(20) }, /pathElements must be a bigint/],
    [{ pathIndices: ["1"] }, /pathIndices must have 20 elements/],
  ]) {
    await assert.rejects(proveWithdrawal({ ...valid, ...change }, unreadable), why);
  }
  assert.equal(encodeStatement(valid).byteLength, 128);
  assert.throws(() => encodeStatement({ ...valid, recipient: 1n << 160n }), /recipient/);
});

test("lightweight Poseidon preserves the fixed-depth empty root", async () => {
  const client = await createVaultCrypto();
  assert.equal(client.createTree().root, 15019797232609675441998260052101280400536945603062888308240081994073687793470n);
});
