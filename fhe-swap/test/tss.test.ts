import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suiteForAsset } from "../src/tss/types.js";
import { MockTssCluster } from "../src/tss/mock.js";

describe("TSS boundary", () => {
  it("maps XMR to FROSTLASS/CLSAG, BTC to FROST Schnorr, EVM to ECDSA TSS", () => {
    assert.equal(suiteForAsset("XMR"), "frostlass-clsag");
    assert.equal(suiteForAsset("BTC"), "frost-secp256k1");
    assert.equal(suiteForAsset("ETH"), "ecdsa-secp256k1");
    assert.equal(suiteForAsset("DAI"), "ecdsa-secp256k1");
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

  it("rejects wrong suite for asset", async () => {
    const cluster = MockTssCluster.create(3, 2, "frost-secp256k1");
    await assert.rejects(
      () =>
        cluster.signRequest({
          chain: "monero",
          asset: "XMR",
          suite: "frost-secp256k1",
          unsignedTx: "unsigned",
          vaultConfirmed: true,
        }),
      /requires suite frostlass-clsag/,
    );
    await assert.rejects(
      () =>
        cluster.signRequest({
          chain: "ethereum",
          asset: "ETH",
          suite: "frost-secp256k1",
          unsignedTx: "unsigned",
          vaultConfirmed: true,
        }),
      /requires suite ecdsa-secp256k1/,
    );
  });

  it("mock cluster produces threshold-bound mock signature", async () => {
    const cluster = MockTssCluster.create(5, 3, "frostlass-clsag");
    const signed = await cluster.sign("monero", "XMR", "unsigned-xmr");
    assert.match(signed.rawTx, /^tss:frostlass-clsag:monero:XMR:/);
    assert.equal(signed.txHash.length, 64);
  });
});
