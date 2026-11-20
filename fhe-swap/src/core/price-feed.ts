import { assertAsset, type Asset } from "../assets.js";

/**
 * External CEX/DEX reference price feed used by permissionless arbitrageurs.
 *
 * The protocol itself does not need this feed to clear swaps: pool prices are
 * determined by reserves. The feed is only used by bots deciding whether an arb
 * trade is profitable. A stale/wrong feed hurts the bot, not the clearing rule.
 *
 * Production example: Binance REST/WebSocket mid price converted to NYX/asset.
 * This reference ships a static feed so tests/demo are deterministic and do not
 * make network calls.
 */
export interface CexPriceFeed {
  readonly name: string;
  /** NYX per 1 external asset, scaled by PRICE_SCALE. */
  priceNyxPerAssetScaled(asset: Asset): bigint;
}

export class StaticCexPriceFeed implements CexPriceFeed {
  readonly name: string;
  private prices = new Map<Asset, bigint>();

  constructor(
    name: string,
    prices: Partial<Record<Asset, bigint>>,
  ) {
    this.name = name;
    for (const [asset, price] of Object.entries(prices)) {
      const a = assertAsset(asset);
      if (price === undefined) continue;
      if (price <= 0n) throw new Error(`invalid reference price for ${a}`);
      this.prices.set(a, price);
    }
  }

  priceNyxPerAssetScaled(asset: Asset): bigint {
    const a = assertAsset(asset);
    const price = this.prices.get(a);
    if (price === undefined) {
      throw new Error(`${this.name} has no reference price for ${a}`);
    }
    return price;
  }
}
