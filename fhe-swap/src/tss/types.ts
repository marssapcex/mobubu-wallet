import type { Asset, Chain } from "../assets.js";

/**
 * Threshold signature suites.
 *
 * - BTC: FROST over secp256k1 for Schnorr/taproot-style vault outputs
 *   (reference interface only). Legacy P2WPKH vaults would need ECDSA TSS.
 * - ETH (Ethereum), BNB (BNB Smart Chain): threshold ECDSA over secp256k1 for
 *   native EVM transactions. Same signing suite, separate chain/vault policy.
 *
 * This codebase does NOT implement audited FROST/ECDSA-TSS. It defines
 * the orchestration boundary and a mock threshold cluster for local settlement
 * tests.
 */
export type TssSuite =
  | "frost-secp256k1"
  | "ecdsa-secp256k1";

export function suiteForAsset(asset: Asset): TssSuite {
  switch (asset) {
    case "BTC":
      return "frost-secp256k1";
    case "ETH":
    case "BNB":
      return "ecdsa-secp256k1";
    default: {
      const exhaustive: never = asset;
      throw new Error(`unsupported asset ${exhaustive}`);
    }
  }
}

export interface TssPartialSignature {
  memberId: string;
  /** base64 mock partial signature / approval. */
  signature: string;
}

export interface TssMember {
  readonly id: string;
  readonly publicKeyPem: string;
  signPartial(messageHash: Buffer): Promise<TssPartialSignature>;
}

export interface TssSignRequest {
  chain: Chain;
  asset: Asset;
  suite: TssSuite;
  unsignedTx: string;
  /** Vault inbound must already be confirmed before signing. */
  vaultConfirmed: boolean;
}

export interface TssSigner {
  readonly suite: TssSuite;
  /** Named differently from legacy ThresholdSigner.sign to avoid overload clash. */
  signRequest(request: TssSignRequest): Promise<{ rawTx: string; txHash: string }>;
}
