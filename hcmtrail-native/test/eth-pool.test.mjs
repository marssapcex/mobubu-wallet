import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractFactory, ZeroAddress, ZeroHash, getAddress, id, keccak256, parseEther, toBeHex } from 'ethers';
import { deployEthNetwork, deployEthPool, deployNoteStack } from '../pool/local.mjs';
import { ETH, FEE_BPS, MIN_DEPOSIT, MAX_PART, abi, decodeNoteKey, directLeg, encodeNoteKey, parseAmount, poolDomain, privateBackup, quoteFee, readBackup, reservationLeg, splitDeposit, statement, targetCount, ticketId } from '../pool/protocol.mjs';
import { settleReady } from '../pool/keeper.mjs';
import { readPool } from '../pool/view.mjs';
import * as codec from '../testnet/notes.mjs';
import { ETH_LABS, SEPOLIA_CHAIN_ID, TX_GAS_CAP } from '../testnet/networks.mjs';
import { localEvm, LOCAL_ID } from './local-evm.mjs';

const { openNote } = codec;

const opts = { gasLimit: TX_GAS_CAP };
const send = async (method, ...args) => (await method(...args, opts)).wait();
const p = (n) => toBeHex(n, 32);
const to = (n) => getAddress(toBeHex(n + 0xf0000n, 20));
const release = async (vm, at) => {
  await vm.provider.send('evm_setNextBlockTimestamp', [Number(at)]);
  await vm.provider.send('evm_mine', []);
};

function mock(domain, root) {
  let n = 1000n;
  const notBefore = 1_794_999_600n;
  const spend = () => ({ root, notBefore, nullifiers: [p(n++), p(n++)], change: [p(n++), p(n++)] });
  const proof = (s, leg) => keccak256(abi.encode(['uint256[]'], [statement(s, leg)]));
  function order(terms, value, refundOwner = p(n++)) {
    const s = spend();
    return [proof(s, reservationLeg(domain, terms, value, refundOwner)), s, terms, value, refundOwner];
  }
  return { spend, proof, order };
}

const has = (name) => (error) => error.revert?.name === name || error.data?.startsWith(id(`${name}()`).slice(0, 10));

test('exact decimals, arbitrary target counts and no dropped wei across big multi-transaction deposits', () => {
  assert.equal(parseAmount('0,010000000000000001', MIN_DEPOSIT), MIN_DEPOSIT + 1n);
  assert.equal(parseAmount('0.000000000000000001'), 1n);
  assert.throws(() => parseAmount('0.009999999999999999', MIN_DEPOSIT));
  for (const bad of ['1e1', '+1', '0.0000000000000000001', '1,23.4', '0']) assert.throws(() => parseAmount(bad));
  assert.equal(targetCount('26'), 26);
  for (const bad of ['4', '101', '5.5']) assert.throws(() => targetCount(bad));
  const cap = 4n * MAX_PART * 10_000n / (10_000n - FEE_BPS);
  for (const gross of [MIN_DEPOSIT, cap, cap + 1n, 2n * cap + 999n]) {
    const groups = splitDeposit(gross, { openNote: (_, value) => ({ value }) });
    assert.equal(groups.reduce((a, b) => a + b.gross, 0n), gross);
    assert.ok(groups.every((g) => g.gross >= MIN_DEPOSIT && g.notes.length <= 4 &&
      g.notes.reduce((a, n) => a + n.value, 0n) + g.fee === g.gross));
    assert.ok(groups.flatMap((g) => g.notes).every((n) => n.value > 0n && n.value <= MAX_PART));
  }
  assert.deepEqual(quoteFee(1_111n), { fee: 0n, net: 1_111n });
  assert.deepEqual(quoteFee(1_112n), { fee: 1n, net: 1_111n });
  assert.throws(() => quoteFee(1_001));
});

test('portable text note key round-trips private openings and refunds, rejects typos and the wrong pool or chain', () => {
  const chainId = '31338', pool = to(222n);
  const domain = poolDomain(chainId, pool);
  const context = { chainId, pool, domain };
  const note = openNote(ETH, MIN_DEPOSIT);
  const terms = { amount: MIN_DEPOSIT, round: 1n, target: 5, recipient: to(501n), salt: p(1n) };
  const refund = { terms, leaf: note.leaf, nullifier: p(2n) };
  const key = encodeNoteKey(privateBackup(context, [note], [refund]));
  const restored = readBackup(decodeNoteKey(` ${key}\n`), context, codec);
  assert.deepEqual(restored, { notes: [note], refunds: [refund] });
  assert.throws(() => decodeNoteKey(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0')), /checksum/);
  assert.throws(() => decodeNoteKey(p(999n)), /không phải private key/);
  assert.throws(() => readBackup(decodeNoteKey(key), { ...context, chainId: '31339' }, codec), /phiên devnet khác/);
  assert.throws(() => readBackup(decodeNoteKey(key), { ...context, pool: to(991n) }, codec), /phiên devnet khác/);
});

test('test-only state machine: atomic 100-way payout, exact live 18/26, partial tickets and escape', { timeout: 180_000 }, async (t) => {
  const vm = await deployEthPool({ fixtures: true, harness: true, vmOptions: { balance: parseEther('500') } });
  t.after(vm.close);
  const { pool, staking } = vm;
  const amount = MIN_DEPOSIT + 3n;
  const depositNet = 2n * MAX_PART + 1n;
  const gross = depositNet * 10_000n / (10_000n - FEE_BPS);
  const depositNotes = [MAX_PART, MAX_PART, 1n].map((value) => {
    const note = openNote(ETH, value);
    return { amount: value, ownerCommit: note.ownerCommit };
  });
  await assert.rejects(pool.deposit.staticCall(p(12n), { value: MIN_DEPOSIT - 1n }), has('InvalidAmount'));
  await assert.rejects(pool.depositBatch.staticCall(depositNotes, { value: gross + 1n }), has('InvalidAmount'));
  await (await pool.depositBatch(depositNotes, { ...opts, value: gross })).wait();
  assert.equal(await pool.shieldedNative(), depositNet);
  assert.equal(await staking.fundedWei(), gross - depositNet);
  assert.equal(await pool.leafCount(), 4n);
  for (let i = 0; i < 10; i++) {
    const n = openNote(ETH, quoteFee(MAX_PART).net);
    await (await pool.deposit(n.ownerCommit, { ...opts, value: MAX_PART })).wait();
  }
  const depositFees = gross - depositNet + 10n * quoteFee(MAX_PART).fee;
  assert.equal(await staking.fundedWei(), depositFees);
  const tenEth = parseEther('10');
  const domain = await pool.domain();
  const { spend, proof, order } = mock(domain, await pool.currentRoot());
  const terms = (amount, target, i, more) => ({ amount, target, round: 1n, recipient: to(i), salt: p(i + 1n), ...more });
  const reserve = (args) => send(pool.reserve, ...args);
  const read = () => readPool(pool, vm.provider, vm.fromBlock, { snapshot: true });

  for (let i = 0n; i < 18n; i++) await reserve(order(terms(tenEth, 26, i), tenEth));
  let state = await read();
  const batch = state.batches.find((r) => r.amount === tenEth);
  assert.deepEqual([batch.count, batch.target, batch.missing, batch.status], [18, 26, 8, 'waiting']);
  await assert.rejects(pool.executeBatch.staticCall(batch.amount, 1n), has('BatchNotReady'));
  await assert.rejects(pool.reserve.staticCall(...order(terms(batch.amount, 27, 50n), batch.amount)), has('InvalidBatch'));
  await assert.rejects(pool.reserve.staticCall(...order(terms(batch.amount, 26, 50n, { round: 2n }), batch.amount)), has('InvalidBatch'));
  await assert.rejects(pool.reserve.staticCall(...order(terms(44n, 4, 50n), 44n)), has('InvalidBatch'));
  await assert.rejects(pool.reserve.staticCall(...order(terms(44n, 101, 50n), 44n)), has('InvalidBatch'));

  // A different exact amount remains independent, no global queue lock.
  const first = terms(amount, 100, 100n);
  const part = order(first, 1n);
  const failedReplacement = [...part];
  failedReplacement[2] = { ...first, recipient: to(999n) };
  await assert.rejects(pool.reserve.staticCall(...failedReplacement), has('WrongTestProof'));
  await reserve(part);
  assert.equal((await pool.getBatch(amount, 1n)).count, 0n);
  await assert.rejects(pool.reserve.staticCall(...part), has('AlreadySpent'));
  await assert.rejects(pool.refundPart.staticCall(first, part[1].nullifiers[0]), has('RefundUnavailable'));
  await reserve(order(first, amount - 1n));
  const leftover = order(terms(amount, 100, 978n), 123n);
  await reserve(leftover); // incomplete; must not count among the 100
  for (let i = 101n; i < 200n; i++) await reserve(order(terms(amount, 100, i), amount));
  state = await read();
  assert.deepEqual(state.batches.find((r) => r.amount === amount).count, 100);
  assert.equal(await pool.reservedNative(), batch.amount * 18n + amount * 100n + 123n);
  assert.equal(await pool.reservedRefundLeaves(), 120n);

  // Solo works while both batches have money reserved, drawing only from the shielded book.
  const s = spend();
  const solo = 7_017n;
  const leg = directLeg(to(1234n), solo, staking.target);
  await assert.rejects(pool.withdraw.staticCall(proof(s, { ...leg, feeRecipient: to(1235n) }), s, to(1234n), solo), has('WrongTestProof'));
  await assert.rejects(pool.withdraw.staticCall(proof(s, leg), s, to(1234n), solo + 1n), has('WrongTestProof'));
  await send(pool.withdraw, proof(s, leg), s, to(1234n), solo);
  assert.equal(await vm.provider.getBalance(to(1234n)), leg.amount);
  assert.equal(await staking.fundedWei(), depositFees + leg.fee);
  const txs = [];
  const anySender = pool.connect(await vm.provider.getSigner(1));
  await settleReady({ pool, read, send: (name, args) => send(anySender[name], ...args), report: (x) => txs.push(x) });
  assert.equal(txs.length, 1);
  assert.ok(txs[0].receipt.gasUsed < TX_GAS_CAP);
  t.diagnostic(`100 actual ETH transfers in one EVM transaction (${txs[0].receipt.gasUsed} gas); fake reservation proofs in this test only`);
  const { net, fee } = quoteFee(amount);
  const event = txs[0].receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)).find((l) => l?.name === 'BatchPaid');
  assert.deepEqual(event.args.toArray(), [amount, 1n, 100n, net * 100n, fee * 100n]);
  for (let i = 100n; i < 200n; i++) assert.equal(await vm.provider.getBalance(to(i)), net);
  const newFees = depositFees + leg.fee + fee * 100n;
  assert.equal(await staking.fundedWei(), newFees);
  assert.equal(await vm.provider.getBalance(staking.target), newFees);
  assert.equal(await vm.provider.getBalance(leftover[2].recipient), 0n);
  assert.equal(await pool.reservedRefundLeaves(), 19n);
  // Full paid tickets cannot refund. Incomplete parts are independently recoverable after settlement.
  await assert.rejects(pool.refundPart.staticCall(first, part[1].nullifiers[0]), has('RefundUnavailable'));
  await send(pool.refundPart, leftover[2], leftover[1].nullifiers[0]);
  assert.equal(await pool.reservedNative(), 18n * batch.amount);
  assert.equal(await staking.fundedWei(), newFees);
  const next = terms(amount, 5, 441n, { round: 2n });
  await reserve(order(next, amount));
  assert.equal(await pool.latestRound(amount), 2n);
  assert.equal(await vm.provider.getBalance(pool.target), await pool.shieldedNative() + await pool.reservedNative());
  assert.equal((await pool.tickets(ticketId(domain, first))).funded, amount);
  const wide = terms(MAX_PART + 1n, 5, 789n);
  await reserve(order(wide, MAX_PART));
  assert.equal((await pool.getBatch(wide.amount, 1n)).count, 0n);
  await reserve(order(wide, 1n));
  assert.equal((await pool.getBatch(wide.amount, 1n)).count, 1n);
  assert.equal((await pool.tickets(ticketId(domain, wide))).funded, MAX_PART + 1n);
});

test('one rejecting recipient rolls back every payment, then all expired slices can be re-shielded', { timeout: 60_000 }, async (t) => {
  const vm = await deployEthPool({ fixtures: true, harness: true });
  t.after(vm.close);
  const { pool, staking } = vm;
  const total = parseEther('5');
  const amount = MIN_DEPOSIT;
  const receiver = await vm.deploy(vm.artifacts.reject);
  await (await pool.deposit(p(87n), { ...opts, value: total })).wait();
  const { order, spend, proof } = mock(await pool.domain(), await pool.currentRoot());
  const solo = spend();
  await assert.rejects(send(pool.withdraw, proof(solo, directLeg(receiver.target, amount, staking.target)), solo, receiver.target, amount));
  assert.equal(await pool.spent(solo.nullifiers[0]), false);
  assert.equal(await staking.fundedWei(), quoteFee(total).fee);
  assert.equal(await pool.shieldedNative(), quoteFee(total).net);
  const orders = [];
  for (let i = 0n; i < 5n; i++) {
    const args = order({ amount, round: 1n, target: 5, recipient: i === 3n ? receiver.target : to(i), salt: p(i + 2n) }, amount);
    orders.push(args);
    await send(pool.reserve, ...args);
  }
  await assert.rejects(send(pool.executeBatch, amount, 1n)); // actual attempted tx, not only eth_call
  assert.equal(await pool.reservedNative(), 5n * amount);
  assert.equal(await pool.reservedRefundLeaves(), 5n);
  assert.equal((await pool.getBatch(amount, 1n)).paid, false);
  for (const [, , terms] of orders) assert.equal(await vm.provider.getBalance(terms.recipient), 0n);
  assert.equal(await vm.provider.getBalance(pool.target), quoteFee(total).net);
  assert.equal(await staking.fundedWei(), quoteFee(total).fee);
  const { expiresAt } = await pool.getBatch(amount, 1n);
  await release(vm, expiresAt);
  await assert.rejects(pool.executeBatch.staticCall(amount, 1n), has('BatchNotReady'));
  for (const [, s, terms, value, owner] of orders) {
    const leaf = await pool.commitment(value, owner);
    const receipt = await send(pool.refundPart, terms, s.nullifiers[0]);
    const ev = receipt.logs.map((l) => pool.interface.parseLog(l)).find((x) => x?.name === 'Refunded');
    assert.equal(ev.args.leaf, leaf);
    await assert.rejects(pool.refundPart.staticCall(terms, s.nullifiers[0]), has('RefundUnavailable'));
  }
  assert.equal(await pool.reservedNative(), 0n);
  assert.equal(await pool.reservedRefundLeaves(), 0n);
  assert.equal(await pool.shieldedNative(), quoteFee(total).net);
  assert.equal(await staking.fundedWei(), quoteFee(total).fee);
});


test('same verified implementation on three isolated VMs; notes, fee pots and chain domains are independent', { timeout: 90_000 }, async (t) => {
  const vms = await deployEthNetwork();
  const chains = [];
  for (const { slug, labId } of ETH_LABS) {
    const vm = vms.get(slug);
    t.after(vm.close);
    assert.equal(String(await vm.pool.homeChainId()), labId);
    assert.equal(await vm.staking.stakeToken(), vm.token.target);
    assert.equal(await vm.token.symbol(), slug === 'ethereum' ? 'HCMT' : 'LAB');
    if (slug === 'ethereum') {
      assert.equal(await vm.token.totalSupply(), parseEther('100000'));
      assert.equal(await vm.token.balanceOf(await vm.signer.getAddress()), parseEther('100000'));
    }
    assert.equal(await vm.pool.FEE_BPS(), 9n);
    assert.equal(await vm.pool.domain(), poolDomain(labId, vm.pool.target));
    chains.push(vm);
  }
  const [src, ...others] = chains;
  const gross = MIN_DEPOSIT + 17n;
  await (await src.pool.deposit(openNote(ETH, quoteFee(gross).net).ownerCommit, { ...opts, value: gross })).wait();
  const root = await src.pool.currentRoot();
  assert.equal(await src.staking.fundedWei(), quoteFee(gross).fee);
  for (const vm of others) {
    assert.notEqual(await src.pool.domain(), await vm.pool.domain());
    assert.equal(await vm.pool.knownRoot(root), false);
    assert.equal(await vm.pool.shieldedNative(), 0n);
    assert.equal(await vm.staking.fundedWei(), 0n);
  }
});

test('real legacy verifier constructor rejects public IDs (incl. Ethereum, Base, Arbitrum and Sepolia)', { timeout: 90_000 }, async (t) => {
  const local = await deployEthPool();
  t.after(local.close);
  assert.equal(await local.pool.homeChainId(), LOCAL_ID);
  const a = local.artifacts;
  for (const chain of [1n, 8453n, 42161n, SEPOLIA_CHAIN_ID]) {
    const vm = await localEvm(chain);
    t.after(vm.close);
    const deploy = (artifact, ...args) => vm.deploy(artifact, ...args, opts);
    const token = await deploy(a.labToken);
    const stack = await deployNoteStack(deploy, a);
    const factory = new ContractFactory(a.pool.abi, a.pool.bytecode, vm.signer);
    for (const declared of [chain, LOCAL_ID]) {
      const cfg = [ZeroHash, Array(3).fill(ZeroAddress), Array(4).fill(ZeroAddress)];
      const request = await factory.getDeployTransaction(declared, token.target, ...stack, cfg, opts);
      await assert.rejects(vm.provider.call({ ...request, from: await vm.signer.getAddress() }), has('LegacyProfileLocalOnly'));
    }
  }
});
