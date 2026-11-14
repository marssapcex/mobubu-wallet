import type { Asset, Chain } from "../assets.js";
import type {
  InboundObservation,
  OutboundInstruction,
  SignedOutbound,
} from "../core/types.js";

export interface ChainAdapter {
  readonly chain: Chain;
  readonly assets: readonly Asset[];

  vaultAddress(asset: Asset): string;
  requiredConfirmations(asset: Asset): number;

  /** Watch-only inbound scan for a vault deposit carrying the intent memo. */
  scanInbound(intentId: string, asset: Asset): Promise<InboundObservation | null>;
  getConfirmations(txHash: string): Promise<number>;

  /** Build an unsigned outbound transaction from vault funds. */
  buildOutbound(instruction: OutboundInstruction): Promise<string>;
  broadcast(rawTx: string): Promise<string>;
}

/**
 * Threshold vault signer (Serai-style FROST / THORChain-style TSS slot).
 * The private key never lives in this process; signing is delegated to a
 * threshold cluster or hardware signer.
 */
export interface ThresholdSigner {
  sign(
    chain: Chain,
    asset: Asset,
    unsignedTx: string,
  ): Promise<{ rawTx: string; txHash: string }>;
}

export class MockThresholdSigner implements ThresholdSigner {
  async sign(
    chain: Chain,
    asset: Asset,
    unsignedTx: string,
  ): Promise<{ rawTx: string; txHash: string }> {
    const { createHash } = await import("node:crypto");
    const rawTx = `signed:${chain}:${asset}:${unsignedTx}`;
    const txHash = createHash("sha256").update(rawTx).digest("hex");
    return { rawTx, txHash };
  }
}
