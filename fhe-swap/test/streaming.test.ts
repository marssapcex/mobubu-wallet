import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allPairs, SUPPORTED_ASSETS, type Asset } from "../src/assets.js";
import { MockChainAdapter } from "../src/chains/mock.js";
import { ReferencePriceArbBot } from "../src/core/arb.js";
import { HubPool, HubPoolBook, HubRouter } from "../src/core/hub.js";
import { PrivateOrderFlow } from "../src/core/orderflow.js";
import {
  StreamingHubEngine,
  parseStreamingOrder,
  type StreamingOrderPlain,
} from "../src/core/streaming.js";
import { TokenTreasury } from "../src/core/token.js";
import { PRICE_SCALE } from "../src/core/units.js";
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
  return pools;
}

function setup(opts?: {
  arb?: boolean;
  epochSeconds?: number;
  now?: number;
  feeBps?: number;
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
    assets: ["ETH", "DAI"],
    vaults: {
      ETH: { address: "eth-vault", confirmations: 12 },
      DAI: { address: "dai-vault", confirmations: 12 },
    },
  });
  const orderFlow = new PrivateOrderFlow();
  const committee = generateCommittee(5, 3);
  const opener = new ThresholdOrderOpener(committee);
  const treasury = new TokenTreasury();
  const engine = new StreamingHubEngine({
    orderFlow,
    opener,
    pools,
    feeBps: opts?.feeBps ?? 30,
    treasury,
    adapters: { bitcoin, ethereum },
    signer: MockTssCluster.create(5, 3, "ecdsa-secp256k1"),
    arbBots: opts?.arb === false ? [] : [new ReferencePriceArbBot("arb", 5)],
    epochSeconds: opts?.epochSeconds ?? 0,
    outboundDelaySeconds: 0,
    now: () => now,
  });
  return {
    engine,
    pools,
    bitcoin,
    ethereum,
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

function queueBtc(ctx: ReturnType<typeof setup>, depositTag: string, sats = 1_000_000_000n) {
  ctx.bitcoin.queueInbound({
    intentId: depositTag,
    chain: "bitcoin",
    asset: "BTC",
    txHash: `btc-in-${depositTag}`,
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
    assert.equal(done.inbound?.intentId, depositTag);
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

  it("rejects unsupported external assets in the sealed order", () => {
    assert.throws(
      () => parseStreamingOrder({ ...order(), from: "RUNE" }),
      /Unsupported asset/,
    );
  });

  it("routes all 20 allow-listed pairs through NYX", () => {
    const pools = new HubPoolBook();
    for (const asset of SUPPORTED_ASSETS) {
      pools.add(
        new HubPool({
          asset,
          reserveAssetThor: 1_000_000_000_000n,
          reserveNyxThor: 1_000_000_000_000_000n,
          referencePriceNyxPerAssetScaled: PRICE_SCALE,
          maxInputThor: 1_000_000_000_000n,
        }),
      );
    }
    const router = new HubRouter(pools, 30);
    const pairs = allPairs();
    assert.equal(pairs.length, 20);
    for (const [from, to] of pairs) {
      const q = router.quote(from as Asset, to as Asset, 1_000_000n);
      assert.ok(q.intermediateNyxThor > 0n, `${from}->${to} hub leg`);
      assert.ok(q.netOutThor > 0n, `${from}->${to} output`);
    }
  });
});
