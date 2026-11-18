import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_ASSETS,
  assertAsset,
  isAsset,
  toBaseUnits,
  fromBaseUnits,
  allPairs,
  UnsupportedAssetError,
} from "../src/assets.js";

describe("asset allow-list", () => {
  it("supports exactly BTC, ETH, XMR, ZEC, DAI", () => {
    assert.deepEqual([...SUPPORTED_ASSETS], ["BTC", "ETH", "XMR", "ZEC", "DAI"]);
  });

  it("rejects everything else", () => {
    for (const bad of ["RUNE", "USDT", "USDC", "SOL", "BTCB", "WBTC", ""]) {
      assert.equal(isAsset(bad), false);
      assert.throws(() => assertAsset(bad), UnsupportedAssetError);
    }
  });

  it("converts base units", () => {
    assert.equal(toBaseUnits("BTC", "1.5"), 150_000_000n);
    assert.equal(toBaseUnits("ETH", "1"), 10n ** 18n);
    assert.equal(toBaseUnits("XMR", "1"), 10n ** 12n);
    assert.equal(toBaseUnits("ZEC", "0.00000001"), 1n);
    assert.equal(toBaseUnits("DAI", "2.25"), 2_250_000_000_000_000_000n);
    assert.equal(fromBaseUnits("BTC", 150_000_000n), "1.5");
    assert.equal(fromBaseUnits("DAI", 2_250_000_000_000_000_000n), "2.25");
  });

  it("rejects over-precision", () => {
    assert.throws(() => toBaseUnits("BTC", "0.000000001"));
    assert.throws(() => toBaseUnits("ETH", "1.0000000000000000001"));
  });

  it("has 20 ordered cross-asset pairs", () => {
    const pairs = allPairs();
    assert.equal(pairs.length, 20);
    for (const [a, b] of pairs) assert.notEqual(a, b);
  });
});
