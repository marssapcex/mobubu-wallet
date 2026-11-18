import { ASSET_META } from "./asset-catalog.mjs";

// Streaming/BFV uses only the default network of each native coin. No wrapped aliases.
export { ASSET_META };
export type Asset = keyof typeof ASSET_META;
export type Chain = (typeof ASSET_META)[Asset]["chain"];
export const SUPPORTED_ASSETS = Object.freeze(Object.keys(ASSET_META) as Asset[]);

export interface AssetMeta {
  readonly asset: Asset;
  readonly chain: Chain;
  /** Base-unit decimals (e.g. BTC has 8 -> 1 BTC = 100_000_000 sats). */
  readonly decimals: number;
  /** Human label. */
  readonly name: string;
}

export class UnsupportedAssetError extends Error {
  constructor(value: string) {
    super(
      `Unsupported asset "${value}". Allowed: ${SUPPORTED_ASSETS.join(", ")}.`,
    );
    this.name = "UnsupportedAssetError";
  }
}

export function isAsset(value: unknown): value is Asset {
  return typeof value === "string" && Object.hasOwn(ASSET_META, value);
}

export function assertAsset(value: unknown): Asset {
  if (!isAsset(value)) {
    throw new UnsupportedAssetError(String(value));
  }
  return value;
}

export function meta(asset: Asset): AssetMeta {
  return ASSET_META[assertAsset(asset)];
}

export function chainOf(asset: Asset): Chain {
  return meta(asset).chain;
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
