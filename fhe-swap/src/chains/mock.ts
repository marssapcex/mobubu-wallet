import { createHash } from "node:crypto";
import type { Asset, Chain } from "../assets.js";
import type {
  InboundObservation,
  OutboundInstruction,
} from "../core/types.js";
import type { ChainAdapter } from "./types.js";

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
    this.assets = opts.assets;
    for (const asset of opts.assets) {
      const vault = opts.vaults[asset];
      if (!vault) throw new Error(`missing mock vault for ${asset}`);
      this.vaults.set(asset, vault);
    }
  }

  vaultAddress(asset: Asset): string {
    const vault = this.vaults.get(asset);
    if (!vault) throw new Error(`asset ${asset} not on ${this.chain}`);
    return vault.address;
  }

  requiredConfirmations(asset: Asset): number {
    const vault = this.vaults.get(asset);
    if (!vault) throw new Error(`asset ${asset} not on ${this.chain}`);
    return vault.confirmations;
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
    this.inbound.set(obs.intentId, obs);
    this.confirmations.set(obs.txHash, obs.confirmations);
  }

  setConfirmations(txHash: string, n: number): void {
    this.confirmations.set(txHash, n);
  }

  async scanInbound(
    intentId: string,
    asset: Asset,
  ): Promise<InboundObservation | null> {
    const obs = this.inbound.get(intentId) ?? null;
    if (!obs) return null;
    if (!this.assets.includes(asset)) return null;
    return obs;
  }

  async getConfirmations(txHash: string): Promise<number> {
    return this.confirmations.get(txHash) ?? 0;
  }

  async buildOutbound(instruction: OutboundInstruction): Promise<string> {
    return JSON.stringify({
      chain: this.chain,
      asset: instruction.asset,
      from: this.vaultAddress(instruction.asset),
      to: instruction.to,
      amountBaseUnits: instruction.amountBaseUnits.toString(),
      memoHash: instruction.memoHash ?? null,
      intentId: instruction.intentId,
    });
  }

  async broadcast(rawTx: string): Promise<string> {
    const txHash = createHash("sha256").update(rawTx).digest("hex");
    this.mempool.set(txHash, rawTx);
    this.confirmations.set(txHash, 1);
    return txHash;
  }

  hasBroadcast(txHash: string): boolean {
    return this.mempool.has(txHash);
  }
}
