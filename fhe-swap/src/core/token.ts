/**
 * Native project token.
 *
 * The external asset allow-list remains exactly BTC, ETH, XMR, ZEC, DAI.
 * NYX is an internal settlement/security/fee asset, not a sixth external
 * swap asset. Users do not route NYX as an external deposit/withdraw asset in
 * this reference implementation.
 */
export const HUB_TOKEN = "NYX" as const;
export type HubToken = typeof HUB_TOKEN;

export const HUB_DECIMALS = 8;
export const HUB_UNIT = 10n ** BigInt(HUB_DECIMALS);

export interface FeeSplit {
  /** Burned / permanently removed from circulating supply. */
  burnBps: number;
  /** Distributed to bonded vault nodes. */
  bondRewardsBps: number;
  /** Protocol-owned liquidity, retained in NYX. */
  polBps: number;
}

export const DEFAULT_FEE_SPLIT: FeeSplit = {
  burnBps: 5_000,
  bondRewardsBps: 4_000,
  polBps: 1_000,
};

export function assertFeeSplit(split: FeeSplit): void {
  const parts = [split.burnBps, split.bondRewardsBps, split.polBps];
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0 || p > 10_000) {
      throw new Error("fee split parts must be integer bps in [0, 10000]");
    }
  }
  if (parts.reduce((a, b) => a + b, 0) !== 10_000) {
    throw new Error("fee split must sum to 10000 bps");
  }
}

export interface TreasuryBalance {
  collectedNyxThor: bigint;
  burnedNyxThor: bigint;
  bondRewardsNyxThor: bigint;
  polNyxThor: bigint;
}

/**
 * Simple NYX fee sink.
 *
 * Swap fees are collected in NYX from the intermediate hub leg, then split.
 * This is a reference accounting object, not an on-chain token contract.
 */
export class TokenTreasury {
  private balance: TreasuryBalance = {
    collectedNyxThor: 0n,
    burnedNyxThor: 0n,
    bondRewardsNyxThor: 0n,
    polNyxThor: 0n,
  };

  constructor(private readonly split: FeeSplit = DEFAULT_FEE_SPLIT) {
    assertFeeSplit(split);
  }

  collectFeeNyx(amountThor: bigint): TreasuryBalance {
    if (amountThor < 0n) throw new Error("negative fee");
    const burn = (amountThor * BigInt(this.split.burnBps)) / 10_000n;
    const bond = (amountThor * BigInt(this.split.bondRewardsBps)) / 10_000n;
    const pol = amountThor - burn - bond;
    this.balance.collectedNyxThor += amountThor;
    this.balance.burnedNyxThor += burn;
    this.balance.bondRewardsNyxThor += bond;
    this.balance.polNyxThor += pol;
    return this.snapshot();
  }

  snapshot(): TreasuryBalance {
    return { ...this.balance };
  }
}
