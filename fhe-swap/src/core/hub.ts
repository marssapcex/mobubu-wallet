import { assertAsset, type Asset } from "../assets.js";
import { HUB_TOKEN, TokenTreasury } from "./token.js";
import { PRICE_SCALE } from "./units.js";

/** BigInt integer square root (Newton). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export interface HubPoolConfig {
  /** External asset side of the pool. The other side is always NYX. */
  asset: Asset;
  reserveAssetThor: bigint;
  reserveNyxThor: bigint;
  /** Public reference price: NYX per 1 external asset, scaled by PRICE_SCALE. */
  referencePriceNyxPerAssetScaled: bigint;
  /** Cap for an external-asset input, in that asset's thor units. */
  maxInputThor: bigint;
  /** Cap for NYX input, in NYX thor units. Defaults to maxInputThor. */
  maxNyxInputThor?: bigint;
}

export interface HubSwapQuote {
  amountInThor: bigint;
  amountOutThor: bigint;
}

export interface ArbAction {
  asset: Asset;
  direction: "nyx-in-asset-out" | "asset-in-nyx-out";
  inputThor: bigint;
  outputThor: bigint;
  beforePriceScaled: bigint;
  afterPriceScaled: bigint;
}

/**
 * Constant-product external-asset/NYX hub pool.
 *
 * Proposition (constant-product output):
 *   out = floor(reserveOut * amountIn / (reserveIn + amountIn))
 *
 * This is a reference AMM used to exercise streaming/arb mechanics. It is not
 * THORChain's CLP slip-fee formula.
 */
export class HubPool {
  readonly asset: Asset;
  readonly referencePriceNyxPerAssetScaled: bigint;
  readonly maxInputThor: bigint;
  readonly maxNyxInputThor: bigint;

  private reserveAssetThor: bigint;
  private reserveNyxThor: bigint;

  constructor(cfg: HubPoolConfig) {
    this.asset = assertAsset(cfg.asset);
    if (cfg.reserveAssetThor <= 0n || cfg.reserveNyxThor <= 0n) {
      throw new Error("hub pool reserves must be positive");
    }
    if (cfg.referencePriceNyxPerAssetScaled <= 0n) {
      throw new Error("reference price must be positive");
    }
    const maxNyxInputThor = cfg.maxNyxInputThor ?? cfg.maxInputThor;
    if (cfg.maxInputThor <= 0n || maxNyxInputThor <= 0n) {
      throw new Error("pool input caps must be positive");
    }
    this.reserveAssetThor = cfg.reserveAssetThor;
    this.reserveNyxThor = cfg.reserveNyxThor;
    this.referencePriceNyxPerAssetScaled = cfg.referencePriceNyxPerAssetScaled;
    this.maxInputThor = cfg.maxInputThor;
    this.maxNyxInputThor = maxNyxInputThor;
  }

  reserves(): { assetThor: bigint; nyxThor: bigint } {
    return {
      assetThor: this.reserveAssetThor,
      nyxThor: this.reserveNyxThor,
    };
  }

  /** Snapshot for simulation; not a rollback of already committed streams. */
  snapshot(): { assetThor: bigint; nyxThor: bigint } {
    return this.reserves();
  }

  restore(snapshot: { assetThor: bigint; nyxThor: bigint }): void {
    if (snapshot.assetThor <= 0n || snapshot.nyxThor <= 0n) {
      throw new Error("invalid reserve snapshot");
    }
    this.reserveAssetThor = snapshot.assetThor;
    this.reserveNyxThor = snapshot.nyxThor;
  }

  /** Spot price: NYX per external asset, scaled by PRICE_SCALE. */
  priceNyxPerAssetScaled(): bigint {
    return (this.reserveNyxThor * PRICE_SCALE) / this.reserveAssetThor;
  }

  private assertInput(amountInThor: bigint, maxInputThor: bigint): void {
    if (amountInThor <= 0n) throw new Error("amount must be positive");
    if (amountInThor > maxInputThor) throw new Error(`amount exceeds input cap for ${this.asset} pool`);
  }

  quoteAssetToNyx(amountAssetThor: bigint): HubSwapQuote {
    this.assertInput(amountAssetThor, this.maxInputThor);
    const out =
      (this.reserveNyxThor * amountAssetThor) /
      (this.reserveAssetThor + amountAssetThor);
    return { amountInThor: amountAssetThor, amountOutThor: out };
  }

  quoteNyxToAsset(amountNyxThor: bigint): HubSwapQuote {
    this.assertInput(amountNyxThor, this.maxNyxInputThor);
    const out =
      (this.reserveAssetThor * amountNyxThor) /
      (this.reserveNyxThor + amountNyxThor);
    return { amountInThor: amountNyxThor, amountOutThor: out };
  }

  executeAssetToNyx(amountAssetThor: bigint): HubSwapQuote {
    const q = this.quoteAssetToNyx(amountAssetThor);
    if (q.amountOutThor <= 0n) throw new Error("zero output");
    this.reserveAssetThor += amountAssetThor;
    this.reserveNyxThor -= q.amountOutThor;
    return q;
  }

  executeNyxToAsset(amountNyxThor: bigint): HubSwapQuote {
    const q = this.quoteNyxToAsset(amountNyxThor);
    if (q.amountOutThor <= 0n) throw new Error("zero output");
    this.reserveNyxThor += amountNyxThor;
    this.reserveAssetThor -= q.amountOutThor;
    return q;
  }

  /**
   * Permissionless arb rebalance toward the public reference price.
   *
   * Proposition (perfect-arb target):
   *   reserveNyx / reserveAsset = referencePrice / PRICE_SCALE
   *
   * The simulated bot trades against the pool until the spot price returns to
   * the reference band. This models CEX/DEX arbitrageurs restoring depth between
   * streaming subswaps. It is not a real external venue connector.
   */
  rebalanceToReference(toleranceBps = 5): ArbAction | null {
    return this.rebalanceToPrice(this.referencePriceNyxPerAssetScaled, toleranceBps);
  }

  /**
   * Rebalance toward an external reference price supplied by an arb bot.
   * The pool does not trust the feed for clearing; it only exposes the trade.
   */
  rebalanceToPrice(ref: bigint, toleranceBps = 5): ArbAction | null {
    if (!Number.isInteger(toleranceBps) || toleranceBps < 0) {
      throw new Error("invalid tolerance");
    }
    if (ref <= 0n) throw new Error("reference price must be positive");
    const before = this.priceNyxPerAssetScaled();
    const diff = before > ref ? before - ref : ref - before;
    if (diff * 10_000n <= ref * BigInt(toleranceBps)) {
      return null;
    }

    const k = this.reserveAssetThor * this.reserveNyxThor;
    const buyAsset = before < ref;
    const [reserveIn, cap, reserveOut] = buyAsset
      ? [this.reserveNyxThor, this.maxNyxInputThor, this.reserveAssetThor]
      : [this.reserveAssetThor, this.maxInputThor, this.reserveNyxThor];
    const targetIn = isqrt(buyAsset ? (k * ref) / PRICE_SCALE : (k * PRICE_SCALE) / ref);
    const delta = targetIn - reserveIn;
    if (delta <= 0n) return null;
    const inputThor = delta > cap ? cap : delta;
    // The continuous target only proposes the input. Apply the pool's discrete
    // AMM quote, never overwrite with independently rounded target reserves.
    const { amountOutThor: outputThor } = buyAsset
      ? this.quoteNyxToAsset(inputThor) : this.quoteAssetToNyx(inputThor);
    if (outputThor <= 0n) return null;
    const priceAfter = buyAsset
      ? ((reserveIn + inputThor) * PRICE_SCALE) / (reserveOut - outputThor)
      : ((reserveOut - outputThor) * PRICE_SCALE) / (reserveIn + inputThor);
    const afterDiff = priceAfter > ref ? priceAfter - ref : ref - priceAfter;
    if (afterDiff >= diff) return null; // Discrete rounding can overshoot on small pools.

    if (buyAsset) this.executeNyxToAsset(inputThor);
    else this.executeAssetToNyx(inputThor);
    return {
      asset: this.asset,
      direction: buyAsset ? "nyx-in-asset-out" : "asset-in-nyx-out",
      inputThor,
      outputThor,
      beforePriceScaled: before,
      afterPriceScaled: this.priceNyxPerAssetScaled(),
    };
  }
}

export class HubPoolBook {
  private pools = new Map<Asset, HubPool>();

  add(pool: HubPool): void {
    if (this.pools.has(pool.asset)) {
      throw new Error(`duplicate hub pool for ${pool.asset}`);
    }
    this.pools.set(pool.asset, pool);
  }

  get(asset: Asset): HubPool {
    const pool = this.pools.get(assertAsset(asset));
    if (!pool) throw new Error(`no ${asset}/${HUB_TOKEN} hub pool`);
    return pool;
  }

  has(asset: Asset): boolean {
    return this.pools.has(asset);
  }

  all(): HubPool[] {
    return [...this.pools.values()];
  }
}

export interface RouteQuote {
  from: Asset;
  to: Asset;
  amountInThor: bigint;
  intermediateNyxThor: bigint;
  feeNyxThor: bigint;
  netOutThor: bigint;
}

/**
 * Two-leg hub router: external A -> NYX -> external B.
 *
 * Fee is charged in NYX on the intermediate amount:
 *   feeNyx = floor(intermediateNyx * feeBps / 10000)
 *   netOut = cp(intermediateNyx - feeNyx, NYX reserve of B, asset reserve of B)
 */
export class HubRouter {
  constructor(
    private readonly pools: HubPoolBook,
    private readonly feeBps: number,
    private readonly treasury?: TokenTreasury,
  ) {
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
      throw new Error("feeBps must be integer in [0, 10000)");
    }
  }

  quote(from: Asset, to: Asset, amountInThor: bigint): RouteQuote {
    assertAsset(from);
    assertAsset(to);
    if (from === to) throw new Error("self-swap is not supported");
    const poolFrom = this.pools.get(from);
    const poolTo = this.pools.get(to);

    const leg1 = poolFrom.quoteAssetToNyx(amountInThor);
    const intermediateNyxThor = leg1.amountOutThor;
    if (intermediateNyxThor <= 0n) throw new Error("zero intermediate NYX output");
    const feeNyxThor = (intermediateNyxThor * BigInt(this.feeBps)) / 10_000n;
    const nyxIntoLeg2 = intermediateNyxThor - feeNyxThor;
    if (nyxIntoLeg2 <= 0n) throw new Error("fee consumes intermediate output");
    const leg2 = poolTo.quoteNyxToAsset(nyxIntoLeg2);
    if (leg2.amountOutThor <= 0n) throw new Error("zero destination output");

    return {
      from,
      to,
      amountInThor,
      intermediateNyxThor,
      feeNyxThor,
      netOutThor: leg2.amountOutThor,
    };
  }

  execute(from: Asset, to: Asset, amountInThor: bigint): RouteQuote {
    const q = this.quote(from, to, amountInThor);
    const poolFrom = this.pools.get(from);
    const poolTo = this.pools.get(to);
    poolFrom.executeAssetToNyx(amountInThor);
    poolTo.executeNyxToAsset(q.intermediateNyxThor - q.feeNyxThor);
    this.treasury?.collectFeeNyx(q.feeNyxThor);
    return q;
  }
}
