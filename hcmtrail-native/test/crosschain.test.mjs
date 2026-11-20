import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBytes, hexlify, id, Interface, parseEther, toQuantity, ZeroAddress, ZeroHash } from 'ethers';
import { test } from 'node:test';
import { compileCrosschain } from '../scripts/build-crosschain.mjs';
import { orderId, previewOrder, proveCrosschain, rateHash, saveCrosschainRefund } from '../testnet/crosschain.mjs';
import { callSpec, createSpec } from '../testnet/deployment.mjs';
import { openNote } from '../testnet/notes.mjs';
import { challengeAddresses } from '../testnet/staking.mjs';
import { checkProver, proofHash } from '../testnet/prover.mjs';
import { json, outsideSource } from '../testnet/store.mjs';
import { TestnetWallet } from '../testnet/wallet.mjs';
import { DEMO_RECIPIENT, walletFixture } from './testnet-fixture.mjs';
import { certificate, localPayee, on, reverts, signer, witnesses } from './crosschain-fixture.mjs';

process.umask(0o077);
const generate = process.env.NATIVE_CROSSCHAIN_GENERATE === '1';
const prover = generate ? checkProver(process.env.NATIVE_STARK_PROVER_DIR) : null;
const output = generate && process.env.NATIVE_CROSSCHAIN_VECTORS_DIR ? outsideSource(process.env.NATIVE_CROSSCHAIN_VECTORS_DIR) : null;
const vectors = fileURLToPath(new URL('./vectors/crosschain/', import.meta.url));
const time = 1_796_000_000n;
const WAD = 10n ** 18n;
const netIn = parseEther('0.9975'), grossOut = parseEther('31.171875');
const levy = parseEther('0.0779296875'), netOut = parseEther('31.0939453125');
const entryFee = parseEther('0.0025');
const routeCap = parseEther('32');
const inventory = routeCap * 2n;
function load(name) {
  const p = resolve(vectors, name);
  const proof = hexlify(readFileSync(`${p}.bin`));
  const obj = JSON.parse(readFileSync(`${p}.json`));
  assert.equal(obj.proofId, proofHash(proof));
  return { ...obj, proof };
}

function save(records) {
  if (!output) return;
  assert(!existsSync(output) || !existsSync(resolve(output, 'swap.bin')), 'Use a new vector output dir.');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const [name, { proof, ...meta }] of Object.entries(records)) {
    writeFileSync(resolve(output, `${name}.bin`), getBytes(proof), { mode: 0o600, flag: 'wx' });
    writeFileSync(resolve(output, `${name}.json`), json({ ...meta, proofId: proofHash(proof) }), { mode: 0o600, flag: 'wx' });
  }
}

// The two snapshots exercise mutually exclusive branches of the same real order, not two payments.
test(`ETH → HYPE: ${generate ? 'fresh' : 'pinned'} STARKs, withdrawal-time price, exact fees, sponsored payout and proved cancellation`,
  { timeout: 3_900_000 }, async (t) => {
    const a = compileCrosschain({ fixtures: true });
    const A = await walletFixture('ETH', undefined, { dao: true });
    t.after(A.close);
    const B = await walletFixture('HYPE', undefined, { dao: true });
    t.after(B.close);
    const relayA = signer(A, 'sponsor'), relayB = signer(B, 'sponsor');
    const maker = A.chain.sender;
    const [qa, qb] = await Promise.all([on(A, a, 'ReceiptQuorum', [witnesses.map((w) => w.address)]), on(B, a, 'ReceiptQuorum', [witnesses.map((w) => w.address)])]);
    const feed = [];
    for (let i = 0; i < 4; ++i) {
      // Individually deployed despite identical fixture bytecode; each has a distinct feed role.
      const spec = createSpec(a.FeedFixture, 'FeedFixture', [8]);
      const { contractAddress: at } = await A.txs.submit(`cross-feed-${i}`, spec);
      feed.push({ at, abi: new Interface(a.FeedFixture.abi) });
    }
    const oracle = await on(A, a, 'ChainlinkPriceEpochs', [A.chain.network.chainId, feed.map(({ at }) => [at, 1800, 8, 1, 10n ** 24n]),
      120, 0, ZeroAddress, 0]);
    const { prepare, walk, chunks } = A.manifest.stack;
    const gate = await on(A, a, 'SpendGate', [prepare, walk, chunks]);
    assert.equal(await gate.read('starkWalk'), walk);
    await assert.rejects(() => A.chain.simulate(createSpec(a.CrosschainNoteVault, 'CrosschainNoteVault',
      [A.manifest.dao.treasury, oracle.at, qa.at, qa.at])), reverts('WrongSpendStack'));
    for (const [prices, adapter] of [[qa.at, qa.at], [oracle.at, oracle.at]]) {
      await assert.rejects(() => A.chain.simulate(createSpec(a.CrosschainNoteVault, 'CrosschainNoteVault',
        [A.manifest.dao.treasury, prices, gate.at, adapter])), reverts('WrongWithdrawalConfig'));
    }
    const source = await on(A, a, 'CrosschainNoteVault', [A.manifest.dao.treasury, oracle.at, gate.at, qa.at]);
    const liquidity = await on(B, a, 'CrosschainLiquidity', [A.chain.network.chainId, source.at, B.manifest.dao.treasury, qb.at]);
    const receiver = await on(B, a, 'PayoutSwitch');
    const wallet = new TestnetWallet(A.chain, A.store, A.txs, {
      ...A.manifest, vault: source.at, domain: await source.read('domain'), domainLeaf: await source.read('domainLeaf'),
      created: { tx: source.receipt.hash, block: String(source.receipt.blockNumber), blockHash: source.receipt.blockHash },
    }, a.CrosschainNoteVault.abi);
    await A.setTime(time);
    await B.setTime(time);
    const price = async (round, hype) => {
      const stamp = (await A.chain.head()).timestamp;
      const amounts = [2500n, 550n, 1n, hype].map((x) => x * 10n ** 8n);
      for (let i = 0; i < 4; ++i) await A.txs.submit(`cross-px-${round}-${i}`, callSpec(feed[i].abi, feed[i].at, 'report', [round, amounts[i], stamp, stamp]));
    };
    const known = (noteValue, tag) => openNote(A.chain.network, noteValue,
      [11n, 38n, 55n, 124n].map((x) => x + tag), [51n, 76n, 96n, 243n].map((x) => x + tag * 3n));
    const opening = known(netIn, 1n), refund = known(netIn, 2n);
    const noteId = wallet.keep(opening, { kind: 'deposit', gross: WAD });
    // Deposit succeeds even before there is any usable oracle epoch.
    const deposited = await wallet.deposit(noteId);
    assert.equal(deposited.index, 1n);
    assert.equal(await source.read('accountedNative'), netIn);
    assert.equal(await A.chain.balance(A.manifest.dao.treasury), entryFee);
    // Fee-on-entry does not fund or promise any destination asset.
    assert.equal(await B.chain.balance(liquidity.at), 0n);
    const o = { sourceChain: A.chain.network.chainId, sourceVault: source.at, destinationChain: B.chain.network.chainId,
      destinationVault: liquidity.at, amountIn: netIn, minNetOut: parseEther('31'), liquidityLimit: routeCap,
      recipient: receiver.at, sourceLP: maker, destinationLP: B.chain.sender, refundOwnerCommit: refund.ownerCommit,
      salt: id('public cross-chain vector only'), acceptBy: time + 2700n, payBy: time + 5400n };
    const order = orderId(o);
    assert.deepEqual(saveCrosschainRefund(A.store, A.chain.network, o, refund), { id: order, refundNote: refund.leaf });
    assert.throws(() => saveCrosschainRefund(A.store, A.chain.network, o, opening), /does not open/);
    await assert.rejects(() => A.chain.call(source.spec('quote', [o])), reverts('InvalidRound(uint8)'));
    await price(1, 60n);
    await assert.rejects(() => A.chain.call(source.spec('quote', [o])), reverts('OutOfBounds')); // 41.5625 HYPE > LP cap
    await assert.rejects(() => B.chain.simulate(liquidity.spec('reserve', [o])), reverts('InsufficientLiquidity'));
    await B.txs.submit('fund-cross-liquidity', liquidity.spec('fundLiquidity', [], inventory));
    const reserved = await B.txs.submit('reserve-cross-liquidity', liquidity.spec('reserve', [o]));
    assert.equal(await liquidity.read('reservedNative'), routeCap);
    await assert.rejects(() => B.chain.simulate(liquidity.spec('withdrawLiquidity', [inventory, maker])), reverts('InsufficientLiquidity'));
    const reserveProof = await certificate(B, liquidity, reserved, A, qa, source, 1, order);
    await price(2, 100n);
    await assert.rejects(() => A.chain.call(source.spec('quote', [o])), reverts('OutOfBounds')); // 24.9375 gross < minNetOut
    await price(3, 80n);
    // No keeper called refresh and an unrelated BNB feed is offline; the ETH/HYPE pair still works.
    assert.equal((await oracle.read('publishedEpoch')).id, ZeroHash);
    await A.txs.submit('cross-offline-bnb', callSpec(feed[1].abi, feed[1].at, 'setOffline', [true]));
    const [r0, fee, net] = source.abi.decodeFunctionResult('quote', await A.chain.call(source.spec('quote', [o])));
    assert.equal(r0.grossOut, grossOut);
    assert.equal(fee, levy);
    assert.equal(net, netOut);
    assert.deepEqual(previewOrder(o, 2500n * WAD, 80n * WAD), { gross: grossOut, fee: levy, net: netOut });
    const sun = { ...o, amountIn: 123_456_789_123_456_789n, destinationChain: 0xcd8690dcn, minNetOut: 1n, liquidityLimit: 2n ** 63n - 1n };
    const sunOut = source.abi.decodeFunctionResult('quote', await A.chain.call(source.spec('quote', [sun])));
    assert.equal(sunOut[0].grossOut, sun.amountIn * 2500n * 10n ** 6n / WAD);
    assert.equal(sunOut[1], sunOut[0].grossOut / 400n);
    assert.notEqual(sunOut[0].grossOut % 400n, 0n);
    assert.equal(sunOut[2], sunOut[0].grossOut - sunOut[1]);
    const temporarilyStale = await A.chain.rpc('evm_snapshot');
    await A.setTime(time + 2100n);
    await assert.rejects(() => A.chain.call(source.spec('quote', [o])), reverts('StaleRound(uint8)'));
    assert(await A.chain.rpc('evm_revert', [temporarilyStale]));
    const tree = await wallet.ledger.snapshot();
    await assert.rejects(() => proveCrosschain(A.store, A.chain.network, null, { ...o, salt: id('no refund backup') }, opening,
      deposited.index, tree), /Missing local cross-refund/);
    const swapped = generate ? await proveCrosschain(A.store, A.chain.network, prover, o, opening, deposited.index, tree) : load('swap');
    assert.equal(swapped.id, order);
    if (generate) console.log(`Fresh cross proof: ${(swapped.proof.length - 2) / 2} bytes, ${swapped.seconds}s`);
    const { publicSpend, proof } = swapped;
    // Keep separate proof (same funded note) to show same-chain exits do not touch prices and share nullifiers.
    let local;
    if (generate) {
      const localPlan = await wallet.prove(noteId, netIn, localPayee, prover);
      local = wallet.loadExit(localPlan.exitId);
      console.log(`Fresh local proof: ${localPlan.proofBytes} bytes, ${localPlan.proofSeconds}s`);
    } else local = load('local');
    assert.equal(local.exit.nullifiers[0], publicSpend.nullifiers[0]);
    const lock = (cert, order = o, payload = proof) => source.spec('lockWithdrawal', [order, publicSpend, payload, cert]);
    await assert.rejects(() => A.chain.call(lock('0x')), reverts('UnverifiedEvent'));
    for (const bad of [reserveProof.good.slice(0, -2), `0xff${reserveProof.good.slice(4)}`]) {
      await assert.rejects(() => A.chain.call(lock(bad)), reverts('UnverifiedEvent'));
    }
    await assert.rejects(() => A.chain.call(lock(reserveProof.duplicate)), reverts('UnverifiedEvent'));
    await assert.rejects(() => A.chain.call(lock(reserveProof.wrongConsumer)), reverts('UnverifiedEvent'));
    await assert.rejects(() => A.chain.call(lock(reserveProof.good, o, '0x')), reverts('InvalidStarkProof'));
    const [slot0, slot1] = challengeAddresses(order);
    await assert.rejects(() => A.chain.call(source.spec('withdraw', [proof, { ...publicSpend, recipient: slot0,
      feeRecipient: slot1, amount: o.amountIn - 1n, fee: 1n }])), reverts('InvalidRelay'));
    // Even a *real* reservation for an altered recipient does not authorize the note proof.
    const changedOrder = { ...o, recipient: DEMO_RECIPIENT };
    const changedReserve = await B.txs.submit('reserve-alt', liquidity.spec('reserve', [changedOrder]));
    const changedCert = await certificate(B, liquidity, changedReserve, A, qa, source, 1, orderId(changedOrder));
    await assert.rejects(() => A.chain.call(lock(changedCert.good, changedOrder)), reverts('InvalidStarkProof'));
    const competingCap = routeCap;
    const prelock = await A.chain.rpc('evm_snapshot');
    const aGasBefore = await A.chain.balance(relayA.chain.sender);
    const locked = await relayA.submit('lock-cross-order', lock(reserveProof.good));
    assert.equal(aGasBefore - await A.chain.balance(relayA.chain.sender), locked.gasUsed * locked.effectiveGasPrice);
    assert.equal(locked.from, DEMO_RECIPIENT);
    console.log(`Source lock gas: ${locked.gasUsed}`);
    const event = locked.logs.filter((l) => l.address === source.at && l.topics[0] === source.abi.getEvent('WithdrawalLocked').topicHash);
    assert.equal(event.length, 1);
    const [lockedId, r] = source.abi.parseLog(event[0]).args;
    assert.equal(lockedId, order);
    const rate = r.toObject();
    assert.equal(rate.epoch, r0.epoch);
    assert.equal(rate.grossOut, grossOut);
    assert.equal(rate.acceptedAt, (await A.chain.block(locked.blockNumber)).timestamp);
    assert.equal(await source.read('accountedNative'), 0n);
    assert.equal(await source.read('escrowNative'), netIn);
    assert.equal(await A.chain.balance(source.at), netIn);
    assert.equal(await A.chain.balance(A.manifest.dao.treasury), entryFee);
    await assert.rejects(() => A.chain.call(source.spec('withdraw', [local.proof, local.exit])), reverts('InvalidSpend'));
    await assert.rejects(() => A.chain.call(lock(reserveProof.good)), reverts('WrongState'));
    const cert = await certificate(A, source, locked, B, qb, liquidity, 2, order, rateHash(rate));
    const snapA = await A.chain.rpc('evm_snapshot'), snapB = await B.chain.rpc('evm_snapshot');
    // Final settlement must use 80 USD from the source lock, even if the feed now reads 120.
    await price(4, 120n);
    const pay = (certificate = cert.good, quote = rate, o0 = o) => liquidity.spec('pay', [o0, quote, certificate]);
    await assert.rejects(() => B.chain.call(pay(cert.duplicate)), reverts('UnverifiedEvent'));
    await assert.rejects(() => B.chain.call(pay(cert.good, { ...rate, epoch: id('wrong epoch') })), reverts('UnverifiedEvent'));
    await assert.rejects(() => B.chain.call(pay(cert.good, { ...rate, grossOut: grossOut + 1n })), reverts('WrongQuote'));
    await assert.rejects(() => B.chain.call(pay()), reverts('PayoutFailed'));
    const failed = await B.chain.rpc('eth_sendTransaction', [{ from: relayB.chain.sender, to: liquidity.at, data: pay().data, gas: toQuantity(900_000) }]);
    assert.equal((await B.chain.receipt(failed)).ok, false);
    assert.equal(await liquidity.read('status', [order]), 1n);
    assert.equal(await liquidity.read('reservedNative'), routeCap + competingCap);
    assert.equal(await B.chain.balance(liquidity.at), inventory);
    assert.equal(await B.chain.balance(B.manifest.dao.treasury), 0n);
    await B.txs.submit('cross-allow-receiver', receiver.spec('allowPayment'));
    const bGasBefore = await B.chain.balance(relayB.chain.sender);
    const paid = await relayB.submit('pay-cross-order', pay());
    assert.equal(bGasBefore - await B.chain.balance(relayB.chain.sender), paid.gasUsed * paid.effectiveGasPrice);
    console.log(`Destination payout gas: ${paid.gasUsed}`);
    assert.equal(paid.from, DEMO_RECIPIENT);
    assert.equal(await B.chain.balance(receiver.at), netOut);
    assert.equal(await B.chain.balance(B.manifest.dao.treasury), levy);
    assert.equal(await liquidity.read('reservedNative'), competingCap);
    assert.equal(await liquidity.read('freeLiquidity', [maker]), routeCap - grossOut);
    assert.equal(await B.chain.balance(liquidity.at), inventory - grossOut);
    await assert.rejects(() => B.chain.call(pay()), reverts('WrongState'));
    const paidCert = await certificate(B, liquidity, paid, A, qa, source, 3, order, rateHash(rate));
    await assert.rejects(() => A.chain.call(source.spec('complete', [o, reserveProof.good])), reverts('UnverifiedEvent'));
    await relayA.submit('complete-cross-order', source.spec('complete', [o, paidCert.good]));
    assert.equal(await source.read('escrowNative'), 0n);
    assert.equal(await source.read('pendingRefundSlots'), 0n);
    assert.equal(await source.read('liquidityCredit', [maker]), netIn);
    await assert.rejects(() => relayA.chain.simulate(source.spec('withdrawLiquidity', [netIn, DEMO_RECIPIENT])), reverts('InvalidAmount'));
    await A.txs.submit('claim-cross-credit', source.spec('withdrawLiquidity', [netIn, maker]));
    assert.equal(await A.chain.balance(source.at), 0n);
    // Counterfactual cancellation branch from the same pending state/real lock.
    assert(await A.chain.rpc('evm_revert', [snapA]));
    assert(await B.chain.rpc('evm_revert', [snapB]));
    await B.setTime(o.payBy);
    await assert.rejects(() => B.chain.call(pay()), reverts('WrongState'));
    const cancelled = await relayB.submit('cancel-cross-order', liquidity.spec('cancel', [o]));
    const cancelProof = await certificate(B, liquidity, cancelled, A, qa, source, 4, order);
    // Destination reached its deadline first. A source refund still respects its own clock.
    await assert.rejects(() => A.chain.call(source.spec('refund', [o, cancelProof.good])), reverts('WrongState'));
    await A.setTime(o.payBy);
    await assert.rejects(() => A.chain.call(source.spec('refund', [o, '0x'])), reverts('UnverifiedEvent'));
    await relayA.submit('refund-cross-order', source.spec('refund', [o, cancelProof.good]));
    assert.equal(await B.chain.balance(receiver.at), 0n);
    assert.equal(await B.chain.balance(B.manifest.dao.treasury), 0n);
    assert.equal(await liquidity.read('freeLiquidity', [maker]), routeCap);
    assert.equal(await source.read('accountedNative'), netIn);
    assert.equal(await A.chain.balance(A.manifest.dao.treasury), entryFee);
    assert.equal(await A.chain.balance(source.at), netIn);
    assert.equal((await wallet.ledger.snapshot()).leaves.at(-1), refund.leaf);
    assert.equal(await source.read('spent', [publicSpend.nullifiers[0]]), true);
    assert.equal(await source.read('pendingRefundSlots'), 0n);
    await assert.rejects(() => A.chain.call(source.spec('refund', [o, cancelProof.good])), reverts('WrongState'));
    await assert.rejects(() => B.chain.call(pay()), reverts('WrongState'));
    // Counterfactual local withdrawal. Disable the oracle entirely and still pay ETH after 0.25%.
    assert(await A.chain.rpc('evm_revert', [prelock]));
    await A.txs.submit('cross-offline-feed', callSpec(feed[0].abi, feed[0].at, 'setOffline', [true]));
    const pre = await A.chain.balance(localPayee);
    const localPaid = await relayA.submit('local-from-cross-vault', source.spec('withdraw', [local.proof, local.exit]));
    assert.equal(localPaid.from, DEMO_RECIPIENT);
    assert.equal(await A.chain.balance(localPayee) - pre, netIn - netIn / 400n);
    assert.equal(await A.chain.balance(A.manifest.dao.treasury), entryFee + netIn / 400n);
    assert.equal(await A.chain.balance(source.at), 0n);
    if (generate) save({ swap: { id: swapped.id, publicSpend: swapped.publicSpend, proof }, local: { exit: local.exit, proof: local.proof } });
  });

test('Nile TVM: pinned source stack, deposit in sun, and LP reserve/cancel without a remote payout',
  { skip: generate || !process.env.TRON_SOLC, timeout: 180_000 }, async (t) => {
    const a = compileCrosschain({ tvm: true, fixtures: true });
    const f = await walletFixture('TRX', undefined, { dao: true });
    t.after(f.close);
    const at = f.chain.network.chainId, maker = f.chain.sender, box = f.manifest.dao.treasury;
    const witness = await on(f, a, 'ReceiptQuorum', [witnesses.map((w) => w.address)]);
    const gate = await on(f, a, 'SpendGate', [f.manifest.stack.prepare, f.manifest.stack.walk, f.manifest.stack.chunks]);
    const feed = [];
    for (let i = 0; i < 4; ++i) {
      const { contractAddress } = await f.txs.submit(`nile-cross-feed-${i}`, createSpec(a.FeedFixture, 'FeedFixture', [8]));
      feed.push(contractAddress);
    }
    const oracle = await on(f, a, 'ChainlinkPriceEpochs', [at, feed.map((x) => [x, 1800, 8, 1, 10n ** 24n]), 300, 0, ZeroAddress, 0]);
    const source = await on(f, a, 'CrosschainNoteVault', [box, oracle.at, gate.at, witness.at]);
    const amount = 1_000_001n, fee = amount / 400n;
    const net = amount - fee;
    const note = openNote(f.chain.network, net);
    await f.txs.submit('cross-nile-deposit', source.spec('deposit', [note.ownerCommit], amount));
    assert.equal(await source.read('accountedNative'), net);
    assert.equal(await f.chain.balance(box), fee);
    assert.equal(await source.read('commitment', [net, note.ownerCommit]), note.leaf);
    const from = 11155111n;
    const lp = await on(f, a, 'CrosschainLiquidity', [from, localPayee, box, witness.at]);
    const now = (await f.chain.head()).timestamp;
    const o = { sourceChain: from, sourceVault: localPayee, destinationChain: at, destinationVault: lp.at,
      amountIn: WAD, minNetOut: 1n, liquidityLimit: 2_000_001n, recipient: DEMO_RECIPIENT,
      sourceLP: maker, destinationLP: maker, refundOwnerCommit: note.ownerCommit, salt: id('Nile smoke route'),
      acceptBy: now + 300n, payBy: now + 1800n };
    await f.txs.submit('cross-nile-fund', lp.spec('fundLiquidity', [], o.liquidityLimit));
    await f.txs.submit('cross-nile-reserve', lp.spec('reserve', [o]));
    assert.equal(await lp.read('reservedNative'), o.liquidityLimit);
    assert.equal(await lp.read('transferCap'), (1n << 63n) - 1n);
    const rate = { epoch: id('fixture not attested'), priceIn18: 2n * WAD, priceOut18: WAD, acceptedAt: now, grossOut: 2_000_000n };
    await assert.rejects(() => f.chain.call(lp.spec('pay', [o, rate, '0x'])), reverts('UnverifiedEvent'));
    await assert.rejects(() => f.chain.call(lp.spec('cancel', [o])), reverts('WrongState'));
    await f.setTime(o.payBy);
    await f.txs.submit('cross-nile-cancel', lp.spec('cancel', [o]));
    assert.equal(await lp.read('reservedNative'), 0n);
    assert.equal(await lp.read('freeLiquidity', [maker]), o.liquidityLimit);
    assert.equal(await f.chain.balance(lp.at), o.liquidityLimit);
  });
