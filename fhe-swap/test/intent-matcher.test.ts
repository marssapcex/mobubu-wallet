import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SealFheClient, SealFheEvaluator } from "../src/fhe/seal.js";
import {
  createEncryptedIntent,
  decryptIntentAmounts,
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
    pair: { from: "XMR", to: "ZEC" },
    reserveInThor: 10_000_000_000n,
    reserveOutThor: 20_000_000_000n,
    feeBps: 30,
    maxInputThor: 1_000_000_000n,
  });

  it("creates an encrypted intent only the client can open", () => {
    const intent = createEncryptedIntent(client, {
      from: "XMR",
      to: "ZEC",
      amount: "1.0",
      minOut: "1.9",
      destination: "zec-dest",
      refundAddress: "xmr-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const opened = decryptIntentAmounts(client, intent);
    assert.equal(opened.amountThor, toThorUnits("XMR", 10n ** 12n));
    assert.equal(opened.minOutThor, toThorUnits("ZEC", 190_000_000n));
    assert.ok(opened.salt >= 0n);
  });

  it("rejects unsupported assets at intent boundary", () => {
    assert.throws(() =>
      createEncryptedIntent(client, {
        from: "RUNE" as any,
        to: "XMR",
        amount: "1",
        minOut: "1",
        destination: "d",
        refundAddress: "r",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  });

  it("computes encrypted quote matching plaintext expectation", () => {
    const intent = createEncryptedIntent(client, {
      from: "XMR",
      to: "ZEC",
      amount: "1.0",
      minOut: "1.9",
      destination: "zec-dest",
      refundAddress: "xmr-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const quote = matcher.quote(intent, pool.quote());
    const decrypted = decryptQuote(client, intent, quote);
    const amountThor = toThorUnits("XMR", 10n ** 12n);
    assert.equal(decrypted.netOutThor, expectedNetOutThor(amountThor, pool.quote()));
    assert.equal(decrypted.feeThor, expectedFeeThor(amountThor, pool.quote()));
    assert.equal(decrypted.meetsMinOut, true);
  });

  it("detects minOut failure client-side", () => {
    const intent = createEncryptedIntent(client, {
      from: "XMR",
      to: "ZEC",
      amount: "1.0",
      minOut: "2.5",
      destination: "zec-dest",
      refundAddress: "xmr-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    const quote = matcher.quote(intent, pool.quote());
    const decrypted = decryptQuote(client, intent, quote);
    assert.equal(decrypted.meetsMinOut, false);
  });

  it("rejects pool parameters that overflow the plaintext modulus", () => {
    const badPool = new ReferencePool({
      pair: { from: "XMR", to: "ZEC" },
      reserveInThor: 1n,
      reserveOutThor: 10n ** 12n,
      feeBps: 30,
      maxInputThor: 10n ** 12n,
    });
    const intent = createEncryptedIntent(client, {
      from: "XMR",
      to: "ZEC",
      amount: "1.0",
      minOut: "1.0",
      destination: "zec-dest",
      refundAddress: "xmr-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.throws(() => matcher.quote(intent, badPool.quote()), /overflow/);
  });
});
