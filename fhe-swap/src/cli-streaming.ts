import { fromBaseUnits } from "./assets.js";
import { MockChainAdapter } from "./chains/mock.js";
import { CexPriceArbBot } from "./core/arb.js";
import { HubPool, HubPoolBook, HubRouter } from "./core/hub.js";
import { PrivateOrderFlow } from "./core/orderflow.js";
import { StaticCexPriceFeed } from "./core/price-feed.js";
import { StreamingHubEngine, type StreamingOrderPlain } from "./core/streaming.js";
import { TokenTreasury } from "./core/token.js";
import { PRICE_SCALE } from "./core/units.js";
import {
  generateCommittee,
  sealOrder,
  ThresholdOrderOpener,
} from "./privacy/threshold.js";
import { MockTssCluster } from "./tss/mock.js";

function makePools() {
  const pools = new HubPoolBook();
  pools.add(
    new HubPool({
      asset: "BTC",
      reserveAssetThor: 100_000_000_000n, // 1,000 BTC in thor units
      reserveNyxThor: 100_000_000_000_000_000n,
      referencePriceNyxPerAssetScaled: 1_000_000n * PRICE_SCALE,
      maxInputThor: 10_000_000_000n,
      maxNyxInputThor: 10_000_000_000_000_000n,
    }),
  );
  pools.add(
    new HubPool({
      asset: "ETH",
      reserveAssetThor: 1_000_000_000_000n, // 10,000 ETH in thor units
      reserveNyxThor: 50_000_000_000_000_000n,
      referencePriceNyxPerAssetScaled: 50_000n * PRICE_SCALE,
      maxInputThor: 10_000_000_000_000_000n,
    }),
  );
  return pools;
}

async function main(): Promise<void> {
  console.log("NYX hub streaming simulation — mock chains, no real funds");
  console.log("Route: BTC -> NYX -> ETH, sealed orderflow, threshold opening, arb between subswaps");

  let now = 1_000_000;
  const nowFn = () => now;

  const pools = makePools();

  const bitcoin = new MockChainAdapter({
    chain: "bitcoin",
    assets: ["BTC"],
    vaults: { BTC: { address: "btc-vault-fresh", confirmations: 2 } },
  });
  const ethereum = new MockChainAdapter({
    chain: "ethereum",
    assets: ["ETH"],
    vaults: { ETH: { address: "eth-vault-fresh", confirmations: 12 } },
  });

  const orderFlow = new PrivateOrderFlow();
  const committee = generateCommittee(5, 3);
  const opener = new ThresholdOrderOpener(committee);
  const treasury = new TokenTreasury();
  const signer = MockTssCluster.create(5, 3, "ecdsa-secp256k1");
  const cexFeed = new StaticCexPriceFeed("binance-mid-static", {
    BTC: 1_000_000n * PRICE_SCALE,
    ETH: 50_000n * PRICE_SCALE,
  });

  const engine = new StreamingHubEngine({
    orderFlow,
    opener,
    pools,
    feeBps: 30,
    treasury,
    adapters: { bitcoin, ethereum },
    signer,
    arbBots: [new CexPriceArbBot("binance-arb-bot", cexFeed, 5)],
    outboundDelaySeconds: 60,
    epochSeconds: 60,
    now: nowFn,
  });

  const order: StreamingOrderPlain = {
    from: "BTC",
    to: "ETH",
    amountThor: "1000000000", // 10 BTC
    minOutThor: "15000000000", // 150 ETH
    destination: "eth-destination-fresh",
    refundAddress: "btc-refund-fresh",
    deadline: now + 24 * 3600,
    streaming: { intervalSeconds: 600, quantity: 5 },
    memoHash: "demo-stream",
  };

  const { sealed, shares, orderId } = sealOrder(order, committee);
  engine.submitSealed(sealed);
  console.log("sealed order id:", orderId);
  console.log("public orderflow size:", orderFlow.size());
  console.log("public view before opening:", engine.publicView(orderId));

  // Client distributes shares privately; demo submits threshold shares directly.
  for (const share of shares.slice(0, 3)) engine.submitShare(orderId, share);

  const depositTag = engine.depositTag(orderId);
  console.log("Mock inbound deposit tag:", depositTag);
  bitcoin.queueInbound({
    depositTag,
    chain: "bitcoin",
    asset: "BTC",
    txHash: "mock-btc-inbound",
    amountBaseUnits: 1_000_000_000n, // 10 BTC
    confirmations: 2,
    observedAt: Date.now(),
  });

  const completed = await engine.run(orderId, {
    advanceTime: (dt) => {
      now += dt;
    },
  });

  const oneShotPools = makePools();
  const oneShot = new HubRouter(oneShotPools, 30).quote("BTC", "ETH", 1_000_000_000n);

  console.log("state:", completed.state);
  console.log("subswaps:", completed.completedSubswaps);
  console.log("one-shot netOutThor:", oneShot.netOutThor.toString());
  console.log("streamed netOutThor:", completed.totalNetOutThor.toString());
  console.log("total fee NYX thor:", completed.totalFeeNyxThor.toString());
  console.log("treasury:", treasury.snapshot());
  const arbCount = completed.subswaps.reduce((n, s) => n + s.arbActions.length, 0);
  console.log("arb rebalances:", arbCount);
  if (completed.outbound) {
    console.log(
      "outbound:",
      completed.outbound.asset,
      fromBaseUnits(completed.outbound.asset, completed.outbound.amountBaseUnits),
    );
  }
  console.log("outbound tx:", completed.signed?.txHash);
  if (completed.state !== "completed") {
    throw new Error(`demo failed: ${completed.error ?? completed.state}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
