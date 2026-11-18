import { randomBytes } from "node:crypto";
import { formatUnits, parseUnits } from "ethers";
import { nativeAsset, parseNativeAssetArg } from "../src/network-catalog.mjs";
import { setupLocalZk } from "./zk-local-setup.mjs";
import { demoLiquidity, demoOracle } from "../../../scripts/note-fixtures.mjs";
import { openValueNoteEvm } from "../test/support/vault-evm.mjs";
import { newValueNote, prepareNoteSpend, proveNoteSpend, valueAmount, valueNoteKey } from "../packages/client/src/zk-value-note.mjs";
import { MockNoteMarket } from "../packages/sim/src/note-market.mjs";

const flags = process.argv.slice(2);
const toNote = flags[0] === "--note";
const args = toNote ? flags.slice(1) : flags;
const format = (id, n) => `${formatUnits(n, nativeAsset(id).decimals)} ${id}`;

function parse(id, text) {
  const { decimals } = nativeAsset(id);
  if (text.length > 80 || !/^\d+(\.\d+)?$/.test(text) || (text.split(".")[1]?.length ?? 0) > decimals) {
    throw new Error(`amount must be a positive decimal string with at most ${decimals} fractional digits`);
  }
  return valueAmount(parseUnits(text, decimals));
}

let evm;
try {
  if (args.length !== 0 && args.length !== 4) {
    throw new Error("usage: npm run demo:notes -- [--note] <coin@source-network> <coin@target-network> <deposit> <receive>");
  }
  const [source = "ETH", target = "BTC", depositText = "0.731234567891234567", payoutText = "0.01000003"] = args;
  const from = parseNativeAssetArg(source), to = parseNativeAssetArg(target);
  const received = parse(from, depositText), requested = parse(to, payoutText);
  console.log("MÔ PHỎNG LOCAL — giá oracle và dự trữ mẫu, không nạp/rút trên chain thật.");
  const zk = setupLocalZk("notes");
  evm = await openValueNoteEvm(zk.verifier);
  const now = () => Math.floor(Date.now() / 1_000);
  const oracle = demoOracle(now);
  await oracle.refresh();
  const market = new MockNoteMarket({ oracle, now, liquidity: demoLiquidity(),
    verifySpend: (proof, signals) => evm.verifier.verifyProof(...proof, signals) });
  const note = newValueNote(market.position(from).domain, received);
  const { leafIndex } = market.creditConfirmed({ asset: from, received, confirmations: 2,
    txid: randomBytes(32).toString("hex"), noteKey: valueNoteKey(note) });
  const quote = market.quote(from, to, "output", requested);
  console.log("Nạp vào note:", format(from, received));
  console.log("Muốn nhận:", format(to, requested), "| Cần trừ theo pool:", format(from, quote.amountIn));
  // In this demo only, generate the recipient's note locally as well. A client
  // would keep it privately and send only its one-time note key to the payer.
  const destination = toNote
    ? { kind: "note", noteKey: valueNoteKey(newValueNote(market.position(to).domain, quote.amountOut)) }
    : `mock-${nativeAsset(to).network}-recipient`;
  const { payoutBinding } = market.preparePayout(quote, destination);
  const { input, change } = prepareNoteSpend(note, market.witnessPath(from, leafIndex), quote.amountIn, payoutBinding);
  const { solidity } = await proveNoteSpend(input, zk);
  const payout = await market.withdraw({ quote, destination,
    root: input.root, nullifierHash: input.nullifierHash, changeCommitment: input.changeCommitment, proof: solidity });
  console.log(payout.receivedNote ? "Groth16 hợp lệ. Đã ghi note đích mô phỏng:" : "Groth16 hợp lệ. Đã ghi chi mô phỏng:",
    format(payout.to, payout.amountOut), `(${payout.chainRef})`);
  console.log("Còn trong note mới:", format(from, BigInt(change?.amount ?? 0n)));
} catch (error) {
  console.error("Không thể rút:", error.message);
  process.exitCode = 1;
} finally {
  evm?.close();
}
