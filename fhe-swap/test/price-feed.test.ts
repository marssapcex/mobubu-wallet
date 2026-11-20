import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CexPriceArbBot } from "../src/core/arb.js";
import { HubPool } from "../src/core/hub.js";
import { StaticCexPriceFeed } from "../src/core/price-feed.js";
import { PRICE_SCALE } from "../src/core/units.js";

describe("CEX reference price feed and arb bot", () => {
  it("static feed returns configured NYX/asset prices", () => {
    const feed = new StaticCexPriceFeed("binance-static", {
      BTC: 1_000_000n * PRICE_SCALE,
      ETH: 50_000n * PRICE_SCALE,
    });
    assert.equal(feed.priceNyxPerAssetScaled("BTC"), 1_000_000n * PRICE_SCALE);
    assert.throws(() => feed.priceNyxPerAssetScaled("BNB"), /no reference price/);
  });

  it("cex arb bot rebalances a drifted pool toward the external price", () => {
    const pool = new HubPool({
      asset: "BTC",
      reserveAssetThor: 1_000_000n,
      reserveNyxThor: 10_000_000n,
      referencePriceNyxPerAssetScaled: 10n * PRICE_SCALE,
      maxInputThor: 1_000_000n,
      maxNyxInputThor: 10_000_000n,
    });
    pool.executeAssetToNyx(200_000n);
    const feed = new StaticCexPriceFeed("binance-static", {
      BTC: 10n * PRICE_SCALE,
    });
    const bot = new CexPriceArbBot("arb", feed, 5);
    const action = bot.rebalance(pool);
    assert.ok(action);
    const after = pool.priceNyxPerAssetScaled();
    const ref = 10n * PRICE_SCALE;
    const diff = after > ref ? after - ref : ref - after;
    assert.ok(diff * 10_000n <= ref * 5n);
  });
});
