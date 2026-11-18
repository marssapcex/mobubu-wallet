import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HubPool, HubPoolBook, HubRouter, isqrt } from "../src/core/hub.js";
import { TokenTreasury } from "../src/core/token.js";
import { PRICE_SCALE } from "../src/core/units.js";

describe("NYX hub pools and router", () => {
  it("isqrt floors correctly", () => {
    assert.equal(isqrt(0n), 0n);
    assert.equal(isqrt(1n), 1n);
    assert.equal(isqrt(15n), 3n);
    assert.equal(isqrt(16n), 4n);
    assert.equal(isqrt(10n ** 30n), 10n ** 15n);
  });

  it("constant-product output matches proposition", () => {
    const pool = new HubPool({
      asset: "BTC",
      reserveAssetThor: 1_000_000n,
      reserveNyxThor: 10_000_000n,
      referencePriceNyxPerAssetScaled: 10n * PRICE_SCALE,
      maxInputThor: 1_000_000n,
    });
    const q = pool.quoteAssetToNyx(100_000n);
    assert.equal(q.amountOutThor, (10_000_000n * 100_000n) / (1_000_000n + 100_000n));
    pool.executeAssetToNyx(100_000n);
    assert.equal(pool.reserves().assetThor, 1_100_000n);
  });

  it("arb bot restores reference price band", () => {
    const pool = new HubPool({
      asset: "BTC",
      reserveAssetThor: 1_000_000n,
      reserveNyxThor: 10_000_000n,
      referencePriceNyxPerAssetScaled: 10n * PRICE_SCALE,
      maxInputThor: 1_000_000n,
    });
    pool.executeAssetToNyx(200_000n);
    const before = pool.priceNyxPerAssetScaled();
    assert.ok(before < 10n * PRICE_SCALE);
    const action = pool.rebalanceToReference(5);
    assert.ok(action);
    const after = pool.priceNyxPerAssetScaled();
    const ref = 10n * PRICE_SCALE;
    const diff = after > ref ? after - ref : ref - after;
    assert.ok(diff * 10_000n <= ref * 5n);
  });

  it("routes A -> NYX -> B and collects fee in NYX", () => {
    const pools = new HubPoolBook();
    pools.add(
      new HubPool({
        asset: "BTC",
        reserveAssetThor: 1_000_000n,
        reserveNyxThor: 10_000_000n,
        referencePriceNyxPerAssetScaled: 10n * PRICE_SCALE,
        maxInputThor: 1_000_000n,
      }),
    );
    pools.add(
      new HubPool({
        asset: "ETH",
        reserveAssetThor: 10_000_000n,
        reserveNyxThor: 10_000_000n,
        referencePriceNyxPerAssetScaled: 1n * PRICE_SCALE,
        maxInputThor: 100_000_000n,
      }),
    );
    const treasury = new TokenTreasury();
    const router = new HubRouter(pools, 30, treasury);
    const q = router.execute("BTC", "ETH", 10_000n);
    assert.ok(q.intermediateNyxThor > 0n);
    assert.equal(q.feeNyxThor, (q.intermediateNyxThor * 30n) / 10_000n);
    assert.ok(q.netOutThor > 0n);
    assert.equal(treasury.snapshot().collectedNyxThor, q.feeNyxThor);
  });

  it("rejects unsupported external assets", () => {
    const pools = new HubPoolBook();
    pools.add(
      new HubPool({
        asset: "BTC",
        reserveAssetThor: 1n,
        reserveNyxThor: 1n,
        referencePriceNyxPerAssetScaled: PRICE_SCALE,
        maxInputThor: 1n,
      }),
    );
    const router = new HubRouter(pools, 0);
    assert.throws(() => router.quote("RUNE" as any, "BTC", 1n));
  });
});
