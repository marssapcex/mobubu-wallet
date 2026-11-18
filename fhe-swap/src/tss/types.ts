import type { Asset, Chain } from "../assets.js";

/**
 * Threshold signature suites.
 *
 * - BTC: FROST over secp256k1 for Schnorr/taproot-style vault outputs
 *   (reference interface only). Legacy P2WPKH vaults would need ECDSA TSS.
 * - ETH/DAI: threshold ECDSA over secp256k1. FROST produces Schnorr signatures,
 *   which Ethereum does not verify natively; do not claim FROST signs ETH.
 * - XMR: FROSTLASS / threshold CLSAG, as formalized by Cypher Stack and
 *   implemented in monero-oxide.
 * - ZEC: experimental threshold spend-auth path; shielded Zcash production
 *   signing also requires Sapling/Orchard proof machinery.
 *
 * This codebase does NOT implement audited FROST/FROSTLASS/ECDSA-TSS. It defines
 * the orchestration boundary and a mock threshold cluster for local settlement
 * tests.
 */
export type TssSuite =
  | "frost-secp256k1"
  | "ecdsa-secp256k1"
  | "frostlass-clsag"
  | "frost-ed25519-experimental";

export function suiteForAsset(asset: Asset): TssSuite {
  switch (asset) {
    case "BTC":
      return "frost-secp256k1";
    case "ETH":
    case "DAI":
      return "ecdsa-secp256k1";
    case "XMR":
      return "frostlass-clsag";
    case "ZEC":
      return "frost-ed25519-experimental";
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
