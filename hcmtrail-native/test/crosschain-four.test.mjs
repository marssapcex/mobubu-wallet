import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBytes, hexlify, id, Interface, ZeroAddress, ZeroHash } from 'ethers';
import { test } from 'node:test';
import { compileCrosschain } from '../scripts/build-crosschain.mjs';
import { orderId, previewOrder, proveCrosschain, rateHash, saveCrosschainRefund } from '../testnet/crosschain.mjs';
import { callSpec, createSpec } from '../testnet/deployment.mjs';
import { openNote } from '../testnet/notes.mjs';
import { checkProver, proofHash } from '../testnet/prover.mjs';
import { json, outsideSource } from '../testnet/store.mjs';
import { TestnetWallet } from '../testnet/wallet.mjs';
import { certificate, feeCost, on, reverts, signer, witnesses } from './crosschain-fixture.mjs';
import { walletFixture } from './testnet-fixture.mjs';
import { verifyHistoricalSettlement } from './receipt-proof-shadow.mjs';

process.umask(0o077);
const generate = process.env.NATIVE_FOUR_ROUTE_GENERATE === '1';
const prover = generate ? checkProver(process.env.NATIVE_STARK_PROVER_DIR) : null;
const output = generate && process.env.NATIVE_CROSSCHAIN_VECTORS_DIR ? outsideSource(process.env.NATIVE_CROSSCHAIN_VECTORS_DIR) : null;
const vectors = fileURLToPath(new URL('./vectors/crosschain/four/', import.meta.url));
const NAMES = ['ETH', 'BNB', 'TRX', 'HYPE'];
const USD18 = [2500n * 10n ** 18n, 600n * 10n ** 18n, 35_410_123n * 10n ** 10n, 80n * 10n ** 18n];
const START = 1_796_100_000n;
const testTag = 'four-asset-crosschain-v1 fixtures only';
const units = (f) => 10n ** BigInt(f.chain.network.decimals);
const net = (x) => x - x / 400n;
const price = ({ chain }) => USD18[Number(chain.network.assetId)];
const amountOut = (a, b, input) => input * price(a) * units(b) / (price(b) * units(a));
const parseRate = (source, raw) => source.abi.decodeFunctionResult('quote', raw);

async function setup(t, asset, compiled) {
  const f = await walletFixture(asset, undefined, { dao: true, nile: { modelFees: true } });
  t.after(f.close);
  const { chain, txs, store, manifest: m } = f;
  await f.setTime(START);
  const a = compiled[Number(!!chain.network.tvm)];
  const quorum = await on(f, a, 'ReceiptQuorum', [witnesses.map((w) => w.address)]);
  const feeds = [];
  for (const coin of NAMES) {
    const { contractAddress: at } = await txs.submit(`four-feed-${coin}`, createSpec(a.FeedFixture, 'FeedFixture', [8]));
    feeds.push(at);
  }
  // Allow clocks to move during VM transactions while never consulting wall time for TRON TAPOS.
  const oracle = await on(f, a, 'ChainlinkPriceEpochs', [chain.network.chainId, feeds.map((at) => [at, 1800, 8, 1, 10n ** 24n]),
    120, 0, ZeroAddress, 0]);
  const { prepare, walk, chunks } = m.stack;
  const gate = await on(f, a, 'SpendGate', [prepare, walk, chunks]);
  const source = await on(f, a, 'CrosschainNoteVault', [m.dao.treasury, oracle.at, gate.at, quorum.at]);
  const wallet = new TestnetWallet(chain, store, txs, {
    ...m, vault: source.at, domain: await source.read('domain'), domainLeaf: await source.read('domainLeaf'),
    created: { tx: source.receipt.hash, block: String(source.receipt.blockNumber), blockHash: source.receipt.blockHash },
  }, a.CrosschainNoteVault.abi);
  const reportPrices = async (seq = 1n) => {
    const stamp = (await chain.head()).timestamp;
    for (let i = 0; i < NAMES.length; ++i) {
      await txs.submit(`four-report-${seq}-${i}`, callSpec(new Interface(a.FeedFixture.abi), feeds[i], 'report',
        [seq, USD18[i] / 10n ** 10n, stamp, stamp]));
    }
  };
  await reportPrices();
  assert.equal((await oracle.read('publishedEpoch')).id, ZeroHash);
  return { ...f, a, quorum, oracle, source, wallet, reportPrices, sponsor: signer(f, 'sponsor-four'), treasury: m.dao.treasury };
}

function vector(name) {
  const filename = resolve(vectors, name);
  const proof = hexlify(readFileSync(`${filename}.bin`));
  const data = JSON.parse(readFileSync(`${filename}.json`));
  assert.equal(proofHash(proof), data.proofId);
  return { ...data, proof };
}

function save(name, { proof, seconds, ...publicData }) {
  if (!output) return;
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const filename = resolve(output, name);
  writeFileSync(`${filename}.bin`, getBytes(proof), { mode: 0o600, flag: 'wx' });
  writeFileSync(`${filename}.json`, json({ ...publicData, proofId: proofHash(proof) }), { mode: 0o600, flag: 'wx' });
}

function known(f, value, tag) {
  return openNote(f.chain.network, value, [4n, 23n, 59n, 97n].map((x) => x + tag), [26n, 37n, 78n, 301n].map((x) => x + 2n * tag));
}

async function accounting(f, src, note, escrow, credit) {
  assert.equal(await src.read('accountedNative'), note);
  assert.equal(await src.read('escrowNative'), escrow);
  assert.equal(await src.read('creditedNative'), credit);
  assert.equal(await f.chain.balance(src.at), note + escrow + credit);
}
async function inventory(f, lp, free, reserved) {
  assert.equal(await lp.read('freeLiquidity', [f.chain.sender]), free);
  assert.equal(await lp.read('availableNative'), free);
  assert.equal(await lp.read('reservedNative'), reserved);
  assert.equal(await f.chain.balance(lp.at), free + reserved);
}
async function sponsored(f, label, spec) {
  const { sponsor, chain } = f;
  const payer = sponsor.chain.sender;
  assert.notEqual(chain.sender, payer);
  const [before, owner] = await Promise.all([chain.balance(payer), chain.balance(chain.sender)]);
  const receipt = await sponsor.submit(label, spec);
  assert.equal(receipt.from, payer);
  assert(feeCost(receipt) > 0n);
  assert.equal(await chain.balance(payer), before - feeCost(receipt));
  assert.equal(await chain.balance(chain.sender), owner);
  return receipt;
}

// ETH -> HYPE with the user-facing $2500/$80 example is in crosschain.test.mjs. Together the
// two suites run a four-asset cycle and prove each asset as both funded input and native output.
test(`Four-asset matrix: 12 quotes and ${generate ? 'new' : 'pinned'} HYPE→TRX→BNB→ETH settlement proofs`,
  { timeout: generate ? 3_900_000 : 260_000 }, async (t) => {
    const compiled = [compileCrosschain({ fixtures: true }), compileCrosschain({ tvm: true, fixtures: true })];
    const f = {};
    for (const asset of NAMES) f[asset] = await setup(t, asset, compiled);
    // Quotes only: compare each directed pair to independent base-unit arithmetic at 3 debits.
    // Passing this loop does NOT imply custody or liquidity. That is exercised below with real txs.
    let quotes = 0;
    for (const a of Object.values(f)) for (const b of Object.values(f)) {
      if (a === b) continue;
      const refundOwnerCommit = known(a, units(a), 41n).ownerCommit;
      for (const amountIn of [units(a), units(a) * 17n / 19n + 1n, units(a) * 3n + 7n]) {
        const gross = amountOut(a, b, amountIn);
        const stamp = (await a.chain.head()).timestamp;
        const o = { sourceChain: a.chain.network.chainId, sourceVault: a.source.at, destinationChain: b.chain.network.chainId,
          destinationVault: b.source.at, amountIn, minNetOut: net(gross), liquidityLimit: gross,
          recipient: b.chain.sender, sourceLP: a.chain.sender, destinationLP: b.chain.sender, refundOwnerCommit,
          salt: id(testTag), acceptBy: stamp + 1600n, payBy: stamp + 3600n };
        const [r, fee, paid] = parseRate(a.source, await a.chain.call(a.source.spec('quote', [o])));
        assert.equal(r.grossOut, gross);
        assert.equal(fee, gross / 400n);
        assert.equal(paid, net(gross));
        assert.deepEqual(previewOrder(o, price(a), price(b)), { gross, fee, net: paid });
        quotes++;
      }
    }
    assert.equal(quotes, 36);
    console.log(`Checked ${quotes} exact base-unit amount/fee quotes (12 directed routes; no custody inferred).`);

    const points = [
      ['HYPE', 'TRX', 19_876_543_210_123_457n, undefined], // nonintegral sun conversion and fee
      ['TRX', 'BNB', 16_123_457n, 11_234_569n], // partial withdrawal: source change stays in TRX
      ['BNB', 'ETH', 1_000_000_000_000_000_003n, undefined], // nondivisible wei deposit
    ];
    for (const [src, dst, grossIn, partial] of points) {
      const a = f[src], b = f[dst], key = `${src}-${dst}`.toLowerCase();
      // Reset report age for this independent test order (virtual clock only). No price keeper refresh.
      // Quote and lock occur well inside the original bounds. On all other chains time can differ.
      await a.reportPrices(2n);
      const sourceChain = a.chain.network.chainId, destinationChain = b.chain.network.chainId;
      const lp = await on(b, b.a, 'CrosschainLiquidity', [sourceChain, a.source.at, b.treasury, b.quorum.at]);
      const receiver = await on(b, b.a, 'PayoutSwitch');
      await b.txs.submit(`allow-four-${key}`, receiver.spec('allowPayment'));
      const value = net(grossIn), debit = partial ?? value, change = value - debit;
      const note = known(a, value, 57n), refund = known(a, debit, 93n);
      const noteId = a.wallet.keep(note, { kind: 'deposit', gross: grossIn });
      const srcDao0 = await a.chain.balance(a.treasury);
      const dstDao0 = await b.chain.balance(b.treasury);
      const leaf = await a.wallet.deposit(noteId);
      assert.equal(await a.chain.balance(a.treasury) - srcDao0, grossIn / 400n);
      await accounting(a, a.source, value, 0n, 0n);
      const gross = amountOut(a, b, debit), levy = gross / 400n, payout = net(gross);
      if (dst === 'TRX') {
        assert.notEqual((debit * price(a) * units(b)) % (price(b) * units(a)), 0n);
        assert.notEqual(gross % 400n, 0n);
      }
      const maximum = gross + gross / 20n + 7n, funded = maximum + 19n;
      const o = { sourceChain, sourceVault: a.source.at, destinationChain, destinationVault: lp.at, amountIn: debit,
        minNetOut: payout, liquidityLimit: maximum, recipient: receiver.at, sourceLP: a.chain.sender, destinationLP: b.chain.sender,
        refundOwnerCommit: refund.ownerCommit, salt: id(`${testTag} ${key}`), acceptBy: START + 2700n, payBy: START + 5400n };
      const order = orderId(o);
      const quote = parseRate(a.source, await a.chain.call(a.source.spec('quote', [o])));
      assert.equal(quote[0].grossOut, gross);
      assert.equal(quote[2], payout);
      saveCrosschainRefund(a.store, a.chain.network, o, refund);
      await assert.rejects(() => b.chain.call(lp.spec('reserve', [o])), reverts('InsufficientLiquidity'));
      await b.txs.submit(`fund-four-${key}`, lp.spec('fundLiquidity', [], funded));
      await inventory(b, lp, funded, 0n);
      const reservation = await b.txs.submit(`reserve-four-${key}`, lp.spec('reserve', [o]));
      await inventory(b, lp, funded - maximum, maximum);
      const requester = b.sponsor.chain;
      await assert.rejects(() => requester.call(lp.spec('withdrawLiquidity', [1n, requester.sender])), reverts('InsufficientLiquidity'));
      await assert.rejects(() => b.chain.call(lp.spec('withdrawLiquidity', [funded - maximum + 1n, b.chain.sender])), reverts('InsufficientLiquidity'));
      const cert = await certificate(b, lp, reservation, a, a.quorum, a.source, 1, order);
      const snapshot = await a.wallet.ledger.snapshot();
      if (generate) console.log(`Generating funded ${src} → ${dst} proof (order ${order}).`);
      const spend = generate ? await proveCrosschain(a.store, a.chain.network, prover, o, note, leaf.index, snapshot) : vector(key);
      assert.equal(spend.id, order, `${key} fixture order binding`);
      assert.equal(spend.publicSpend.root, snapshot.root, `${key} fixture tree binding`);
      if (generate && change > 0n) {
        const backup = a.store.read(`cross-change-${spend.proofId}.json`);
        assert.equal(backup.leaf, spend.publicSpend.change[0]);
        assert.equal(openNote(a.chain.network, change, backup.secret, backup.blinding).leaf, backup.leaf);
      }
      if (generate) save(key, spend); // fixture is installed only after successful on-chain replay
      const lock = a.source.spec('lockWithdrawal', [o, spend.publicSpend, spend.proof, cert.good]);
      if (a.chain.network.bigBlocks) {
        a.status.bigBlocks = false;
        await assert.rejects(() => a.sponsor.chain.simulate(lock), /usingBigBlocks/);
        a.status.bigBlocks = true;
        await accounting(a, a.source, value, 0n, 0n);
      }
      const locked = await sponsored(a, `lock-four-${key}`, lock);
      const lockEvent = locked.logs.find((l) => l.address === a.source.at && l.topics[0] === a.source.abi.getEvent('WithdrawalLocked').topicHash);
      const rate = a.source.abi.parseLog(lockEvent).args.rate.toObject();
      assert.equal(rate.grossOut, gross);
      assert.equal(rate.priceIn18, price(a));
      assert.equal(rate.priceOut18, price(b));
      await accounting(a, a.source, change, debit, 0n);
      assert.equal(await a.source.read('pendingRefundSlots'), 1n);
      assert.equal(await a.source.read('spent', [spend.publicSpend.nullifiers[0]]), true);
      const lockedProof = await certificate(a, a.source, locked, b, b.quorum, lp, 2, order, rateHash(rate));
      const recipientBefore = await b.chain.balance(receiver.at);
      const paid = await sponsored(b, `pay-four-${key}`, lp.spec('pay', [o, rate, lockedProof.good]));
      assert.equal(await b.chain.balance(receiver.at) - recipientBefore, payout);
      assert.equal(await b.chain.balance(b.treasury) - dstDao0, levy);
      await inventory(b, lp, funded - gross, 0n);
      await assert.rejects(() => b.chain.call(lp.spec('pay', [o, rate, lockedProof.good])), reverts('WrongState'));
      const paidProof = await certificate(b, lp, paid, a, a.quorum, a.source, 3, order, rateHash(rate));
      await sponsored(a, `complete-four-${key}`, a.source.spec('complete', [o, paidProof.good]));
      assert.equal(await a.source.read('liquidityCredit', [a.chain.sender]), debit);
      assert.equal(await a.source.read('pendingRefundSlots'), 0n);
      await accounting(a, a.source, change, 0n, debit);
      // Redeem only LP credit; the remaining change note keeps its full backing.
      const lpBefore = await a.chain.balance(a.chain.sender);
      const credit = await a.txs.submit(`credit-four-${key}`, a.source.spec('withdrawLiquidity', [debit, a.chain.sender]));
      assert.equal(await a.chain.balance(a.chain.sender) - lpBefore + feeCost(credit), debit);
      await accounting(a, a.source, change, 0n, 0n);
      assert.equal(await a.chain.balance(a.treasury) - srcDao0, grossIn / 400n);
      if (key === 'bnb-eth') {
        // Both directions of log verification on a single real trade, without changing the V1 payment path.
        const back = await verifyHistoricalSettlement(b, a, lp, order, [
          { tx: reservation, kind: 1, data: ZeroHash }, { tx: paid, kind: 3, data: rateHash(rate) },
        ]);
        const forward = await verifyHistoricalSettlement(a, b, a.source, order, [{ tx: locked, kind: 2, data: rateHash(rate) }]);
        const gate = await a.source.read('gate');
        // Historical evidence must not become a back door into V1 custody.
        await assert.rejects(() => a.chain.simulate(createSpec(a.a.CrosschainNoteVault, 'CrosschainNoteVault',
          [a.treasury, a.oracle.at, gate, back.at])), reverts('WrongWithdrawalConfig'));
        await assert.rejects(() => b.chain.simulate(createSpec(b.a.CrosschainLiquidity, 'CrosschainLiquidity',
          [sourceChain, a.source.at, b.treasury, forward.at])), reverts('WrongWithdrawalConfig'));
      }
      console.log(`${src} → ${dst}: sourceNote=${value} debit=${debit} sourceChange=${change} gross=${gross} fee=${levy} net=${payout} ` +
        `proof=${getBytes(spend.proof).length}B lock=${locked.gasUsed ?? locked.energyUsed} ${a.chain.network.tvm ? 'TVM units' : 'gas'} ` +
        `pay=${paid.gasUsed ?? paid.energyUsed} ${b.chain.network.tvm ? 'TVM units' : 'gas'}`);
    }
  });
