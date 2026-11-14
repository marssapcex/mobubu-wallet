import { type Asset, meta } from "../assets.js";

/**
 * THORChain-style common precision: 8 decimals ("thor units").
 *
 * The FHE plaintext modulus is finite, so the prototype normalizes amounts to
 * 1e8 base units before encryption. This is enough for BTC/ZEC sats and gives a
 * workable fixed-point range for ETH/XMR/DAI in a reference implementation.
 * Production should use multi-limb ciphertexts or a TFHE integer backend.
 */
export const THOR_DECIMALS = 8;
export const THOR_UNIT = 10n ** BigInt(THOR_DECIMALS);

/** Convert base units to thor units, truncating sub-thor dust. */
export function toThorUnits(asset: Asset, baseUnits: bigint): bigint {
  const { decimals } = meta(asset);
  if (baseUnits < 0n) throw new RangeError("negative amount");
  if (decimals === THOR_DECIMALS) return baseUnits;
  if (decimals > THOR_DECIMALS) {
    const factor = 10n ** BigInt(decimals - THOR_DECIMALS);
    return baseUnits / factor;
  }
  const factor = 10n ** BigInt(THOR_DECIMALS - decimals);
  return baseUnits * factor;
}

/**
 * Convert base units to thor units and reject sub-thor dust. Intent creation
 * uses this so a user's amount/minOut is never silently rounded down.
 */
export function toThorUnitsExact(asset: Asset, baseUnits: bigint): bigint {
  const { decimals } = meta(asset);
  if (baseUnits < 0n) throw new RangeError("negative amount");
  if (decimals > THOR_DECIMALS) {
    const factor = 10n ** BigInt(decimals - THOR_DECIMALS);
    if (baseUnits % factor !== 0n) {
      throw new RangeError(
        `${asset} amount has sub-thor dust; use at most ${THOR_DECIMALS} decimals`,
      );
    }
  }
  return toThorUnits(asset, baseUnits);
}

export function fromThorUnits(asset: Asset, thorUnits: bigint): bigint {
  const { decimals } = meta(asset);
  if (thorUnits < 0n) throw new RangeError("negative amount");
  if (decimals === THOR_DECIMALS) return thorUnits;
  if (decimals > THOR_DECIMALS) {
    const factor = 10n ** BigInt(decimals - THOR_DECIMALS);
    return thorUnits * factor;
  }
  const factor = 10n ** BigInt(THOR_DECIMALS - decimals);
  return thorUnits / factor;
}

/**
 * Fixed-point scale used for encrypted price multiplication.
 *
 * The reference BFV backend has a finite plaintext modulus, so we keep the
 * multiplier small enough that `amountThor * priceScaled * 10000` stays below
 * the modulus for bounded pools. Production TFHE integer backends can raise
 * this or use multi-limb arithmetic.
 */
export const PRICE_SCALE = 10n ** 4n;

export function scalePrice(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return (numerator * PRICE_SCALE) / denominator;
}

export function unscale(scaled: bigint): bigint {
  return scaled / PRICE_SCALE;
}
