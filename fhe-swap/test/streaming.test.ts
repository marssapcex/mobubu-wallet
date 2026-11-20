import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allPairs, chainOf, type Asset } from "../src/assets.js";
import { MockChainAdapter } from "../src/chains/mock.js";
import type { ChainAdapter, ThresholdSigner } from "../src/chains/types.js";
import { type ArbBot, ReferencePriceArbBot } from "../src/core/arb.js";
import { HubPool, HubPoolBook, HubRouter } from "../src/core/hub.js";
import { PrivateOrderFlow } from "../src/core/orderflow.js";
import {
  StreamingHubEngine,
  parseStreamingOrder,
  type StreamingOrderPlain,
} from "../src/core/streaming.js";
import { TokenTreasury } from "../src/core/token.js";
import { fromThorUnits, PRICE_SCALE } from "../src/core/units.js";
import {
  generateCommittee,
  sealOrder,
  ThresholdOrderOpener,
} from "../src/privacy/threshold.js";
import { MockTssCluster } from "../src/tss/mock.js";

function makePools(): HubPoolBook {
  const pools = new HubPoolBook();
  pools.add(
    new HubPool({
      asset: "BTC",
      reserveAssetThor: 100_000_000_000n,
      reserveNyxThor: 100_000_000_000_000_000n,
      referencePriceNyxPerAssetScaled: 1_000_000n * PRICE_SCALE,
      maxInputThor: 10_000_000_000n,
      maxNyxInputThor: 10_000_000_000_000_000n,
    }),
  );
  pools.add(
    new HubPool({
      asset: "ETH",
      reserveAssetThor: 1_000_000_000_000n,
      reserveNyxThor: 50_000_000_000_000_000n,
      referencePriceNyxPerAssetScaled: 50_000n * PRICE_SCALE,
      maxInputThor: 10_000_000_000_000_000n,
    }),
  );
  pools.add(
    new HubPool({
      asset: "BNB",
      reserveAssetThor: 2_400_000_000_000n,
      reserveNyxThor: 12_000_000_000_000_000n,
      referencePriceNyxPerAssetScaled: 5_000n * PRICE_SCALE,
      maxInputThor: 50_000_000_000n,
      maxNyxInputThor: 10_000_000_000_000_000n,
    }),
  );
  return pools;
}

function setup(opts?: {
  arb?: boolean;
  epochSeconds?: number;
  now?: number;
  feeBps?: number;
  arbBots?: ArbBot[];
  signer?: ThresholdSigner;
  outboundDelaySeconds?: number;
}) {
  let now = opts?.now ?? 1_000_000;
  const pools = makePools();
  const bitcoin = new MockChainAdapter({
    chain: "bitcoin",
    assets: ["BTC"],
    vaults: { BTC: { address: "btc-vault", confirmations: 2 } },
  });
  const ethereum = new MockChainAdapter({
    chain: "ethereum",
    assets: ["ETH"],
    vaults: { ETH: { address: "eth-vault", confirmations: 12 } },
  });
  const bsc = new MockChainAdapter({
    chain: "bsc",
    assets: ["BNB"],
    vaults: { BNB: { address: "bnb-vault", confirmations: 10 } },
  });
  const orderFlow = new PrivateOrderFlow();
  const committee = generateCommittee(5, 3);
  const opener = new ThresholdOrderOpener(committee);
  const treasury = new TokenTreasury();
  const adapters: { bitcoin?: ChainAdapter; ethereum: ChainAdapter; bsc: ChainAdapter } = { bitcoin, ethereum, bsc };
  const config = {
    orderFlow,
    opener,
    pools,
    feeBps: opts?.feeBps ?? 30,
    treasury,
    adapters,
    signer: opts?.signer ?? MockTssCluster.create(5, 3, "ecdsa-secp256k1"),
    arbBots: opts?.arbBots ?? (opts?.arb === false ? [] : [new ReferencePriceArbBot("arb", 5)]),
    epochSeconds: opts?.epochSeconds ?? 0,
    outboundDelaySeconds: opts?.outboundDelaySeconds ?? 0,
    now: () => now,
  };
  const engine = new StreamingHubEngine(config);
  return {
    engine,
    config,
    pools,
    bitcoin,
    ethereum,
    bsc,
    orderFlow,
    committee,
    opener,
    treasury,
    now: () => now,
    advance: (dt: number) => {
      now += dt;
    },
  };
}

function order(overrides?: Partial<StreamingOrderPlain>): StreamingOrderPlain {
  return {
    from: "BTC",
    to: "ETH",
    amountThor: "1000000000", // 10 BTC
    minOutThor: "15000000000", // 150 ETH
    destination: "eth-dest-fresh",
    refundAddress: "btc-refund-fresh",
    deadline: 1_000_000 + 24 * 3600,
    streaming: { intervalSeconds: 600, quantity: 5 },
    ...overrides,
  };
}

function submit(
  ctx: ReturnType<typeof setup>,
  plain: StreamingOrderPlain,
  shares = 3,
) {
  const { sealed, shares: allShares, orderId } = sealOrder(plain, ctx.committee);
  ctx.engine.submitSealed(sealed);
  for (const share of allShares.slice(0, shares)) {
    ctx.engine.submitShare(orderId, share);
  }
  return {
    orderId,
    sealed,
    shares: allShares,
    depositTag: ctx.engine.depositTag(orderId),
  };
}

function queueBtc(ctx: ReturnType<typeof setup>, depositTag: string, sats = 1_000_000_000n, hash = `btc-in-${depositTag}`) {
  ctx.bitcoin.queueInbound({
    depositTag,
    chain: "bitcoin",
    asset: "BTC",
    txHash: hash,
    amountBaseUnits: sats,
    confirmations: 2,
    observedAt: Date.now(),
  });
}

describe("streaming NYX hub engine", () => {
  it("completes BTC -> NYX -> ETH with sealed orderflow and one-time deposit tag", async () => {
    const ctx = setup();
    const plain = order();
    const { orderId, depositTag } = submit(ctx, plain);
    assert.notEqual(depositTag, orderId);
    assert.equal(ctx.orderFlow.size(), 1);
    assert.deepEqual(ctx.engine.publicView(orderId), { orderId, state: "sealed" });
    assert.equal(ctx.engine.get(orderId)?.opened, undefined);

    queueBtc(ctx, depositTag);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "completed");
    assert.equal(done.completedSubswaps, 5);
    assert.equal(done.remainingInThor, 0n);
    assert.ok(done.totalNetOutThor > 15_000_000_000n);
    assert.equal(done.outbound?.asset, "ETH");
    assert.ok(done.signed?.txHash);
    assert.equal(ctx.ethereum.hasBroadcast(done.signed!.txHash), true);
    assert.ok(done.subswaps.every((s) => s.arbActions.length > 0));
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, done.totalFeeNyxThor);
    assert.equal(done.inbound?.depositTag, depositTag);
  });

  it("streaming + arb beats one-shot execution for a large order", async () => {
    const ctx = setup();
    const plain = order();
    const oneShotPools = makePools();
    const oneShot = new HubRouter(oneShotPools, 30).quote(
      "BTC",
      "ETH",
      BigInt(plain.amountThor),
    );

    const { orderId, depositTag } = submit(ctx, plain);
    queueBtc(ctx, depositTag);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "completed");
    assert.ok(
      done.totalNetOutThor > oneShot.netOutThor,
      `streamed ${done.totalNetOutThor} should exceed one-shot ${oneShot.netOutThor}`,
    );
  });

  it("keeps the configured adapters and signer after edits to the caller's config", async () => {
    const ctx = setup();
    const { orderId, depositTag } = submit(ctx, order({ streaming: { intervalSeconds: 1, quantity: 1 } }));
    queueBtc(ctx, depositTag);
    delete ctx.config.adapters.bitcoin;
    ctx.config.signer = { async sign() { throw new Error("must not replace the registered signer"); } };
    assert.equal((await ctx.engine.tick(orderId)).state, "completed");
  });

  it("does not store orders from a different committee or retain shares after opening", async () => {
    const ctx = setup();
    const foreign = sealOrder(order(), generateCommittee(5, 3));
    assert.throws(() => ctx.engine.submitSealed(foreign.sealed), /committee mismatch/);
    assert.equal(ctx.orderFlow.size(), 0);
    assert.equal(ctx.engine.get(foreign.orderId), undefined);
    const { orderId, depositTag, shares } = submit(ctx, order());
    queueBtc(ctx, depositTag);
    assert.equal((await ctx.engine.tick(orderId)).state, "streaming");
    assert.equal(ctx.opener.canOpen(orderId), false);
    assert.throws(() => ctx.engine.submitShare(orderId, shares[0]), /no longer accepts shares/);
  });

  it("waits for threshold shares before opening plaintext", async () => {
    const ctx = setup();
    const { orderId, depositTag, shares } = submit(ctx, order(), 2);
    queueBtc(ctx, depositTag);
    const waiting = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(waiting.state, "inbound_confirmed");
    assert.equal(waiting.opened, undefined);

    ctx.engine.submitShare(orderId, shares[2]);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "completed");
    assert.ok(done.opened);
  });

  it("epoch batching delays threshold opening until the epoch boundary", async () => {
    const ctx = setup({ epochSeconds: 60, now: 1_000_000 });
    const { orderId, depositTag } = submit(ctx, order());
    queueBtc(ctx, depositTag);
    const early = await ctx.engine.run(orderId);
    assert.equal(early.state, "inbound_confirmed");
    assert.equal(early.opened, undefined);
    ctx.advance(60);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "completed");
  });

  it("refunds the full inbound when the first subswap cannot meet minOut", async () => {
    const ctx = setup();
    const plain = order({ minOutThor: "999999999999999" });
    const { orderId, depositTag } = submit(ctx, plain);
    queueBtc(ctx, depositTag);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "refunded");
    assert.equal(done.completedSubswaps, 0);
    assert.equal(done.refundOutbound?.asset, "BTC");
    assert.equal(done.refundOutbound?.amountBaseUnits, 1_000_000_000n);
    assert.ok(done.refundSigned?.txHash);
    assert.equal(ctx.bitcoin.hasBroadcast(done.refundSigned!.txHash), true);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, 0n);
  });

  it("partially settles when a later subswap misses its proportional limit", async () => {
    const ctx = setup({ arb: false });
    const amount = BigInt(order().amountThor);
    const chunk = amount / 5n;
    const first = new HubRouter(ctx.pools, 30).quote("BTC", "ETH", chunk);
    const plain = order({ minOutThor: (first.netOutThor * 5n).toString() });
    const { orderId, depositTag } = submit(ctx, plain);
    queueBtc(ctx, depositTag);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "partially_completed");
    assert.equal(done.completedSubswaps, 1);
    assert.equal(done.remainingInThor, amount - chunk);
    assert.ok(done.outbound && done.outbound.amountBaseUnits > 0n);
    assert.equal(done.refundOutbound?.asset, "BTC");
    assert.equal(done.refundOutbound?.amountBaseUnits, done.remainingInThor);
    assert.ok(done.totalFeeNyxThor > 0n);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, done.totalFeeNyxThor);
  });

  it("stops and partially settles when the deadline passes mid-stream", async () => {
    const ctx = setup();
    const plain = order({ deadline: ctx.now() + 300 });
    const { orderId, depositTag } = submit(ctx, plain);
    queueBtc(ctx, depositTag);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "partially_completed");
    assert.equal(done.completedSubswaps, 1);
    assert.match(done.error ?? "", /deadline/);
  });

  it("refunds when the inbound amount does not match the sealed order", async () => {
    const ctx = setup();
    const { orderId, depositTag } = submit(ctx, order());
    queueBtc(ctx, depositTag, 900_000_000n);
    const done = await ctx.engine.run(orderId, { advanceTime: ctx.advance });
    assert.equal(done.state, "refunded");
    assert.match(done.error ?? "", /inbound amount/);
  });

  it("rejects wrapped assets in sealed orders without filling or issuing payouts", async () => {
    for (const wrapped of ["WBNB", "WBTC", "WETH", "BTCB"]) {
      const asset = wrapped as Asset;
      assert.throws(() => parseStreamingOrder({ ...order(), from: asset }), /Unsupported asset/);
      assert.throws(() => parseStreamingOrder({ ...order(), to: asset }), /Unsupported asset/);
      const ctx = setup();
      const { orderId, depositTag } = submit(ctx, order({ to: asset }));
      queueBtc(ctx, depositTag);
      const rejected = await ctx.engine.tick(orderId);
      assert.equal(rejected.state, "needs_review");
      assert.equal(rejected.completedSubswaps, 0);
      assert.equal(rejected.outbound, undefined);
      assert.equal(rejected.refundOutbound, undefined);
    }
  });

  it("keeps the native BNB vault on BSC, separate from Ethereum", async () => {
    assert.throws(() => new MockChainAdapter({ chain: "ethereum", assets: ["BNB"],
      vaults: { BNB: { address: "wrong-network", confirmations: 1 } } }), /invalid asset BNB/);
    const { bsc, ethereum } = setup();
    assert.throws(() => bsc.queueInbound({ chain: "ethereum", asset: "BNB", depositTag: "test-deposit",
      txHash: "wrong-network", amountBaseUnits: 1n, confirmations: 12, observedAt: 0 }), /cannot queue ethereum inbound/);
    const outbound = { asset: "BNB", to: "bnb-receiver", amountBaseUnits: 1n, orderId: "test-order" } as const;
    await assert.rejects(bsc.buildOutbound({ ...outbound, chain: "ethereum" }), /outbound chain mismatch/);
    await assert.rejects(ethereum.buildOutbound({ ...outbound, chain: "ethereum" }), /asset BNB not on ethereum/);
    const payload = JSON.parse(await bsc.buildOutbound({ ...outbound, chain: "bsc" }));
    assert.equal(payload.chain, "bsc");
    assert.equal(payload.asset, "BNB");
    assert.equal(payload.from, "bnb-vault");
  });

  it("settles all six BTC/ETH/BNB directions on mock chains", async () => {
    for (const [from, to] of allPairs()) {
      const ctx = setup({ arb: false });
      const source = ctx[chainOf(from)], target = ctx[chainOf(to)];
      const amountThor = 1_000_000n;
      const quote = new HubRouter(ctx.pools, 30).quote(from, to, amountThor);
      const plain = order({ from, to, amountThor: amountThor.toString(), minOutThor: quote.netOutThor.toString(),
        destination: `${to}-mock-dest`, refundAddress: `${from}-mock-refund`, streaming: { intervalSeconds: 1, quantity: 1 } });
      const { orderId, depositTag } = submit(ctx, plain);
      source.queueInbound({ depositTag, asset: from, chain: source.chain, txHash: `in-${depositTag}`,
        amountBaseUnits: fromThorUnits(from, amountThor), confirmations: source.requiredConfirmations(from), observedAt: ctx.now() });
      const done = await ctx.engine.tick(orderId);
      assert.equal(done.state, "completed", `${from} → ${to}`);
      assert.equal(done.completedSubswaps, 1);
      assert.equal(done.remainingInThor, 0n);
      assert.deepEqual(done.outbound, { orderId, chain: target.chain, asset: to, to: plain.destination,
        amountBaseUnits: fromThorUnits(to, quote.netOutThor), memoHash: undefined });
      assert.ok(done.outboundBroadcastHash && target.hasBroadcast(done.outboundBroadcastHash));
      assert.equal(done.refundOutbound, undefined);
      assert.equal(ctx.treasury.snapshot().collectedNyxThor, quote.feeNyxThor);
    }
  });
});

describe("streaming settlement and finality", () => {
  it("resumes both signed legs after ambiguous broadcast replies without repricing or resigning", async () => {
    const actual = MockTssCluster.create(3, 2);
    let signCalls = 0;
    const ctx = setup({ signer: {
      async sign(...args) { signCalls++; return actual.sign(...args); },
    } });
    const payoutAttempts: string[] = [], refundAttempts: string[] = [];
    const faultOnce = (chain: MockChainAdapter, calls: string[]) => {
      const broadcast = chain.broadcast.bind(chain);
      chain.broadcast = async (raw) => {
        calls.push(raw);
        const hash = await broadcast(raw);
        if (calls.length === 1) throw new Error("lost broadcast reply");
        return hash;
      };
    };
    faultOnce(ctx.ethereum, payoutAttempts);
    faultOnce(ctx.bitcoin, refundAttempts);
    const { orderId, depositTag } = submit(ctx, order({ deadline: ctx.now() + 1 }));
    queueBtc(ctx, depositTag);
    const filled = await ctx.engine.tick(orderId);
    assert.equal(filled.completedSubswaps, 1);
    ctx.advance(2);
    await assert.rejects(ctx.engine.tick(orderId), /lost broadcast reply/);
    assert.equal(ctx.engine.get(orderId)?.state, "outbound_signed");
    assert.equal(signCalls, 1);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, 0n);
    await assert.rejects(ctx.engine.tick(orderId), /lost broadcast reply/);
    assert.ok(ctx.engine.get(orderId)?.outboundBroadcastHash);
    const done = await ctx.engine.tick(orderId);
    assert.equal(done.state, "partially_completed");
    assert.equal(done.completedSubswaps, 1);
    assert.equal(done.totalNetOutThor, filled.totalNetOutThor);
    assert.equal(done.remainingInThor, filled.remainingInThor);
    assert.equal(signCalls, 2); // one signed transaction per leg
    assert.deepEqual(payoutAttempts, [done.signed!.rawTx, done.signed!.rawTx]);
    assert.deepEqual(refundAttempts, [done.refundSigned!.rawTx, done.refundSigned!.rawTx]);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, done.totalFeeNyxThor);
    await ctx.engine.tick(orderId);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, done.totalFeeNyxThor);
    assert.equal(signCalls, 2);
  });

  it("does not sign a new refund leg if funding loses depth after payout broadcast", async () => {
    const actual = MockTssCluster.create(3, 2);
    const signedAssets: Asset[] = [];
    const ctx = setup({ signer: {
      async sign(chain, asset, unsigned) {
        signedAssets.push(asset);
        return actual.sign(chain, asset, unsigned);
      },
    } });
    const { orderId, depositTag } = submit(ctx, order({ deadline: ctx.now() + 1 }));
    const sourceHash = `btc-in-${depositTag}`;
    queueBtc(ctx, depositTag);
    const out = ctx.ethereum.broadcast.bind(ctx.ethereum);
    ctx.ethereum.broadcast = async (raw) => {
      const hash = await out(raw);
      ctx.bitcoin.setConfirmations(sourceHash, 0);
      return hash;
    };
    await ctx.engine.tick(orderId);
    ctx.advance(2);
    const paused = await ctx.engine.tick(orderId);
    assert.equal(paused.state, "outbound_broadcast");
    assert.equal(paused.inbound?.confirmations, 0);
    assert.ok(paused.outboundBroadcastHash);
    assert.ok(paused.refundOutbound);
    assert.equal(paused.refundSigned, undefined);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, 0n);
    assert.deepEqual(signedAssets, ["ETH"]);

    const sendRefund = ctx.bitcoin.broadcast.bind(ctx.bitcoin);
    ctx.bitcoin.broadcast = async (raw) => {
      const hash = await sendRefund(raw);
      ctx.bitcoin.setConfirmations(sourceHash, 0);
      return hash;
    };
    ctx.bitcoin.setConfirmations(sourceHash, 2);
    const unfinalized = await ctx.engine.tick(orderId);
    assert.ok(unfinalized.refundBroadcastHash);
    assert.equal(unfinalized.state, "outbound_broadcast");
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, 0n);
    ctx.bitcoin.setConfirmations(sourceHash, 2);
    const done = await ctx.engine.tick(orderId);
    assert.equal(done.state, "partially_completed");
    assert.equal(done.signed?.rawTx, paused.signed?.rawTx);
    assert.deepEqual(signedAssets, ["ETH", "BTC"]);
  });

  it("pins the confirmed credit and pauses if the watcher reports another tx or amount", async () => {
    const ctx = setup();
    const { orderId, depositTag } = submit(ctx, order());
    const amount = 1_000_000_000n;
    const original = "original-credit";
    queueBtc(ctx, depositTag, amount, original);
    assert.equal((await ctx.engine.observeInbound(orderId)).state, "inbound_confirmed");
    queueBtc(ctx, depositTag, amount, "replacement-credit");
    const blocked = await ctx.engine.tick(orderId);
    assert.equal(blocked.fundingStatus, "changed");
    assert.equal(blocked.inbound?.txHash, original);
    assert.equal(blocked.opened, undefined);
    const scan = ctx.bitcoin.scanInbound.bind(ctx.bitcoin);
    ctx.bitcoin.scanInbound = async () => null; // Depth alone still says confirmed.
    const missing = await ctx.engine.tick(orderId);
    assert.equal(missing.fundingStatus, "missing");
    assert.equal(missing.inbound?.txHash, original);
    assert.equal(missing.opened, undefined);
    ctx.bitcoin.scanInbound = scan;
    queueBtc(ctx, depositTag, amount, original);
    const first = await ctx.engine.tick(orderId);
    assert.equal(first.completedSubswaps, 1);
    const reserves = ctx.pools.get("BTC").reserves();
    queueBtc(ctx, depositTag, amount - 1n, original);
    ctx.advance(600);
    const changed = await ctx.engine.tick(orderId);
    assert.equal(changed.completedSubswaps, 1);
    assert.equal(changed.fundingStatus, "changed");
    assert.equal(changed.inbound?.amountBaseUnits, amount);
    assert.deepEqual(ctx.pools.get("BTC").reserves(), reserves);
  });

  it("retains a signed payout without first broadcast if the funding changes during signing", async () => {
    const actual = MockTssCluster.create(3, 2);
    let signCalls = 0;
    let onSign = () => {};
    const ctx = setup({ signer: {
      async sign(...args) {
        signCalls++;
        const signed = await actual.sign(...args);
        onSign();
        return signed;
      },
    } });
    const { orderId, depositTag } = submit(ctx, order({ streaming: { intervalSeconds: 1, quantity: 1 } }));
    queueBtc(ctx, depositTag);
    onSign = () => queueBtc(ctx, depositTag, 1n);
    const pending = await ctx.engine.tick(orderId);
    assert.equal(pending.state, "outbound_signed");
    assert.equal(pending.fundingStatus, "changed");
    assert.equal(pending.outboundBroadcastHash, undefined);
    assert.equal(ctx.ethereum.hasBroadcast(pending.signed!.txHash), false);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, 0n);
    queueBtc(ctx, depositTag);
    const done = await ctx.engine.tick(orderId);
    assert.equal(done.state, "completed");
    assert.equal(done.signed?.rawTx, pending.signed?.rawTx);
    assert.equal(signCalls, 1);
  });

  it("does not finalize until payout has the configured confirmations", async () => {
    const ctx = setup();
    ctx.ethereum.requiredOutboundConfirmations = () => 3;
    const { orderId, depositTag } = submit(ctx, order({ streaming: { intervalSeconds: 1, quantity: 1 } }));
    queueBtc(ctx, depositTag);
    const pending = await ctx.engine.tick(orderId);
    assert.equal(pending.state, "outbound_broadcast");
    assert.ok(pending.outboundBroadcastHash);
    assert.equal(ctx.treasury.snapshot().collectedNyxThor, 0n);
    ctx.ethereum.setConfirmations(pending.outboundBroadcastHash, 3);
    const done = await ctx.engine.tick(orderId);
    assert.equal(done.state, "completed");
    assert.equal(done.outboundBroadcastHash, pending.outboundBroadcastHash);
  });

  it("blocks duplicate confirmed deposits and mismatched assets instead of issuing refunds", async () => {
    const ctx = setup();
    const a = submit(ctx, order());
    const b = submit(ctx, order());
    queueBtc(ctx, a.depositTag, 1_000_000_000n, "0xABC");
    queueBtc(ctx, b.depositTag, 1_000_000_000n, "abc");
    assert.equal((await ctx.engine.tick(a.orderId)).completedSubswaps, 1);
    const replay = await ctx.engine.tick(b.orderId);
    assert.equal(replay.state, "needs_review");
    assert.match(replay.error!, /already credited/);
    assert.equal(replay.refundOutbound, undefined);
    assert.equal(ctx.opener.canOpen(b.orderId), false);

    const c = submit(ctx, order());
    ctx.ethereum.queueInbound({
      depositTag: c.depositTag, chain: "ethereum", asset: "ETH", txHash: "wrong-asset",
      amountBaseUnits: 50n * 10n ** 18n, confirmations: 12, observedAt: ctx.now(),
    });
    const wrong = await ctx.engine.tick(c.orderId);
    assert.equal(wrong.state, "needs_review");
    assert.match(wrong.error!, /asset does not match/);
    assert.equal(wrong.refundOutbound, undefined);
    assert.equal(wrong.completedSubswaps, 0);
  });

  it("pauses after confirmation loss and never books multiple late chunks into one tick", async () => {
    const ctx = setup({ arbBots: [{ name: "fault", rebalance() { throw new Error("feed down"); } }] });
    const { orderId, depositTag } = submit(ctx, order());
    queueBtc(ctx, depositTag);
    const a = await ctx.engine.tick(orderId);
    assert.equal(a.subswaps[0].arbFailures, 2);
    assert.equal(a.completedSubswaps, 1);
    assert.ok(a.inbound);
    ctx.bitcoin.setConfirmations(a.inbound.txHash, 0);
    ctx.advance(1_800);
    const paused = await ctx.engine.tick(orderId);
    assert.equal(paused.completedSubswaps, 1);
    assert.equal(paused.fundingStatus, "unconfirmed");
    ctx.bitcoin.setConfirmations(a.inbound.txHash, 2);
    const b = await ctx.engine.tick(orderId);
    assert.equal(b.completedSubswaps, 2);
    assert.equal(b.nextSubswapAt, ctx.now() + 600);
    assert.equal((await ctx.engine.tick(orderId)).completedSubswaps, 2);
    assert.equal(a.completedSubswaps, 1); // the snapshot does not alias engine state
  });

  it("does not refund unconfirmed deposits or bypass the scheduled outbound delay", async () => {
    const ctx = setup({ outboundDelaySeconds: 30 });
    const { orderId, depositTag } = submit(ctx, order());
    queueBtc(ctx, depositTag);
    ctx.bitcoin.setConfirmations(`btc-in-${depositTag}`, 1);
    await ctx.engine.observeInbound(orderId);
    await assert.rejects(ctx.engine.refund(orderId, "cancel"), /confirmed, opened inbound/);
    assert.equal(ctx.engine.get(orderId)?.state, "inbound_observed");
    ctx.bitcoin.setConfirmations(`btc-in-${depositTag}`, 2);
    await ctx.engine.observeInbound(orderId);
    // Open, but cancel before any chunk is executed.
    await ctx.engine.start(orderId);
    const pending = await ctx.engine.refund(orderId, "cancel");
    assert.equal(pending.state, "awaiting_outbound");
    assert.equal(pending.refundSigned, undefined);
    assert.equal((await ctx.engine.refund(orderId, "cancel again")).refundSigned, undefined);
    ctx.advance(30);
    const done = await ctx.engine.tick(orderId);
    assert.equal(done.state, "refunded");
    assert.equal(done.refundOutbound?.amountBaseUnits, 1_000_000_000n);
    assert.equal(done.completedSubswaps, 0);
  });
});
