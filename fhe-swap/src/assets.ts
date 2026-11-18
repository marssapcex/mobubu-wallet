/**
 * Hard asset allow-list.
 *
 * The protocol ONLY supports these five assets. Anything else is rejected at
 * the boundary (intent creation, vault routing, settlement). This is a deliberate
 * constraint from the spec: BTC, ETH, XMR, ZEC, DAI. No RUNE, no synthetic assets,
 * no wrapped derivatives beyond DAI (which is an ERC-20 on Ethereum).
 */

export const SUPPORTED_ASSETS = ["BTC", "ETH", "XMR", "ZEC", "DAI"] as const;
export type Asset = (typeof SUPPORTED_ASSETS)[number];

export type Chain = "bitcoin" | "ethereum" | "monero" | "zcash";

export interface AssetMeta {
  asset: Asset;
  chain: Chain;
  /** Base-unit decimals (e.g. BTC has 8 -> 1 BTC = 100_000_000 sats). */
  decimals: number;
  /** Whether the base chain has native shielded transfers. */
  shielded: boolean;
  /** DAI settles on Ethereum as an ERC-20; everything else is native. */
  erc20?: { contract: string };
  /** Human label. */
  name: string;
}

export const ASSET_META: Record<Asset, AssetMeta> = {
  BTC: {
    asset: "BTC",
    chain: "bitcoin",
    decimals: 8,
    shielded: false,
    name: "Bitcoin",
  },
  ETH: {
    asset: "ETH",
    chain: "ethereum",
    decimals: 18,
    shielded: false,
    name: "Ether",
  },
  XMR: {
    asset: "XMR",
    chain: "monero",
    decimals: 12,
    shielded: true,
    name: "Monero",
  },
  ZEC: {
    asset: "ZEC",
    chain: "zcash",
    decimals: 8,
    shielded: true,
    name: "Zcash",
  },
  DAI: {
    asset: "DAI",
    chain: "ethereum",
    decimals: 18,
    shielded: false,
    // Mainnet MakerDAO DAI. Override via config for testnets.
    erc20: { contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    name: "Dai Stablecoin",
  },
};

export class UnsupportedAssetError extends Error {
  constructor(value: string) {
    super(
      `Unsupported asset "${value}". Allowed: ${SUPPORTED_ASSETS.join(", ")}.`,
    );
    this.name = "UnsupportedAssetError";
  }
}

export function isAsset(value: unknown): value is Asset {
  return (
    typeof value === "string" &&
    (SUPPORTED_ASSETS as readonly string[]).includes(value)
  );
}

export function assertAsset(value: unknown): Asset {
  if (!isAsset(value)) {
    throw new UnsupportedAssetError(String(value));
  }
  return value;
}

export function meta(asset: Asset): AssetMeta {
  return ASSET_META[asset];
}

export function chainOf(asset: Asset): Chain {
  return ASSET_META[asset].chain;
}

/** Convert a human amount string to base units (bigint). */
export function toBaseUnits(asset: Asset, human: string): bigint {
  const { decimals } = meta(asset);
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${human}" for ${asset}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${human}" has more than ${decimals} decimal places for ${asset}`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Convert base units (bigint) to a human decimal string. */
export function fromBaseUnits(asset: Asset, units: bigint): string {
  const { decimals } = meta(asset);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** All ordered cross-asset pairs (no self-swaps). */
export function allPairs(): Array<[Asset, Asset]> {
  const pairs: Array<[Asset, Asset]> = [];
  for (const a of SUPPORTED_ASSETS) {
    for (const b of SUPPORTED_ASSETS) {
      if (a !== b) pairs.push([a, b]);
    }
  }
  return pairs;
}
