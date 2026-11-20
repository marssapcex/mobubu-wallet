import { randomBytes, createHash } from "node:crypto";
import { assertAsset, toBaseUnits, type Asset } from "../assets.js";
import type { FheClient } from "../fhe/types.js";
import type {
  EncryptedSwapIntent,
  SwapIntentHeader,
  SwapPair,
} from "./types.js";
import { toThorUnitsExact } from "./units.js";

export interface CreateIntentInput {
  from: Asset;
  to: Asset;
  /** Human decimal amount, e.g. "0.1". */
  amount: string;
  /** Human decimal minimum output. */
  minOut: string;
  destination: string;
  refundAddress: string;
  /** Unix seconds. */
  deadline: number;
  memoHash?: string;
}

export function makePair(from: unknown, to: unknown): SwapPair {
  const f = assertAsset(from);
  const t = assertAsset(to);
  if (f === t) {
    throw new Error("self-swap is not supported");
  }
  return { from: f, to: t };
}

/**
 * Intent id binds the public header to the exact encrypted payload. Including
 * the randomized ciphertext prevents two different encrypted amounts with the
 * same public header from colliding.
 */
export function intentId(
  header: Omit<SwapIntentHeader, "id">,
  payloadCiphertext: string,
): string {
  const canon = JSON.stringify({
    pair: { from: header.pair.from, to: header.pair.to },
    destination: header.destination,
    refundAddress: header.refundAddress,
    deadline: header.deadline,
    memoHash: header.memoHash ?? null,
    payload: payloadCiphertext,
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/** Internal consistency check, not authentication of a price or an order. */
export function assertIntentId(intent: EncryptedSwapIntent): void {
  makePair(intent.header.pair.from, intent.header.pair.to);
  if (intent.header.id !== intentId(intent.header, intent.payload.values.ciphertext)) {
    throw new Error("intent id does not bind header to encrypted payload");
  }
}

export function createEncryptedIntent(
  client: FheClient,
  input: CreateIntentInput,
): EncryptedSwapIntent {
  const pair = makePair(input.from, input.to);
  if (!input.destination || !input.refundAddress) {
    throw new Error("destination and refundAddress are required");
  }
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= 0) {
    throw new Error("deadline must be a positive unix timestamp in seconds");
  }

  const amountBase = toBaseUnits(pair.from, input.amount);
  const minOutBase = toBaseUnits(pair.to, input.minOut);
  const amountThor = toThorUnitsExact(pair.from, amountBase);
  const minOutThor = toThorUnitsExact(pair.to, minOutBase);
  if (amountThor <= 0n) throw new Error("amount must be positive");
  if (amountThor >= client.plainModulus) {
    throw new Error("amount exceeds FHE plaintext modulus");
  }
  if (minOutThor >= client.plainModulus) {
    throw new Error("minOut exceeds FHE plaintext modulus");
  }

  // Keep a randomized layout marker for the client-side consistency check.
  const salt =
    randomBytes(16).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n) %
    client.plainModulus;

  // Slot 0 and slot 1 both carry amount so the matcher can compute net output
  // and fee in parallel without rotations/Galois keys. Slot 2 carries minOut.
  const values = client.encrypt([amountThor, amountThor, minOutThor, salt]);

  const headerBase = {
    pair,
    destination: input.destination,
    refundAddress: input.refundAddress,
    deadline: input.deadline,
    memoHash: input.memoHash,
  };
  const header: SwapIntentHeader = {
    id: intentId(headerBase, values.ciphertext),
    ...headerBase,
  };

  return {
    header,
    payload: { values, layout: "amount2_minout_salt_v1" },
  };
}

export function decryptIntentAmounts(
  client: FheClient,
  intent: EncryptedSwapIntent,
): { amountThor: bigint; minOutThor: bigint; salt: bigint } {
  assertIntentId(intent);
  if (intent.payload.layout !== "amount2_minout_salt_v1") {
    throw new Error("unknown payload layout");
  }
  if (intent.payload.values.slotCount !== 4) {
    throw new Error("expected 4-slot intent payload");
  }
  const [amountThor, amountCopy, minOutThor, salt] = client.decrypt(
    intent.payload.values,
  );
  if (amountCopy !== amountThor) {
    throw new Error("corrupt intent payload: amount slots differ");
  }
  if (amountThor <= 0n || minOutThor < 0n) {
    throw new Error("corrupt intent payload: invalid amount/minOut");
  }
  return { amountThor, minOutThor, salt };
}
