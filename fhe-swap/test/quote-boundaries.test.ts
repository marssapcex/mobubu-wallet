import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SealFheClient, SealFheEvaluator } from "../src/fhe/seal.js";
import { createEncryptedIntent } from "../src/core/intent.js";
import { EncryptedMatcher, decryptQuote } from "../src/core/matcher.js";
import { ReferencePool } from "../src/core/pool.js";
import { toThorUnitsExact, fromThorUnits } from "../src/core/units.js";

describe("BFV quote boundaries", () => {
  let client: SealFheClient;
  let matcher: EncryptedMatcher;
  const pool = new ReferencePool({
    pair: { from: "BNB", to: "BTC" }, reserveInThor: 10_000_000_000n, reserveOutThor: 50_000_000n,
    feeBps: 30, maxInputThor: 1_000_000_000n,
  }).quote();

  before(async () => {
    client = await SealFheClient.create();
    matcher = new EncryptedMatcher(await SealFheEvaluator.fromBundle(client.publicBundle()));
  });

  function intent(amount = "1.0") {
    return createEncryptedIntent(client, {
      from: "BNB", to: "BTC", amount, minOut: "0.0049",
      destination: "btc-dest", refundAddress: "bnb-refund", deadline: 1_000_000,
    });
  }

  it("rejects sub-thor dust in intent amounts", () => {
    assert.throws(() => intent("0.000000000000000001"), /sub-thor dust/);
    for (const asset of ["ETH", "BNB"] as const) {
      assert.throws(() => toThorUnitsExact(asset, 1n), /sub-thor dust/);
      assert.equal(toThorUnitsExact(asset, 10n ** 10n), 1n);
      assert.equal(fromThorUnits(asset, 1n), 10n ** 10n);
    }
  });

  it("rejects inconsistent headers or ciphertexts before quoting/opening", () => {
    const a = intent(), b = intent("2.0");
    const quote = matcher.quote(a, pool);
    assert.notEqual(a.header.id, b.header.id);
    assert.throws(() => matcher.quote({ ...a, header: { ...a.header, destination: "different" } }, pool), /does not bind/);
    assert.throws(() => decryptQuote(client, { ...a, payload: b.payload }, quote), /does not bind/);
  });

  it("rejects inconsistent public quote terms client-side", () => {
    const i = intent();
    const quote = matcher.quote(i, pool);
    assert.throws(() => decryptQuote(client, i, { ...quote, netMultiplier: quote.netMultiplier + 1n }), /multipliers do not match/);
    assert.throws(() => decryptQuote(client, i, { ...quote, maxInputThor: 1n }), /exceeds quote maxInputThor/);
  });
});
