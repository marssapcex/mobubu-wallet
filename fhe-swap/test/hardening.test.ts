import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SealFheClient, SealFheEvaluator } from "../src/fhe/seal.js";
import {
  createEncryptedIntent,
  decryptIntentAmounts,
} from "../src/core/intent.js";
import { EncryptedMatcher, decryptQuote } from "../src/core/matcher.js";
import { SwapEngine, type IntentOpener } from "../src/core/engine.js";
import { ReferencePool, PoolBook } from "../src/core/pool.js";
import { MockChainAdapter } from "../src/chains/mock.js";
import { MockThresholdSigner } from "../src/chains/types.js";
import { toThorUnitsExact, fromThorUnits } from "../src/core/units.js";

describe("hardening / boundary checks", () => {
  let client: SealFheClient;
  let evaluator: SealFheEvaluator;
  let matcher: EncryptedMatcher;
  let opener: IntentOpener;

  before(async () => {
    client = await SealFheClient.create();
    evaluator = await SealFheEvaluator.fromBundle(client.publicBundle());
    matcher = new EncryptedMatcher(evaluator);
    opener = {
      async open(intent) {
        const { amountThor, minOutThor } = decryptIntentAmounts(client, intent);
        return { amountThor, minOutThor };
      },
    };
  });

  function xmrZecPool() {
    return new ReferencePool({
      pair: { from: "XMR", to: "ZEC" },
      reserveInThor: 10_000_000_000n,
      reserveOutThor: 20_000_000_000n,
      feeBps: 30,
      maxInputThor: 1_000_000_000n,
    });
  }

  function setup(opts?: {
    requireBothShielded?: boolean;
    now?: () => number;
  }) {
    const pools = new PoolBook();
    pools.add(xmrZecPool());
    pools.add(
      new ReferencePool({
        pair: { from: "BTC", to: "XMR" },
        reserveInThor: 10_000_000_000n,
        reserveOutThor: 100_000_000_000n,
        feeBps: 30,
        maxInputThor: 1_000_000_000n,
      }),
    );
    const monero = new MockChainAdapter({
      chain: "monero",
      assets: ["XMR"],
      vaults: { XMR: { address: "xmr-vault", confirmations: 10 } },
    });
    const zcash = new MockChainAdapter({
      chain: "zcash",
      assets: ["ZEC"],
      vaults: { ZEC: { address: "zec-vault", confirmations: 10 } },
    });
    const bitcoin = new MockChainAdapter({
      chain: "bitcoin",
      assets: ["BTC"],
      vaults: { BTC: { address: "btc-vault", confirmations: 2 } },
    });
    const engine = new SwapEngine({
      evaluator,
      pools,
      adapters: { monero, zcash, bitcoin },
      signer: new MockThresholdSigner(),
      opener,
      requireBothShielded: opts?.requireBothShielded,
      now: opts?.now,
    });
    return { engine, monero, zcash, bitcoin };
  }

  function intent(amount = "1.0", minOut = "1.9", deadline?: number) {
    return createEncryptedIntent(client, {
      from: "XMR",
      to: "ZEC",
      amount,
      minOut,
      destination: "zec-dest",
      refundAddress: "xmr-refund",
      deadline: deadline ?? Math.floor(Date.now() / 1000) + 3600,
    });
  }

  it("rejects sub-thor dust in intent amounts", () => {
    assert.throws(() => intent("0.000000001"), /sub-thor dust/);
    assert.throws(() => toThorUnitsExact("ETH", 1n), /sub-thor dust/);
    assert.throws(() => toThorUnitsExact("XMR", 1n), /sub-thor dust/);
    assert.throws(() => toThorUnitsExact("DAI", 1n), /sub-thor dust/);
    assert.equal(toThorUnitsExact("ETH", 10n ** 10n), 1n);
    assert.equal(fromThorUnits("ETH", 1n), 10n ** 10n);
  });

  it("binds intent id to the encrypted payload", () => {
    const a = intent("1.0");
    const b = intent("2.0");
    assert.notEqual(a.header.id, b.header.id);

    const { engine } = setup();
    const tampered = {
      ...a,
      header: { ...a.header, destination: "attacker-dest" },
    };
    assert.throws(
      () => engine.submitIntent(tampered),
      /does not bind header to encrypted payload/,
    );
  });

  it("rejects tampered public quote terms client-side", () => {
    const i = intent();
    const quote = matcher.quote(i, xmrZecPool().quote());
    assert.throws(
      () => decryptQuote(client, i, { ...quote, netMultiplier: quote.netMultiplier + 1n }),
      /multipliers do not match/,
    );
    assert.throws(
      () => decryptQuote(client, i, { ...quote, maxInputThor: 1n }),
      /exceeds quote maxInputThor/,
    );
  });

  it("refunds overpayment instead of keeping the excess", async () => {
    const { engine, monero } = setup();
    const i = intent();
    engine.submitIntent(i);
    monero.queueInbound({
      intentId: i.header.id,
      chain: "monero",
      asset: "XMR",
      txHash: "xmr-over",
      amountBaseUnits: 2n * 10n ** 12n,
      confirmations: 10,
      observedAt: Date.now(),
    });
    await engine.observeInbound(i.header.id);
    const record = await engine.settle(i.header.id);
    assert.equal(record.state, "refunded");
    assert.match(record.error ?? "", /above encrypted intent/);
  });

  it("refunds after deadline using Unix seconds", async () => {
    let now = 1_000_000;
    const { engine, monero } = setup({ now: () => now });
    const i = intent("1.0", "1.9", now + 10);
    engine.submitIntent(i);
    monero.queueInbound({
      intentId: i.header.id,
      chain: "monero",
      asset: "XMR",
      txHash: "xmr-late",
      amountBaseUnits: 10n ** 12n,
      confirmations: 10,
      observedAt: Date.now(),
    });
    await engine.observeInbound(i.header.id);
    now += 20;
    const record = await engine.settle(i.header.id);
    assert.equal(record.state, "refunded");
    assert.match(record.error ?? "", /deadline passed/);
  });

  it("can require both legs shielded", () => {
    const { engine } = setup({ requireBothShielded: true });
    const mixed = createEncryptedIntent(client, {
      from: "BTC",
      to: "XMR",
      amount: "0.1",
      minOut: "1",
      destination: "xmr-dest",
      refundAddress: "btc-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    assert.throws(() => engine.submitIntent(mixed), /both legs must be shielded/);
    assert.doesNotThrow(() => engine.submitIntent(intent()));
  });

  it("mock adapter rejects cross-chain/cross-asset inbound queueing", () => {
    const { monero } = setup();
    assert.throws(
      () =>
        monero.queueInbound({
          intentId: "x",
          chain: "zcash",
          asset: "ZEC",
          txHash: "bad",
          amountBaseUnits: 1n,
          confirmations: 1,
          observedAt: Date.now(),
        }),
      /cannot queue/,
    );
    assert.throws(
      () =>
        monero.queueInbound({
          intentId: "x",
          chain: "monero",
          asset: "ZEC",
          txHash: "bad",
          amountBaseUnits: 1n,
          confirmations: 1,
          observedAt: Date.now(),
        }),
      /cannot queue/,
    );
  });
});
