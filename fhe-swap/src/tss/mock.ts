import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { chainOf, type Asset, type Chain } from "../assets.js";
import type { ThresholdSigner } from "../chains/types.js";
import {
  suiteForAsset,
  type TssMember,
  type TssPartialSignature,
  type TssSignRequest,
  type TssSigner,
  type TssSuite,
} from "./types.js";

/**
 * Mock TSS member.
 *
 * Uses real ed25519 signatures as *authorization approvals* so tests can verify
 * threshold membership. This is NOT a FROST partial signature and must not be
 * described as one. A real chain-specific signer would replace this mock.
 */
export class MockTssMember implements TssMember {
  readonly id: string;
  readonly publicKeyPem: string;
  private readonly privateKeyPem: string;

  constructor(id: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.id = id;
    this.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  async signPartial(messageHash: Buffer): Promise<TssPartialSignature> {
    const signature = cryptoSign(null, messageHash, this.privateKeyPem);
    return { memberId: this.id, signature: signature.toString("base64") };
  }

  verify(messageHash: Buffer, partial: TssPartialSignature): boolean {
    if (partial.memberId !== this.id) return false;
    return cryptoVerify(
      null,
      messageHash,
      this.publicKeyPem,
      Buffer.from(partial.signature, "base64"),
    );
  }
}

/**
 * Mock threshold cluster implementing the legacy ThresholdSigner interface.
 * It collects t-of-n member approvals, then emits a mock signed transaction.
 */
export class MockTssCluster implements ThresholdSigner, TssSigner {
  readonly suite: TssSuite;

  constructor(
    private readonly members: MockTssMember[],
    private readonly threshold: number,
    suite?: TssSuite,
  ) {
    if (threshold < 2 || threshold > members.length) {
      throw new Error("invalid TSS threshold");
    }
    this.suite = suite ?? "frost-secp256k1";
  }

  static create(
    n: number,
    t: number,
    suite: TssSuite = "frost-secp256k1",
  ): MockTssCluster {
    const members = Array.from({ length: n }, (_, i) => new MockTssMember(`member-${i + 1}`));
    return new MockTssCluster(members, t, suite);
  }

  async sign(
    chain: Chain,
    asset: Asset,
    unsignedTx: string,
  ): Promise<{ rawTx: string; txHash: string }> {
    const suite = suiteForAsset(asset);
    return this.signRequest({
      chain,
      asset,
      suite,
      unsignedTx,
      vaultConfirmed: true,
    });
  }

  async signRequest(
    req: TssSignRequest,
  ): Promise<{ rawTx: string; txHash: string }> {
    if (!req.vaultConfirmed) {
      throw new Error("vault inbound must be confirmed before TSS signing");
    }
    if (chainOf(req.asset) !== req.chain) throw new Error("mock signing chain/asset mismatch");
    const expectedSuite = suiteForAsset(req.asset);
    if (req.suite !== expectedSuite) {
      throw new Error(`asset ${req.asset} requires suite ${expectedSuite}`);
    }

    const messageHash = createHash("sha256")
      .update(`${req.chain}:${req.asset}:${req.suite}:${req.unsignedTx}`)
      .digest();

    const approvals: TssPartialSignature[] = [];
    for (const member of this.members) {
      if (approvals.length >= this.threshold) break;
      const partial = await member.signPartial(messageHash);
      if (!member.verify(messageHash, partial)) {
        throw new Error(`invalid mock approval from ${member.id}`);
      }
      approvals.push(partial);
    }
    if (approvals.length < this.threshold) {
      throw new Error("not enough TSS approvals");
    }

    // Pack local approvals, not a signature accepted by the destination chain.
    const approvalBlob = Buffer.from(JSON.stringify(approvals)).toString("base64");
    const rawTx = `tss:${req.suite}:${req.chain}:${req.asset}:${approvalBlob}:${req.unsignedTx}`;
    const txHash = createHash("sha256").update(rawTx).digest("hex");
    return { rawTx, txHash };
  }
}
