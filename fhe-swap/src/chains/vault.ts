import { randomBytes, createHash } from "node:crypto";
import type { Asset, Chain } from "../assets.js";

/**
 * One-time vault deposit addresses.
 *
 * THORChain-style memos put the swap destination/limit on the public L1 leg.
 * This reference instead binds a random deposit tag to a fresh vault address.
 * The address is not derived from the plaintext order, destination, or refund
 * address. The vault committee keeps the private mapping tag -> order.
 *
 * This is an address-book reference, not a real HD wallet / FROST vault key
 * derivation. Production must derive chain-valid one-time addresses from the
 * threshold vault public key and must never reuse them.
 */
export interface OneTimeVaultDeposit {
  orderId: string;
  depositTag: string;
  chain: Chain;
  asset: Asset;
  address: string;
  createdAt: number;
  used: boolean;
}

export class OneTimeVaultBook {
  private byAddress = new Map<string, OneTimeVaultDeposit>();
  private byOrder = new Map<string, OneTimeVaultDeposit>();

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  allocate(
    orderId: string,
    depositTag: string,
    chain: Chain,
    asset: Asset,
  ): OneTimeVaultDeposit {
    const key = `${orderId}:${chain}:${asset}`;
    const existing = this.byOrder.get(key);
    if (existing) {
      if (existing.used) throw new Error("one-time vault deposit already used");
      return existing;
    }
    const salt = randomBytes(16).toString("hex");
    const digest = createHash("sha256")
      .update(`${chain}:${asset}:${depositTag}:${salt}`)
      .digest("hex")
      .slice(0, 32);
    const address = `otv-${chain}-${asset}-${digest}`;
    const deposit: OneTimeVaultDeposit = {
      orderId,
      depositTag,
      chain,
      asset,
      address,
      createdAt: this.now(),
      used: false,
    };
    this.byAddress.set(address, deposit);
    this.byOrder.set(key, deposit);
    return deposit;
  }

  resolve(address: string): OneTimeVaultDeposit | undefined {
    return this.byAddress.get(address);
  }

  markUsed(address: string): void {
    const deposit = this.byAddress.get(address);
    if (!deposit) throw new Error("unknown one-time vault address");
    if (deposit.used) throw new Error("one-time vault address already used");
    deposit.used = true;
  }

  forOrder(orderId: string): OneTimeVaultDeposit[] {
    return [...this.byOrder.values()].filter((d) => d.orderId === orderId);
  }
}
