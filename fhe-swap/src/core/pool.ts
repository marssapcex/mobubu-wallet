import { assertAsset, type Asset } from "../assets.js";
import type { PoolQuote, SwapPair } from "./types.js";
import { PRICE_SCALE, scalePrice } from "./units.js";

export interface PoolConfig {
  pair: SwapPair;
  /** Reserve of input asset in thor units. */
  reserveInThor: bigint;
  /** Reserve of output asset in thor units. */
  reserveOutThor: bigint;
  feeBps: number;
  maxInputThor: bigint;
}

/**
 * Bounded fixed-price reference pool.
 *
 * This is NOT THORChain's CLP and NOT a constant-product AMM. It publishes a
 * fixed price multiplier derived from reserve ratios, plus a public input cap
 * so the BFV plaintext modulus cannot overflow. It exists to exercise the
 * encrypted quoting path deterministically.
 */
export class ReferencePool {
  constructor(public readonly cfg: PoolConfig) {
    assertAsset(cfg.pair.from);
    assertAsset(cfg.pair.to);
    if (cfg.pair.from === cfg.pair.to) {
      throw new Error("self-pool is not supported");
    }
    if (cfg.reserveInThor <= 0n || cfg.reserveOutThor <= 0n) {
      throw new Error("reserves must be positive");
    }
    if (cfg.maxInputThor <= 0n) {
      throw new Error("maxInputThor must be positive");
    }
    if (!Number.isInteger(cfg.feeBps) || cfg.feeBps < 0 || cfg.feeBps >= 10_000) {
      throw new Error("feeBps must be an integer in [0, 10000)");
    }
    if (this.quote().priceScaled <= 0n) {
      throw new Error("reserve ratio produces zero scaled price");
    }
  }

  quote(): PoolQuote {
    return {
      pair: this.cfg.pair,
      priceScaled: scalePrice(this.cfg.reserveOutThor, this.cfg.reserveInThor),
      feeBps: this.cfg.feeBps,
      maxInputThor: this.cfg.maxInputThor,
    };
  }

  /** Net output for a known input under the same fixed-price rule as the matcher. */
  spotOutThor(amountInThor: bigint): bigint {
    if (amountInThor <= 0n) throw new Error("amount must be positive");
    if (amountInThor > this.cfg.maxInputThor) {
      throw new Error("amount exceeds pool maxInputThor");
    }
    const q = this.quote();
    const netMultiplier = q.priceScaled * BigInt(10_000 - this.cfg.feeBps);
    return (amountInThor * netMultiplier) / (PRICE_SCALE * 10_000n);
  }
}

export function pairKey(from: Asset, to: Asset): string {
  return `${from}->${to}`;
}

export class PoolBook {
  private pools = new Map<string, ReferencePool>();

  add(pool: ReferencePool): void {
    this.pools.set(pairKey(pool.cfg.pair.from, pool.cfg.pair.to), pool);
  }

  get(pair: SwapPair): ReferencePool {
    const pool = this.pools.get(pairKey(pair.from, pair.to));
    if (!pool) {
      throw new Error(`no pool for ${pair.from}->${pair.to}`);
    }
    return pool;
  }

  has(pair: SwapPair): boolean {
    return this.pools.has(pairKey(pair.from, pair.to));
  }
}
