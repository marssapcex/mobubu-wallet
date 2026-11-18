import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnits } from "ethers";
import { NATIVE_ASSET_IDS, nativeAsset } from "../../../fhe-swap/src/network-catalog.mjs";
import { setupLocalZk } from "../scripts/zk-local-setup.mjs";
import { demoLiquidity, demoOracle } from "../../../scripts/note-fixtures.mjs";
import { MockNoteMarket } from "../packages/sim/src/note-market.mjs";
import { AMOUNT_LIMIT, newValueNote, prepareNoteSpend, proveNoteSpend, valueNoteKey, valueNoteLeaf } from "../packages/client/src/zk-value-note.mjs";
import { openValueNoteEvm } from "./support/vault-evm.mjs";

const BTC = "BTC@bitcoin", ETH = "ETH@ethereum", BNB = "BNB@bsc", BASE = "ETH@base", OP = "ETH@optimism";
const units = (id, amount) => parseUnits(amount, nativeAsset(id).decimals);
const tx = (n) => n.toString(16).padStart(64, "0");
const kOf = ({ assetReserve, hubReserve }) => assetReserve * hubReserve;

async function marketFor(opts = {}) {
  const { now = () => 10_000, oracle = demoOracle(now), ...rest } = opts;
  if (!opts.oracle) await oracle.refresh();
  return new MockNoteMarket({ liquidity: demoLiquidity(), verifySpend: () => false, now, oracle, ...rest });
}

function deposit(market, asset, received, id) {
  const note = newValueNote(market.position(asset).domain, received);
  const credit = market.creditConfirmed({ asset, received, txid: tx(id), confirmations: 2, noteKey: valueNoteKey(note) });
  return { note, leafIndex: credit.leafIndex };
}

function spotBound(market, q) {
  const inPool = market.position(q.from), outPool = market.position(q.to);
  assert.ok(q.amountOut * inPool.assetReserve * outPool.hubReserve <= q.amountIn * inPool.hubReserve * outPool.assetReserve);
  assert.ok(q.feeHub * 10_000n >= q.grossHub * 30n);
  assert.ok((q.feeHub - 1n) * 10_000n < q.grossHub * 30n);
}

test("all 90 cross-network quotes round conservatively, including same-symbol ETH", async () => {
  const market = await marketFor();
  let directions = 0;
  for (const from of NATIVE_ASSET_IDS) for (const to of NATIVE_ASSET_IDS) {
    if (from === to) continue;
    const wanted = market.position(to).assetReserve / 357_119n + 1n;
    const q = market.quote(from, to, "output", wanted);
    assert.equal(q.amountOut, wanted);
    assert.equal(typeof q.oracleId, "string");
    assert.notEqual(market.position(from).domain, market.position(to).domain);
    spotBound(market, q);
    const at = market.quote(from, to, "input", q.amountIn);
    assert.ok(at.amountOut >= wanted);
    spotBound(market, at);
    const below = market.quote(from, to, "input", at.amountIn - 1n);
    assert.ok(below.amountOut < wanted, `${from} -> ${to} rounded source down`);
    directions++;
  }
  assert.equal(directions, 90);
  for (const id of NATIVE_ASSET_IDS) {
    const q = market.quote(id, id, "output", 1n);
    assert.equal(q.amountOut, 1n);
    assert.equal(q.amountIn, 1n);
    assert.equal(q.feeHub, 0n);
    assert.equal(q.oracleId, null);
  }
  assert.throws(() => market.quote(ETH, BTC, "input", 1n), /too small/);
  assert.throws(() => market.quote(ETH, BTC, "output", market.position(BTC).assetReserve), /liquidity/);
  assert.throws(() => market.quote(ETH, BTC, "output", AMOUNT_LIMIT), /out of range/);
});

test("rejects wrapped assets, wrong network for the coin, and bare symbols at the ledger", async () => {
  const market = await marketFor();
  const before = market.position(ETH);
  const note = newValueNote(before.domain, 1n);
  const quote = market.quote(ETH, BTC, "output", units(BTC, "0.001"));
  for (const asset of ["WBNB@bsc", "WBTC@ethereum", "WETH@base", "BTCB@bsc", "USDC@base", "BNB@ethereum", "ETH@bsc", "BTC@base", "ETH", "__proto__"]) {
    assert.throws(() => market.creditConfirmed({ asset, received: 1n, noteKey: valueNoteKey(note),
      txid: tx(42), confirmations: 2 }), /unsupported native asset/);
    assert.throws(() => market.quote(asset, BTC, "output", 1n), /unsupported native asset/);
    assert.throws(() => market.quote(ETH, asset, "output", 1n), /unsupported native asset/);
    assert.throws(() => market.preparePayout({ ...quote, to: asset }, "mock-receiver"), /unsupported native asset/);
  }
  assert.deepEqual(market.position(ETH), before);
});

test("deposit credit uses confirmed fixture receipts and canonical network-scoped txids", async () => {
  const market = await marketFor();
  const eth = newValueNote(market.position(ETH).domain, 99n);
  const claim = { asset: ETH, received: 97n, txid: tx(42), confirmations: 2, noteKey: valueNoteKey(eth) };
  assert.throws(() => market.creditConfirmed({ ...claim, confirmations: 1 }), /not confirmed/);
  const stored = market.creditConfirmed(claim);
  assert.equal(market.position(ETH).noteBalance, 97n);
  assert.throws(() => prepareNoteSpend(eth, market.witnessPath(ETH, stored.leafIndex), 12n, 34n), /credited leaf/);
  assert.throws(() => market.creditConfirmed({ ...claim, txid: `0x${tx(42).toUpperCase()}` }), /already credited/);
  assert.throws(() => market.creditConfirmed({ ...claim, txid: tx(43) }), /key already used/);
  const base = market.creditConfirmed({ ...claim, asset: BASE });
  assert.equal(base.root, stored.root);
  assert.notEqual(market.position(ETH).domain, market.position(BASE).domain);
  assert.equal(market.position(ETH).noteBalance, 97n);
});

function prepare(market, coin, quote, destination) {
  const payout = market.preparePayout(quote, destination);
  return prepareNoteSpend(coin.note, market.witnessPath(quote.from, coin.leafIndex), quote.amountIn, payout.payoutBinding);
}

async function request(market, zk, coin, quote, destination) {
  const { input, change } = prepare(market, coin, quote, destination);
  const { solidity, publicSignals } = await proveNoteSpend(input, zk);
  const { root, nullifierHash, changeCommitment } = input;
  return { change, publicSignals, spend: { quote, destination, root, nullifierHash, changeCommitment, proof: solidity } };
}

function assertSettlement(market, q, beforeFrom, beforeTo, feeBefore, noteDelivery = false) {
  const from = market.position(q.from), to = market.position(q.to);
  assert.equal(from.noteBalance, beforeFrom.noteBalance - q.amountIn);
  assert.equal(to.noteBalance, beforeTo.noteBalance + (noteDelivery ? q.amountOut : 0n));
  assert.equal(from.assetReserve, beforeFrom.assetReserve + q.amountIn);
  assert.equal(to.assetReserve, beforeTo.assetReserve - q.amountOut);
  assert.equal(from.hubReserve + to.hubReserve + q.feeHub, beforeFrom.hubReserve + beforeTo.hubReserve);
  assert.equal(market.collectedHubFee, feeBefore + q.feeHub);
  assert.ok(kOf(from) >= kOf(beforeFrom));
  assert.ok(kOf(to) >= kOf(beforeTo));
}

test("pool and oracle terms fail closed, including after an asynchronous verifier", async () => {
  let time = 10_000;
  const now = () => time;
  const oracle = demoOracle(now);
  await oracle.refresh();
  let advanceDuringVerify = true;
  const market = await marketFor({ now, oracle, verifySpend: async () => {
    if (advanceDuringVerify) { time += 1; await oracle.refresh(); }
    return true; // Mock verifier here tests the settlement race, not cryptography.
  } });
  const coin = deposit(market, ETH, units(ETH, "1"), 10);
  const q = market.quote(ETH, BASE, "output", units(BASE, "0.1"));
  assert.equal(q.validUntil, time + 180);
  assert.throws(() => market.preparePayout({ ...q, validUntil: q.validUntil + 1 }, "receiver"), /outlives the oracle/);
  assert.throws(() => market.preparePayout({ ...q, oracleId: "forged" }, "receiver"), /snapshot changed/);
  const skewed = demoLiquidity();
  skewed[BASE].assetReserve /= 2n;
  const mispriced = await marketFor({ now, oracle, liquidity: skewed });
  assert.throws(() => mispriced.quote(ETH, BASE, "output", units(BASE, "0.1")), /deviates from oracle/);
  const beforeFrom = market.position(ETH), beforeTo = market.position(BASE);
  function spend(quote) {
    const { input } = prepare(market, coin, quote, "receiver");
    const { root, nullifierHash, changeCommitment } = input;
    return market.withdraw({ quote, destination: "receiver", root, nullifierHash, changeCommitment, proof: [[], [], []] });
  }
  await assert.rejects(spend(q), /snapshot changed/);
  assert.deepEqual(market.position(ETH), beforeFrom);
  assert.deepEqual(market.position(BASE), beforeTo);
  assert.equal(market.collectedHubFee, 0n);
  advanceDuringVerify = false;
  const fresh = market.quote(ETH, BASE, "output", q.amountOut);
  assert.equal((await spend(fresh)).chain, "base");
  time = fresh.validUntil;
  assert.throws(() => market.quote(ETH, BASE, "output", q.amountOut), /oracle snapshot unavailable or expired/);
  assert.equal(market.quote(ETH, ETH, "output", 1n).amountOut, 1n);
});

test("duplicate output would not partially append source change or spend the note", async () => {
  const market = await marketFor({ verifySpend: () => true });
  const coin = deposit(market, BNB, 100n, 1);
  const before = market.position(BNB);
  const quote = market.quote(BNB, BNB, "output", 50n);
  const receiver = newValueNote(before.domain, 50n);
  const destination = { kind: "note", noteKey: valueNoteKey(receiver) };
  const { input } = prepare(market, coin, quote, destination);
  const spend = { quote, destination, root: input.root, nullifierHash: input.nullifierHash, proof: [[], [], []] };
  // An injected test verifier accepts invalid statements. The ledger should still
  // preflight the two leaves together before touching either of them.
  await assert.rejects(market.withdraw({ ...spend, changeCommitment: valueNoteLeaf(destination.noteKey, 50n) }), /duplicate commitment/);
  assert.deepEqual(market.position(BNB), before);
  const paid = await market.withdraw({ ...spend, changeCommitment: input.changeCommitment });
  assert.equal(paid.kind, "note-transfer");
  assert.equal(market.position(BNB).noteBalance, 100n);
  assert.equal(paid.receivedNote.leafIndex, paid.change.leafIndex + 1);
  assert.throws(() => market.preparePayout(quote, destination), /key already used/);
});

test("real v3 proofs settle across all ten native ledgers and bind each destination network", async (t) => {
  const zk = setupLocalZk("notes");
  const evm = await openValueNoteEvm(zk.verifier);
  t.after(() => evm.close());
  let time = 10_000;
  const now = () => time;
  const oracle = demoOracle(now);
  await oracle.refresh();
  const market = await marketFor({ now, oracle, verifySpend: (p, fields) => evm.verifier.verifyProof(...p, fields) });
  const total = units(ETH, "0.731234567891234567");
  const eth = deposit(market, ETH, total, 1);
  const wanted = 1_000_003n;
  const expired = market.quote(ETH, BTC, "output", wanted);
  time += 181;
  assert.throws(() => market.preparePayout(expired, "mock-bitcoin"), /expired/);
  await oracle.refresh();
  const current = market.quote(ETH, BTC, "output", wanted);
  const startEth = market.position(ETH), startBtc = market.position(BTC);
  const unaffordable = market.quote(ETH, BTC, "output", units(BTC, "0.1"));
  assert.throws(() => prepare(market, eth, unaffordable, "mock-bitcoin"), /exceeds note/);
  assert.throws(() => market.preparePayout({ ...current, amountIn: current.amountIn - 1n }, "mock-bitcoin"), /quote terms/);
  const { change, spend, publicSignals } = await request(market, zk, eth, current, "mock-bitcoin");
  await assert.rejects(market.withdraw({ ...spend, destination: "different-mock-address" }), /invalid note spend proof/);
  await assert.rejects(market.withdraw({ ...spend, changeCommitment: 0n }), /invalid note spend proof/);
  const other = market.creditConfirmed({ asset: BASE, received: total, confirmations: 2, txid: tx(1), noteKey: valueNoteKey(eth.note) });
  assert.equal(other.root, startEth.root);
  const mixed = market.quote(BASE, BTC, "output", wanted);
  assert.equal(mixed.amountIn, current.amountIn);
  await assert.rejects(market.withdraw({ ...spend, quote: mixed }), /invalid note spend proof/);
  assert.equal(await evm.verifier.verifyProof(...spend.proof, [...publicSignals.slice(0, 5), market.position(BASE).domain]), false);
  assert.equal(market.position(BASE).noteBalance, total);
  assert.deepEqual(market.position(ETH), startEth);
  assert.deepEqual(market.position(BTC), startBtc);
  const outcomes = await Promise.allSettled([market.withdraw(spend), market.withdraw(spend)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const result = outcomes.find((r) => r.status === "fulfilled").value;
  assert.equal(result.chain, "bitcoin");
  assert.equal(result.amountOut, wanted);
  assert.equal(market.getPayout(result.payoutId), result);
  assert.equal(BigInt(change.amount), total - current.amountIn);
  assertSettlement(market, current, startEth, startBtc, 0n);
  assert.throws(() => market.preparePayout(current, "mock-bitcoin"), /stale/);
  const replay = await request(market, zk, eth, market.quote(ETH, ETH, "output", 1n), "mock-ethereum");
  await assert.rejects(market.withdraw(replay.spend), /already spent/);

  const cases = [
    [BTC, ETH, "input", result.amountOut, result.amountOut],
    [BTC, BNB, "input", units(BTC, "0.04321987"), units(BTC, "0.01567891")],
    [ETH, BNB, "input", units(ETH, "1.234567890123456789"), units(ETH, "0.423456789101234567")],
    [BNB, BTC, "output", units(BNB, "13.123456789012345678"), units(BTC, "0.01")],
    [BNB, BASE, "input", units(BNB, "19.123456789012345678"), units(BNB, "7.012345678909876543")],
  ];
  const ethNetworks = [BASE, "ETH@arbitrum-one", OP, "ETH@zksync-era", "ETH@linea", "ETH@scroll", "ETH@robinhood", ETH];
  for (let i = 0; i < ethNetworks.length - 1; i++) {
    cases.push([ethNetworks[i], ethNetworks[i + 1], "output", units(ETH, "0.2"), units(ETH, "0.1")]);
  }
  const touched = new Set([ETH, BTC]);
  for (const [i, [from, to, mode, paid, amount]] of cases.entries()) {
    const coin = deposit(market, from, paid, i + 2);
    const q = market.quote(from, to, mode, amount);
    const [a, b, fee] = [market.position(from), market.position(to), market.collectedHubFee];
    const destination = "mock-recipient";
    const claim = await request(market, zk, coin, q, destination);
    if (from === BASE) {
      const samePrice = market.quote(BASE, OP, "output", amount);
      assert.equal(q.amountIn, samePrice.amountIn);
      assert.equal(q.amountOut, samePrice.amountOut);
      await assert.rejects(market.withdraw({ ...claim.spend, quote: samePrice }), /invalid note spend proof/);
    }
    const done = await market.withdraw(claim.spend);
    touched.add(from); touched.add(to);
    assert.equal(done.chain, nativeAsset(to).network);
    assert.equal(done.chainRef, nativeAsset(to).chainRef);
    assert.equal(done.destination, destination);
    assert.equal(done.amountOut, q.amountOut);
    assert.equal(done.amountIn, q.amountIn);
    assert.equal(done.change === null, paid === q.amountIn);
    assert.equal(BigInt(claim.change?.amount ?? 0), paid - q.amountIn);
    if (done.change) {
      assert.equal(claim.change.domain, a.domain.toString());
      assert.equal(market.witnessPath(from, done.change.leafIndex).leaf, valueNoteLeaf(valueNoteKey(claim.change), paid - q.amountIn));
    }
    assertSettlement(market, q, a, b, fee);
    if (from === BNB && to === BASE) {
      const before = market.position(BNB);
      const small = await request(market, zk, { note: claim.change, leafIndex: done.change.leafIndex },
        market.quote(BNB, BNB, "output", 1n), "mock-bsc");
      const tiny = await market.withdraw(small.spend);
      assert.equal(tiny.amountOut, 1n);
      assert.equal(tiny.feeHub, 0n);
      assert.equal(market.position(BNB).noteBalance, before.noteBalance - 1n);
      assert.equal(market.position(BNB).assetReserve, before.assetReserve);
    }
  }
  assert.deepEqual([...touched].sort(), [...NATIVE_ASSET_IDS].sort());

  const paying = deposit(market, BASE, units(BASE, "0.2"), 50);
  const q = market.quote(BASE, OP, "output", units(OP, "0.005000000000000001"));
  const recv = newValueNote(market.position(OP).domain, q.amountOut);
  const targetNote = { kind: "note", noteKey: valueNoteKey(recv) };
  const [a, b, fee] = [market.position(BASE), market.position(OP), market.collectedHubFee];
  const claim = await request(market, zk, paying, q, targetNote);
  const otherKey = valueNoteKey(newValueNote(b.domain, q.amountOut));
  await assert.rejects(market.withdraw({ ...claim.spend, destination: { kind: "note", noteKey: otherKey } }), /invalid note spend proof/);
  await assert.rejects(market.withdraw({ ...claim.spend, destination: "mock-op-address" }), /invalid note spend proof/);
  assert.deepEqual(market.position(OP), b);
  const made = await market.withdraw(claim.spend);
  assert.equal(made.kind, "note-transfer");
  assert.equal(made.destination, null);
  assert.equal(made.receivedNote.commitment, valueNoteLeaf(targetNote.noteKey, q.amountOut));
  assertSettlement(market, q, a, b, fee, true);
  const onTarget = market.quote(OP, OP, "output", q.amountOut);
  const receiverClaim = await request(market, zk, { note: recv, leafIndex: made.receivedNote.leafIndex }, onTarget, "mock-op-address");
  assert.equal((await market.withdraw(receiverClaim.spend)).amountOut, q.amountOut);
  assert.equal(market.position(OP).noteBalance, b.noteBalance);
});
