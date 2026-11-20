import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_META,
  SUPPORTED_ASSETS,
  assertAsset,
  chainOf,
  isAsset,
  toBaseUnits,
  fromBaseUnits,
  allPairs,
  UnsupportedAssetError,
} from "../src/assets.js";

describe("asset allow-list", () => {
  it("supports only native BTC, ETH, BNB on their respective chains", () => {
    assert.deepEqual(SUPPORTED_ASSETS, ["BTC", "ETH", "BNB"]);
    assert.deepEqual(SUPPORTED_ASSETS.map(chainOf), ["bitcoin", "ethereum", "bsc"]);
  });

  it("does not allow runtime edits to supported assets or their units", () => {
    assert.equal(Reflect.set(SUPPORTED_ASSETS, 0, "RUNE"), false);
    assert.equal(Reflect.set(ASSET_META.BTC, "decimals", 2), false);
    assert.equal(toBaseUnits("BTC", "1"), 100_000_000n);
  });

  it("rejects everything else", () => {
    for (const bad of ["WBNB", "WBTC", "WETH", "RUNE", "USDT", "USDC", "SOL", "BTCB", "__proto__", ""]) {
      assert.equal(isAsset(bad), false);
      assert.throws(() => assertAsset(bad), UnsupportedAssetError);
    }
  });

  it("converts base units", () => {
    assert.equal(toBaseUnits("BTC", "1.5"), 150_000_000n);
    assert.equal(toBaseUnits("ETH", "1"), 10n ** 18n);
    assert.equal(toBaseUnits("BNB", "1"), 10n ** 18n);
    assert.equal(toBaseUnits("BTC", "0.00000001"), 1n);
    assert.equal(toBaseUnits("BNB", "0.000000000000000001"), 1n);
    assert.equal(fromBaseUnits("BTC", 150_000_000n), "1.5");
    assert.equal(fromBaseUnits("BNB", 1n), "0.000000000000000001");
  });

  it("rejects over-precision", () => {
    assert.throws(() => toBaseUnits("BTC", "0.000000001"));
    assert.throws(() => toBaseUnits("ETH", "1.0000000000000000001"));
    assert.throws(() => toBaseUnits("BNB", "0.0000000000000000001"));
  });

  it("has exactly six ordered cross-asset pairs", () => {
    assert.deepEqual(allPairs(), [
      ["BTC", "ETH"], ["BTC", "BNB"],
      ["ETH", "BTC"], ["ETH", "BNB"],
      ["BNB", "BTC"], ["BNB", "ETH"],
    ]);
  });
});
