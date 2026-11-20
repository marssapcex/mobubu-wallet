import type { FheClient, FheEvaluator } from "../fhe/types.js";
import type {
  DecryptedQuote,
  EncryptedQuote,
  EncryptedSwapIntent,
  PoolQuote,
} from "./types.js";
import { assertIntentId } from "./intent.js";
import { PRICE_SCALE } from "./units.js";

const BPS_DENOMINATOR = 10_000n;

function assertPoolQuote(pool: PoolQuote): void {
  if (!Number.isInteger(pool.feeBps) || pool.feeBps < 0 || pool.feeBps >= 10_000) {
    throw new Error("feeBps out of range");
  }
  if (pool.priceScaled <= 0n) {
    throw new Error("priceScaled must be positive");
  }
  if (pool.maxInputThor <= 0n) {
    throw new Error("maxInputThor must be positive");
  }
}

/**
 * Encrypted intent matcher.
 *
 * The matcher never sees amount/minOut. It multiplies the encrypted amount slot
 * by public pool multipliers. The client later decrypts and checks minOut.
 *
 * Layout in:  [amountThor, amountThor, minOutThor, salt]
 * Layout out: [netOutScaled, feeScaled, 0, salt]
 *
 * Proposition (implemented by `quote` and checked by `decryptQuote`):
 *   netOutScaled = amountThor * priceScaled * (10000 - feeBps)
 *   feeScaled    = amountThor * priceScaled * feeBps
 *   netOutThor   = floor(netOutScaled / (PRICE_SCALE * 10000))
 *   feeThor      = floor(feeScaled / (PRICE_SCALE * 10000))
 *
 * To stay inside the BFV plaintext modulus, the matcher uses integer
 * multipliers and the client performs the final division by PRICE_SCALE*BPS.
 */
export class EncryptedMatcher {
  constructor(private readonly evaluator: FheEvaluator) {}

  quote(intent: EncryptedSwapIntent, pool: PoolQuote): EncryptedQuote {
    assertIntentId(intent);
    if (
      intent.header.pair.from !== pool.pair.from ||
      intent.header.pair.to !== pool.pair.to
    ) {
      throw new Error("pool pair mismatch");
    }
    assertPoolQuote(pool);

    const feeBps = BigInt(pool.feeBps);
    const netMultiplier = pool.priceScaled * (BPS_DENOMINATOR - feeBps);
    const feeMultiplier = pool.priceScaled * feeBps;

    // Public safety bound. The matcher cannot inspect the encrypted amount, so
    // the pool publishes maxInputThor and clients must respect it. A production
    // TFHE backend would add an encrypted range proof / comparison.
    const maxProduct = pool.maxInputThor * (netMultiplier + feeMultiplier);
    if (maxProduct >= this.evaluator.plainModulus) {
      throw new Error(
        "pool parameters overflow FHE plaintext modulus; reduce maxInputThor or priceScaled",
      );
    }

    if (intent.payload.layout !== "amount2_minout_salt_v1") {
      throw new Error("unknown payload layout");
    }
    if (intent.payload.values.slotCount !== 4) {
      throw new Error("expected 4-slot intent payload");
    }

    // Slot 0/1 are duplicate encrypted amounts. Multiply slot 0 by the net
    // multiplier and slot 1 by the fee multiplier. Zero minOut, preserve salt.
    const values = this.evaluator.multiplyPlain(intent.payload.values, [
      netMultiplier,
      feeMultiplier,
      0n,
      1n,
    ]);

    return {
      intentId: intent.header.id,
      values,
      netMultiplier,
      feeMultiplier,
      priceScaled: pool.priceScaled,
      feeBps: pool.feeBps,
      maxInputThor: pool.maxInputThor,
    };
  }
}

/**
 * Client-side quote opening. Besides decrypting, this verifies the public
 * arithmetic for the reported terms. This does not authenticate the price or authorize settlement.
 */
export function decryptQuote(
  client: FheClient,
  intent: EncryptedSwapIntent,
  quote: EncryptedQuote,
): DecryptedQuote {
  assertIntentId(intent);
  if (quote.intentId !== intent.header.id) {
    throw new Error("quote intent id mismatch");
  }
  if (intent.payload.layout !== "amount2_minout_salt_v1") {
    throw new Error("unknown payload layout");
  }
  if (intent.payload.values.slotCount !== 4 || quote.values.slotCount !== 4) {
    throw new Error("expected 4-slot intent/quote payload");
  }
  if (
    !Number.isInteger(quote.feeBps) ||
    quote.feeBps < 0 ||
    quote.feeBps >= 10_000
  ) {
    throw new Error("quote feeBps out of range");
  }
  if (quote.priceScaled <= 0n || quote.maxInputThor <= 0n) {
    throw new Error("invalid quote price/maxInput");
  }

  const feeBps = BigInt(quote.feeBps);
  const expectedNetMultiplier = quote.priceScaled * (BPS_DENOMINATOR - feeBps);
  const expectedFeeMultiplier = quote.priceScaled * feeBps;
  if (
    quote.netMultiplier !== expectedNetMultiplier ||
    quote.feeMultiplier !== expectedFeeMultiplier
  ) {
    throw new Error("quote multipliers do not match price/fee");
  }

  const [amountThor, amountCopy, minOutThor, salt] = client.decrypt(
    intent.payload.values,
  );
  const [netOutScaled, feeScaled, zeroSlot, quoteSalt] = client.decrypt(
    quote.values,
  );

  if (amountCopy !== amountThor) {
    throw new Error("corrupt intent payload: amount slots differ");
  }
  if (amountThor <= 0n || minOutThor < 0n) {
    throw new Error("corrupt intent payload: invalid amount/minOut");
  }
  if (amountThor > quote.maxInputThor) {
    throw new Error("intent amount exceeds quote maxInputThor");
  }
  if (zeroSlot !== 0n || quoteSalt !== salt) {
    throw new Error("quote does not preserve intent layout/salt");
  }
  if (netOutScaled !== amountThor * quote.netMultiplier) {
    throw new Error("quote net output arithmetic mismatch");
  }
  if (feeScaled !== amountThor * quote.feeMultiplier) {
    throw new Error("quote fee arithmetic mismatch");
  }
  if (amountThor * (quote.netMultiplier + quote.feeMultiplier) >= client.plainModulus) {
    throw new Error("quote product overflows FHE plaintext modulus");
  }

  const divisor = PRICE_SCALE * BPS_DENOMINATOR;
  const netOutThor = netOutScaled / divisor;
  const feeThor = feeScaled / divisor;

  return {
    intentId: quote.intentId,
    netOutThor,
    feeThor,
    meetsMinOut: netOutThor >= minOutThor,
  };
}

export function expectedNetOutThor(
  amountThor: bigint,
  pool: PoolQuote,
): bigint {
  assertPoolQuote(pool);
  const feeBps = BigInt(pool.feeBps);
  return (
    (amountThor * pool.priceScaled * (BPS_DENOMINATOR - feeBps)) /
    (PRICE_SCALE * BPS_DENOMINATOR)
  );
}

export function expectedFeeThor(amountThor: bigint, pool: PoolQuote): bigint {
  assertPoolQuote(pool);
  const feeBps = BigInt(pool.feeBps);
  return (
    (amountThor * pool.priceScaled * feeBps) /
    (PRICE_SCALE * BPS_DENOMINATOR)
  );
}
