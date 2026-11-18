import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Asset } from "../src/assets.js";
import { suiteForAsset } from "../src/tss/types.js";
import { MockTssCluster } from "../src/tss/mock.js";

describe("TSS boundary", () => {
  it("maps BTC to FROST Schnorr and native EVM assets to ECDSA TSS", () => {
    assert.equal(suiteForAsset("BNB"), "ecdsa-secp256k1");
    assert.equal(suiteForAsset("BTC"), "frost-secp256k1");
    assert.equal(suiteForAsset("ETH"), "ecdsa-secp256k1");
  });

  it("rejects wrapped assets and chain/asset mismatches at mock signing", async () => {
    const cluster = MockTssCluster.create(3, 2);
    for (const wrapped of ["WBNB", "WBTC", "WETH", "BTCB"]) {
      const asset = wrapped as Asset;
      assert.throws(() => suiteForAsset(asset), /unsupported asset/i);
      await assert.rejects(cluster.sign("ethereum", asset, "unsigned"), /unsupported asset/i);
    }
    await assert.rejects(cluster.sign("ethereum", "BNB", "unsigned"), /chain\/asset mismatch/);
    await assert.rejects(cluster.sign("bsc", "ETH", "unsigned"), /chain\/asset mismatch/);
  });

  it("requires vault confirmation before signing", async () => {
    const cluster = MockTssCluster.create(3, 2, "frost-secp256k1");
    await assert.rejects(
      () =>
        cluster.signRequest({
          chain: "bitcoin",
          asset: "BTC",
          suite: "frost-secp256k1",
          unsignedTx: "unsigned",
          vaultConfirmed: false,
        }),
      /vault inbound must be confirmed/,
    );
  });

  it("rejects FROST for either EVM asset", async () => {
    const cluster = MockTssCluster.create(3, 2);
    for (const [chain, asset] of [["ethereum", "ETH"], ["bsc", "BNB"]] as const) {
      await assert.rejects(cluster.signRequest({ chain, asset, suite: "frost-secp256k1",
        unsignedTx: "unsigned", vaultConfirmed: true }), /requires suite ecdsa-secp256k1/);
    }
  });

  it("mock cluster produces threshold-bound mock signature", async () => {
    const cluster = MockTssCluster.create(5, 3, "ecdsa-secp256k1");
    const bnb = await cluster.sign("bsc", "BNB", "unsigned-evm-fixture");
    const eth = await cluster.sign("ethereum", "ETH", "unsigned-evm-fixture");
    assert.match(bnb.rawTx, /^tss:ecdsa-secp256k1:bsc:BNB:/);
    assert.match(eth.rawTx, /^tss:ecdsa-secp256k1:ethereum:ETH:/);
    assert.equal(bnb.txHash.length, 64);
    assert.notEqual(eth.txHash, bnb.txHash);
  });
});
