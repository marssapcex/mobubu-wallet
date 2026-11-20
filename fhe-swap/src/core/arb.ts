import type { ArbAction, HubPool } from "./hub.js";
import type { CexPriceFeed } from "./price-feed.js";

/**
 * Permissionless arbitrageur interface.
 *
 * In production this would be an external bot watching pool price vs CEX/DEX
 * reference price and submitting a rebalancing swap. The reference
 * implementation simulates the rebalance locally so streaming mechanics can be
 * tested deterministically.
 */
export interface ArbBot {
  readonly name: string;
  rebalance(pool: HubPool): ArbAction | null;
}

export class ReferencePriceArbBot implements ArbBot {
  readonly name: string;

  constructor(
    name = "reference-price-arb",
    private readonly toleranceBps = 5,
  ) {
    this.name = name;
  }

  rebalance(pool: HubPool): ArbAction | null {
    return pool.rebalanceToReference(this.toleranceBps);
  }
}

/**
 * CEX-sourced arbitrage bot. The feed is external (e.g. Binance mid price
 * converted to NYX/asset). The bot only trades when the pool price is outside
 * the tolerance band; it does not set protocol clearing prices.
 */
export class CexPriceArbBot implements ArbBot {
  readonly name: string;

  constructor(
    name: string,
    private readonly feed: CexPriceFeed,
    private readonly toleranceBps = 5,
  ) {
    this.name = name;
  }

  rebalance(pool: HubPool): ArbAction | null {
    const ref = this.feed.priceNyxPerAssetScaled(pool.asset);
    return pool.rebalanceToPrice(ref, this.toleranceBps);
  }
}
