import type { Asset } from "../assets.js";
import type { EncryptedVector } from "../fhe/types.js";

export interface SwapPair {
  from: Asset;
  to: Asset;
}

/**
 * Public routing header. Amounts/limits are encrypted, but this header is not:
 * the matcher can see the asset pair, destination, refund address, deadline and
 * memo hash. Use fresh addresses and treat the header as linkable metadata.
 */
export interface SwapIntentHeader {
  id: string;
  pair: SwapPair;
  /** Destination address on the target chain. Public by necessity at settlement. */
  destination: string;
  /** Refund address on the source chain. */
  refundAddress: string;
  /** Unix seconds. */
  deadline: number;
  /** Optional memo hash / stealth tag. Do not put plaintext identity here. */
  memoHash?: string;
}

export interface EncryptedSwapPayload {
  /** Logical vector layout: [amountThor, amountThor, minOutThor, salt] */
  values: EncryptedVector;
  /** Plain layout metadata, no secrets. */
  layout: "amount2_minout_salt_v1";
}

export interface EncryptedSwapIntent {
  header: SwapIntentHeader;
  payload: EncryptedSwapPayload;
}

export interface PoolQuote {
  pair: SwapPair;
  /** Output per 1 unit input, scaled by PRICE_SCALE. */
  priceScaled: bigint;
  /** Fee in basis points taken from output. */
  feeBps: number;
  /** Max input in thor units the pool will accept for this quote. */
  maxInputThor: bigint;
}

export interface EncryptedQuote {
  intentId: string;
  /** Encrypted vector: [netOutScaled, feeScaled, 0, salt] */
  values: EncryptedVector;
  /** Public multiplier used by the matcher, for audit. */
  netMultiplier: bigint;
  feeMultiplier: bigint;
  priceScaled: bigint;
  feeBps: number;
  maxInputThor: bigint;
}

export interface DecryptedQuote {
  intentId: string;
  /** Net output in thor units after fee. */
  netOutThor: bigint;
  /** Fee in output thor units. */
  feeThor: bigint;
  /** Whether the user's encrypted minOut was satisfied (checked client-side). */
  meetsMinOut: boolean;
}
