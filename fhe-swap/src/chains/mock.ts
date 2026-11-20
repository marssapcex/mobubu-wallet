import { createHash } from "node:crypto";
import { chainOf, type Asset, type Chain } from "../assets.js";
import type { ChainAdapter, InboundObservation, OutboundInstruction } from "./types.js";

export interface MockVault {
  address: string;
  confirmations: number;
}

/**
 * Deterministic in-memory chain adapter for tests/local demo.
 * It does not contact real networks and never holds real private keys.
 */
export class MockChainAdapter implements ChainAdapter {
  readonly chain: Chain;
  readonly assets: readonly Asset[];

  private vaults = new Map<Asset, MockVault>();
  private inbound = new Map<string, InboundObservation>();
  private confirmations = new Map<string, number>();
  private mempool = new Map<string, string>();

  constructor(opts: {
    chain: Chain;
    assets: readonly Asset[];
    vaults: Partial<Record<Asset, MockVault>>;
  }) {
    this.chain = opts.chain;
    this.assets = Object.freeze([...opts.assets]);
    for (const asset of this.assets) {
      if (chainOf(asset) !== this.chain || this.vaults.has(asset)) throw new Error(`invalid asset ${asset} for mock ${this.chain}`);
      const vault = opts.vaults[asset];
      if (!vault) throw new Error(`missing mock vault for ${asset}`);
      this.vaults.set(asset, { ...vault });
    }
  }

  private vaultAddress(asset: Asset): string {
    const vault = this.vaults.get(asset);
    if (!vault) throw new Error(`asset ${asset} not on ${this.chain}`);
    return vault.address;
  }

  requiredConfirmations(asset: Asset): number {
    const vault = this.vaults.get(asset);
    if (!vault) throw new Error(`asset ${asset} not on ${this.chain}`);
    return vault.confirmations;
  }

  requiredOutboundConfirmations(asset: Asset): number {
    this.requiredConfirmations(asset); // Reject unsupported assets.
    return 1;
  }

  queueInbound(obs: InboundObservation): void {
    if (obs.chain !== this.chain) {
      throw new Error(`mock ${this.chain} cannot queue ${obs.chain} inbound`);
    }
    if (!this.assets.includes(obs.asset)) {
      throw new Error(`mock ${this.chain} cannot queue ${obs.asset} inbound`);
    }
    if (!obs.txHash) throw new Error("inbound txHash missing");
    if (obs.amountBaseUnits < 0n) throw new Error("inbound amount negative");
    if (!Number.isInteger(obs.confirmations) || obs.confirmations < 0) {
      throw new Error("inbound confirmations invalid");
    }
    this.inbound.set(obs.depositTag, { ...obs });
    this.confirmations.set(obs.txHash, obs.confirmations);
  }

  setConfirmations(txHash: string, n: number): void {
    this.confirmations.set(txHash, n);
  }

  async scanInbound(
    depositTag: string,
    asset: Asset,
  ): Promise<InboundObservation | null> {
    const obs = this.inbound.get(depositTag) ?? null;
    if (!obs) return null;
    if (obs.asset !== asset || !this.assets.includes(asset)) return null;
    return { ...obs };
  }

  async getConfirmations(txHash: string): Promise<number> {
    return this.confirmations.get(txHash) ?? 0;
  }

  async buildOutbound(instruction: OutboundInstruction): Promise<string> {
    if (instruction.chain !== this.chain) throw new Error("mock outbound chain mismatch");
    return JSON.stringify({
      chain: this.chain,
      asset: instruction.asset,
      from: this.vaultAddress(instruction.asset),
      to: instruction.to,
      amountBaseUnits: instruction.amountBaseUnits.toString(),
      memoHash: instruction.memoHash ?? null,
      orderId: instruction.orderId,
    });
  }

  async broadcast(rawTx: string): Promise<string> {
    const txHash = createHash("sha256").update(rawTx).digest("hex");
    this.mempool.set(txHash, rawTx);
    if (!this.confirmations.has(txHash)) this.confirmations.set(txHash, 1);
    return txHash;
  }

  hasBroadcast(txHash: string): boolean {
    return this.mempool.has(txHash);
  }
}
