import { SealFheClient, SealFheEvaluator } from "./fhe/seal.js";
import { createEncryptedIntent, decryptIntentAmounts } from "./core/intent.js";
import { decryptQuote } from "./core/matcher.js";
import { ReferencePool, PoolBook } from "./core/pool.js";
import { SwapEngine, type IntentOpener } from "./core/engine.js";
import { assessPrivacy } from "./core/privacy.js";
import { MockChainAdapter } from "./chains/mock.js";
import { MockThresholdSigner } from "./chains/types.js";
import { fromBaseUnits } from "./assets.js";

async function main(): Promise<void> {
  console.log("FHE cross-chain swap demo — BTC/ETH/XMR/ZEC/DAI only");

  const client = await SealFheClient.create();
  const evaluator = await SealFheEvaluator.fromBundle(client.publicBundle());

  const pools = new PoolBook();
  pools.add(
    new ReferencePool({
      pair: { from: "XMR", to: "ZEC" },
      reserveInThor: 10_000_000_000n, // 100 XMR in thor units
      reserveOutThor: 20_000_000_000n, // 200 ZEC in thor units
      feeBps: 30,
      maxInputThor: 1_000_000_000n,
    }),
  );

  const monero = new MockChainAdapter({
    chain: "monero",
    assets: ["XMR"],
    vaults: { XMR: { address: "xmr-vault-shielded", confirmations: 10 } },
  });
  const zcash = new MockChainAdapter({
    chain: "zcash",
    assets: ["ZEC"],
    vaults: { ZEC: { address: "zec-vault-orchard", confirmations: 10 } },
  });

  const intent = createEncryptedIntent(client, {
    from: "XMR",
    to: "ZEC",
    amount: "1.0",
    minOut: "1.9",
    destination: "zec-destination-fresh",
    refundAddress: "xmr-refund-fresh",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    memoHash: "demo-memo-hash",
  });

  console.log("intent id:", intent.header.id);
  console.log("privacy:", assessPrivacy(intent.header.pair).level);
  const opened = decryptIntentAmounts(client, intent);
  console.log("client sees amountThor:", opened.amountThor.toString());

  const opener: IntentOpener = {
    async open(i) {
      const { amountThor, minOutThor } = decryptIntentAmounts(client, i);
      return { amountThor, minOutThor };
    },
  };

  const engine = new SwapEngine({
    evaluator,
    pools,
    adapters: { monero, zcash },
    signer: new MockThresholdSigner(),
    opener,
    requireShieldedLeg: true,
  });

  const record = engine.submitIntentWithPayload(intent);
  if (!record.quote) throw new Error("missing quote");
  const quote = decryptQuote(client, intent, record.quote);
  console.log("encrypted quote decrypted by client:", {
    netOutThor: quote.netOutThor.toString(),
    feeThor: quote.feeThor.toString(),
    meetsMinOut: quote.meetsMinOut,
  });
  if (!quote.meetsMinOut) throw new Error("quote does not meet minOut");

  monero.queueInbound({
    intentId: intent.header.id,
    chain: "monero",
    asset: "XMR",
    txHash: "mock-xmr-inbound-tx",
    amountBaseUnits: 1_000_000_000_000n, // 1 XMR
    confirmations: 10,
    observedAt: Date.now(),
  });

  await engine.observeInbound(intent.header.id);
  const settled = await engine.settle(intent.header.id);
  console.log("state:", settled.state);
  if (settled.outbound) {
    console.log(
      "outbound:",
      settled.outbound.asset,
      fromBaseUnits(settled.outbound.asset, settled.outbound.amountBaseUnits),
    );
  }
  console.log("outbound tx:", settled.signed?.txHash);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
