import type { Asset, Chain } from "../assets.js";

export interface InboundObservation {
  /** Mock deposit tag, not the sealed order ID. */
  depositTag: string;
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
  orderId: string;
  chain: Chain;
  asset: Asset;
  to: string;
  amountBaseUnits: bigint;
  memoHash?: string;
}

export interface SignedOutbound {
  orderId: string;
  chain: Chain;
  rawTx: string;
  txHash: string;
}

export interface ChainAdapter {
  readonly chain: Chain;
  readonly assets: readonly Asset[];

  requiredConfirmations(asset: Asset): number;
  /** Finality policy for outbound and refund; defaults to the inbound policy. */
  requiredOutboundConfirmations?(asset: Asset): number;

  /** Find the mock inbound associated with a deposit tag and asset. */
  scanInbound(depositTag: string, asset: Asset): Promise<InboundObservation | null>;
  getConfirmations(txHash: string): Promise<number>;

  /** Build an unsigned outbound transaction from vault funds. */
  buildOutbound(instruction: OutboundInstruction): Promise<string>;
  /** Retries of identical signed bytes must report the same canonical transaction ID. */
  broadcast(rawTx: string): Promise<string>;
}

/**
 * Mock settlement signing boundary. The implementation in this package issues
 * in-process approvals, not chain signatures or custody transactions.
 */
export interface ThresholdSigner {
  sign(
    chain: Chain,
    asset: Asset,
    unsignedTx: string,
  ): Promise<{ rawTx: string; txHash: string }>;
}
