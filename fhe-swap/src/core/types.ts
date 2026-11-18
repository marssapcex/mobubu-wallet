import type { Asset, Chain } from "../assets.js";
import type { EncryptedVector, PublicBundle } from "../fhe/types.js";

export type SwapState =
  | "created"
  | "inbound_observed"
  | "inbound_confirmed"
  | "outbound_signed"
  | "outbound_broadcast"
  | "completed"
  | "refunded"
  | "failed";

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

export interface InboundObservation {
  intentId: string;
  chain: Chain;
  asset: Asset;
  txHash: string;
  /** Observed amount in native base units. */
  amountBaseUnits: bigint;
  confirmations: number;
  /** Adapter clock convention; the engine does not rely on this field. */
  observedAt: number;
}

export interface OutboundInstruction {
  intentId: string;
  chain: Chain;
  asset: Asset;
  to: string;
  amountBaseUnits: bigint;
  memoHash?: string;
}

export interface SignedOutbound {
  intentId: string;
  chain: Chain;
  rawTx: string;
  txHash: string;
}

export interface SwapRecord {
  header: SwapIntentHeader;
  state: SwapState;
  inbound?: InboundObservation;
  outbound?: OutboundInstruction;
  signed?: SignedOutbound;
  quote?: EncryptedQuote;
  error?: string;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. */
  updatedAt: number;
}

export interface VaultConfig {
  asset: Asset;
  address: string;
  requiredConfirmations: number;
}

export interface ProtocolConfig {
  fhe: PublicBundle;
  vaults: VaultConfig[];
  /** If true, reject transparent->transparent swaps when strict privacy is requested. */
  requireShieldedLeg?: boolean;
}
