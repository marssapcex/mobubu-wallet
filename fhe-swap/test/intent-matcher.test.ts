import { describe, it, before } from "node:test";
import type { Asset } from "../src/assets.js";
import assert from "node:assert/strict";
import { SealFheClient, SealFheEvaluator } from "../src/fhe/seal.js";
import {
  createEncryptedIntent,
  decryptIntentAmounts,
  intentId,
} from "../src/core/intent.js";
import {
  EncryptedMatcher,
  decryptQuote,
  expectedNetOutThor,
  expectedFeeThor,
} from "../src/core/matcher.js";
import { ReferencePool } from "../src/core/pool.js";
import { toThorUnits } from "../src/core/units.js";

describe("encrypted intent + matcher", () => {
  let client: SealFheClient;
  let evaluator: SealFheEvaluator;
  let matcher: EncryptedMatcher;

  before(async () => {
    client = await SealFheClient.create();
    evaluator = await SealFheEvaluator.fromBundle(client.publicBundle());
    matcher = new EncryptedMatcher(evaluator);
  });

  const pool = new ReferencePool({
    pair: { from: "BNB", to: "BTC" },
    reserveInThor: 10_000_000_000n,
    reserveOutThor: 50_000_000n,
    feeBps: 30,
    maxInputThor: 1_000_000_000n,
  });

  it("creates an encrypted intent only the client can open", () => {
    const intent = createEncryptedIntent(client, {
      from: "BNB",
      to: "BTC",
      amount: "1.0",
      minOut: "0.0049",
      destination: "btc-dest",
      refundAddress: "bnb-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const opened = decryptIntentAmounts(client, intent);
    assert.equal(opened.amountThor, toThorUnits("BNB", 10n ** 18n));
    assert.equal(opened.minOutThor, toThorUnits("BTC", 490_000n));
    assert.ok(opened.salt >= 0n);
  });

  it("rejects wrapped assets at the intent and quote boundaries", () => {
    const input = {
      ...pool.quote().pair,
      amount: "1", minOut: "1",
      destination: "d", refundAddress: "r", deadline: 1_000_000,
    };
    const intent = createEncryptedIntent(client, input);
    for (const wrapped of ["WBNB", "WBTC", "WETH", "BTCB"]) {
      const asset = wrapped as Asset;
      assert.throws(() => createEncryptedIntent(client, { ...input, from: asset }), /Unsupported asset/);
      assert.throws(() => createEncryptedIntent(client, { ...input, to: asset }), /Unsupported asset/);
      const pair = { from: input.from, to: asset };
      const header = { ...intent.header, pair };
      header.id = intentId(header, intent.payload.values.ciphertext);
      assert.throws(() => matcher.quote({ ...intent, header }, { ...pool.quote(), pair }), /Unsupported asset/);
    }
  });

  it("computes encrypted quote matching plaintext expectation", () => {
    const intent = createEncryptedIntent(client, {
      from: "BNB",
      to: "BTC",
      amount: "1.0",
      minOut: "0.0049",
      destination: "btc-dest",
      refundAddress: "bnb-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const quote = matcher.quote(intent, pool.quote());
    const decrypted = decryptQuote(client, intent, quote);
    const amountThor = toThorUnits("BNB", 10n ** 18n);
    assert.equal(decrypted.netOutThor, expectedNetOutThor(amountThor, pool.quote()));
    assert.equal(decrypted.feeThor, expectedFeeThor(amountThor, pool.quote()));
    assert.equal(decrypted.meetsMinOut, true);
  });

  it("detects minOut failure client-side", () => {
    const intent = createEncryptedIntent(client, {
      from: "BNB",
      to: "BTC",
      amount: "1.0",
      minOut: "0.0055",
      destination: "btc-dest",
      refundAddress: "bnb-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const quote = matcher.quote(intent, pool.quote());
    const decrypted = decryptQuote(client, intent, quote);
    assert.equal(decrypted.meetsMinOut, false);
  });

  it("rejects pool parameters that overflow the plaintext modulus", () => {
    const badPool = new ReferencePool({
      pair: { from: "BNB", to: "BTC" },
      reserveInThor: 1n,
      reserveOutThor: 10n ** 12n,
      feeBps: 30,
      maxInputThor: 10n ** 12n,
    });
    const intent = createEncryptedIntent(client, {
      from: "BNB",
      to: "BTC",
      amount: "1.0",
      minOut: "1.0",
      destination: "btc-dest",
      refundAddress: "bnb-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.throws(() => matcher.quote(intent, badPool.quote()), /overflow/);
  });
});
