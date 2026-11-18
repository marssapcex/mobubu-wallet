import { createEncryptedIntent } from "./core/intent.js";
import { decryptQuote, EncryptedMatcher } from "./core/matcher.js";
import { ReferencePool } from "./core/pool.js";
import { SealFheClient, SealFheEvaluator } from "./fhe/seal.js";

console.log("Local BFV quote demo — BNB → BTC with sample reserves, no chain, deposit or signer");
const client = await SealFheClient.create();
const evaluator = await SealFheEvaluator.fromBundle(client.publicBundle());
const intent = createEncryptedIntent(client, {
  from: "BNB", to: "BTC", amount: "1.0", minOut: "0.0049",
  destination: "fixture-destination", refundAddress: "fixture-refund",
  deadline: Math.floor(Date.now() / 1000) + 3600,
});
const pool = new ReferencePool({
  pair: { from: "BNB", to: "BTC" }, reserveInThor: 10_000_000_000n, reserveOutThor: 50_000_000n,
  feeBps: 30, maxInputThor: 1_000_000_000n,
});
const quote = new EncryptedMatcher(evaluator).quote(intent, pool.quote());
console.log("Client verified quote arithmetic:", decryptQuote(client, intent, quote));
