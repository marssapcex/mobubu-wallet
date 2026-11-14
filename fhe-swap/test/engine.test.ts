import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SealFheClient, SealFheEvaluator } from "../src/fhe/seal.js";
import {
  createEncryptedIntent,
  decryptIntentAmounts,
} from "../src/core/intent.js";
import { SwapEngine, type IntentOpener } from "../src/core/engine.js";
import { ReferencePool, PoolBook } from "../src/core/pool.js";
import { MockChainAdapter } from "../src/chains/mock.js";
import { MockThresholdSigner } from "../src/chains/types.js";
import { fromThorUnits } from "../src/core/units.js";

describe("SwapEngine end-to-end with mock chains", () => {
  let client: SealFheClient;
  let evaluator: SealFheEvaluator;
  let opener: IntentOpener;

  before(async () => {
    client = await SealFheClient.create();
    evaluator = await SealFheEvaluator.fromBundle(client.publicBundle());
    opener = {
      async open(intent) {
        const { amountThor, minOutThor } = decryptIntentAmounts(client, intent);
        return { amountThor, minOutThor };
      },
    };
  });

  function setup(opts?: { minOut?: string; requireShieldedLeg?: boolean }) {
    const pools = new PoolBook();
    pools.add(
      new ReferencePool({
        pair: { from: "XMR", to: "ZEC" },
        reserveInThor: 10_000_000_000n,
        reserveOutThor: 20_000_000_000n,
        feeBps: 30,
        maxInputThor: 1_000_000_000n,
      }),
    );
    pools.add(
      new ReferencePool({
        pair: { from: "BTC", to: "XMR" },
        reserveInThor: 10_000_000_000n, // 100 BTC thor
        reserveOutThor: 100_000_000_000n, // 1000 XMR thor
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
      requireShieldedLeg: opts?.requireShieldedLeg ?? false,
    });
    return { engine, monero, zcash, bitcoin };
  }

  function intent(minOut = "1.9") {
    return createEncryptedIntent(client, {
      from: "XMR",
      to: "ZEC",
      amount: "1.0",
      minOut,
      destination: "zec-dest",
      refundAddress: "xmr-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      memoHash: "memo-hash",
    });
  }

  it("settles XMR->ZEC after confirmed inbound", async () => {
    const { engine, monero, zcash } = setup();
    const i = intent();
    engine.submitIntent(i);
    monero.queueInbound({
      intentId: i.header.id,
      chain: "monero",
      asset: "XMR",
      txHash: "xmr-in",
      amountBaseUnits: 10n ** 12n,
      confirmations: 10,
      observedAt: Date.now(),
    });
    await engine.observeInbound(i.header.id);
    const record = await engine.settle(i.header.id);
    assert.equal(record.state, "completed");
    assert.ok(record.outbound);
    assert.equal(record.outbound.asset, "ZEC");
    assert.equal(record.outbound.amountBaseUnits, fromThorUnits("ZEC", 199_400_000n));
    assert.ok(record.signed?.txHash);
    assert.equal(zcash.hasBroadcast(record.signed!.txHash), true);
  });

  it("refunds when minOut is not met", async () => {
    const { engine, monero } = setup();
    const i = intent("2.5");
    engine.submitIntent(i);
    monero.queueInbound({
      intentId: i.header.id,
      chain: "monero",
      asset: "XMR",
      txHash: "xmr-in-2",
      amountBaseUnits: 10n ** 12n,
      confirmations: 10,
      observedAt: Date.now(),
    });
    await engine.observeInbound(i.header.id);
    const record = await engine.settle(i.header.id);
    assert.equal(record.state, "refunded");
    assert.match(record.error ?? "", /minOut/);
  });

  it("refunds when inbound amount is below encrypted intent", async () => {
    const { engine, monero } = setup();
    const i = intent();
    engine.submitIntent(i);
    monero.queueInbound({
      intentId: i.header.id,
      chain: "monero",
      asset: "XMR",
      txHash: "xmr-in-3",
      amountBaseUnits: 10n ** 11n, // 0.1 XMR
      confirmations: 10,
      observedAt: Date.now(),
    });
    await engine.observeInbound(i.header.id);
    const record = await engine.settle(i.header.id);
    assert.equal(record.state, "refunded");
    assert.match(record.error ?? "", /below encrypted intent/);
  });

  it("does not settle before required confirmations", async () => {
    const { engine, monero } = setup();
    const i = intent();
    engine.submitIntent(i);
    monero.queueInbound({
      intentId: i.header.id,
      chain: "monero",
      asset: "XMR",
      txHash: "xmr-in-4",
      amountBaseUnits: 10n ** 12n,
      confirmations: 1,
      observedAt: Date.now(),
    });
    const observed = await engine.observeInbound(i.header.id);
    assert.equal(observed.state, "inbound_observed");
    await assert.rejects(() => engine.settle(i.header.id), /inbound not confirmed/);
    monero.setConfirmations("xmr-in-4", 10);
    const settled = await engine.settle(i.header.id);
    assert.equal(settled.state, "completed");
  });

  it("enforces shielded-leg policy at submit", () => {
    const { engine } = setup({ requireShieldedLeg: true });
    const bad = createEncryptedIntent(client, {
      from: "BTC",
      to: "XMR",
      amount: "0.1",
      minOut: "1",
      destination: "xmr-dest",
      refundAddress: "btc-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    // BTC->XMR is mixed and allowed.
    assert.doesNotThrow(() => engine.submitIntent(bad));

    const transparent = createEncryptedIntent(client, {
      from: "BTC",
      to: "ETH",
      amount: "0.1",
      minOut: "1",
      destination: "eth-dest",
      refundAddress: "btc-refund",
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    // No BTC->ETH pool is configured, but privacy rejection should happen first.
    assert.throws(() => engine.submitIntent(transparent), /Privacy policy rejected/);
  });
});
