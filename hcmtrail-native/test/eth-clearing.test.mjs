import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id, keccak256, parseEther, toBeHex } from 'ethers';
import { ARBITRUM, BASE, ETHEREUM, NO_PACKET_GAS, Packet, Stage, exitId, exitLeg, packetPath, readRouteBackups } from '../pool/clearing.mjs';
import { ETH, U256, abi, decodeNoteKey, directLeg, encodeNoteKey, privateBackup, quoteFee, readBackup, reservationLeg, statement } from '../pool/protocol.mjs';
import * as codec from '../testnet/notes.mjs';
import { openNote } from '../testnet/notes.mjs';
import { localClearing } from '../pool/local-clearing.mjs';
import { balances, deliver, hopBid, hopValue, labs, opts, pushPacket, queued, sent } from './message-driver.mjs';

const has = (name) => (e) => e.revert?.name === name || e.data?.startsWith(id(`${name}()`).slice(0, 10));
const word = (n) => toBeHex(n, 32);
const address = (n) => toBeHex(0xfee00n + n, 20);
const encodeProof = (s, leg) => keccak256(abi.encode(['uint256[]'], [statement(s, leg)]));
const order = (source, destination, seed, gross, recipient = address(seed)) => ({ source, destination, gross,
  recipient, salt: word(seed), refundOwner: openNote(ETH, gross).ownerCommit, cancelHash: keccak256(word(seed + 500n)) });

async function fundNotes(vm, value = parseEther('1')) {
  const note = openNote(ETH, quoteFee(value).net);
  await (await vm.pool.deposit(note.ownerCommit, { ...opts, value })).wait();
}
const addLiquidity = async (vm, value) => (await vm.pool.fundLiquidity({ ...opts, value })).wait();
async function makePlan(vm, o, i) {
  const n = await vm.pool.networkDomain();
  assert.equal(exitId(n, o), await vm.pool.exitId(o));
  const s = { root: await vm.pool.currentRoot(), notBefore: 1_794_999_600n,
    nullifiers: [word(i), word(i + 1n)], change: [word(i + 2n), word(i + 3n)] };
  return [encodeProof(s, exitLeg(await vm.pool.domain(), n, o)), s, o];
}
async function enqueue(chains, o, kind, args) {
  const from = kind === Packet.Open ? o.source : o.destination;
  const to = kind === Packet.Open ? o.destination : o.source;
  const bid = hopBid(from, packetPath(from, to)[1]);
  const method = kind === Packet.Open ? chains.get(from).pool.withdrawAcross : chains.get(from).pool.publishOutcome;
  return (await method(...args, bid, { ...opts, value: hopValue(bid) })).wait();
}

test('all six directions: zero-principal messages, exact fee, ETH paid only from the destination liquidity pot', { timeout: 180_000 }, async (t) => {
  const chains = await labs(t);
  for (const vm of chains.values()) {
    await fundNotes(vm);
    await addLiquidity(vm, parseEther('0.2'));
  }
  const l1 = chains.get(ETHEREUM);
  assert.equal(await l1.pool.FEE_BPS(), 9n);
  for (const v of [1n, 1_111n, 1_112n, 10_000n, U256]) {
    const { fee, net } = quoteFee(v);
    assert.deepEqual((await l1.pool.quoteFee(v)).toArray(), [fee, net]);
  }
  let serial = 17n;
  for (const src of chains.values()) for (const dst of chains.values()) {
    if (src === dst) continue;
    const i = serial++;
    const gross = src.lane === BASE && dst.lane === ARBITRUM ? 1n : parseEther('0.02') + 17n;
    const o = order(src.lane, dst.lane, i, gross);
    const args = await makePlan(src, o, i * 10n);
    const route = await src.pool.exitId(o);
    const before = await balances(src), poolAtDest = await balances(dst);
    const { fee, net } = quoteFee(gross);
    const msg = await enqueue(chains, o, Packet.Open, args);
    assert.equal(await src.pool.exitStage(route), Stage.Locked);
    assert.equal(await src.pool.spent(args[1].nullifiers[0]), true);
    assert.deepEqual(await balances(src), { ...before, shielded: before.shielded - gross, outbound: before.outbound + gross });
    await assert.rejects(dst.pool.claimAcross.staticCall(o), has('InvalidExitStage'));
    await pushPacket(chains, o, Packet.Open, msg, async ({ to }) => {
      if (to !== l1 || dst === l1) return;
      assert.equal(await dst.pool.exitStage(route), Stage.Unseen);
    });
    assert.equal(await dst.pool.exitStage(route), Stage.Authorized);
    assert.deepEqual(await balances(dst), poolAtDest, 'message delivery cannot fund the payout');
    assert.equal(await dst.provider.getBalance(o.recipient), 0n);
    await sent(dst.pool.connect(dst.other).claimAcross, o);
    assert.equal(await dst.provider.getBalance(o.recipient), net);
    assert.deepEqual(await balances(dst), { ...poolAtDest, total: poolAtDest.total - gross,
      liquidity: poolAtDest.liquidity - gross, fees: poolAtDest.fees + fee });
    await assert.rejects(dst.pool.claimAcross.staticCall(o), has('InvalidExitStage'));
    await assert.rejects(dst.pool.cancelAcross.staticCall(o, word(i + 500n)), has('InvalidExitStage'));
    const ack = await enqueue(chains, o, Packet.Paid, [o]);
    await pushPacket(chains, o, Packet.Paid, ack);
    assert.equal(await src.pool.exitStage(route), Stage.Settled);
    assert.deepEqual(await balances(src), { ...before, shielded: before.shielded - gross, liquidity: before.liquidity + gross });
    assert.equal(await src.pool.reservedRefundLeaves(), 0n);
    assert.equal(await dst.pool.exitStage(route), Stage.Paid);
    await assert.rejects(src.pool.refundAcross.staticCall(o), has('InvalidExitStage'));
    // Both terminal outcomes can be relayed again without a second credit or payout.
    if (i === 17n) {
      await pushPacket(chains, o, Packet.Paid, ack);
      await pushPacket(chains, o, Packet.Open, msg);
      assert.equal(await src.pool.liquidityNative(), before.liquidity + gross);
      assert.equal(await dst.pool.exitStage(route), Stage.Paid);
    }
    t.diagnostic(`${src.lane} → ${dst.lane}: ${gross} − ${fee} = ${net} wei; no principal in either direction`);
  }
});

test('mode/domain binding, failed enqueue rollback, authenticated delivery, short pot and later top-up', { timeout: 180_000 }, async (t) => {
  const chains = await labs(t);
  const src = chains.get(ETHEREUM), dst = chains.get(BASE);
  await fundNotes(src);
  await fundNotes(dst); // dest has ETH, but it is note collateral, not spendable for this order
  const o = order(ETHEREUM, BASE, 44n, parseEther('0.09') + 1n);
  const [proof, spend] = await makePlan(src, o, 500n);
  const route = await src.pool.exitId(o);
  const before = await balances(src);
  for (const bad of [{ ...o, recipient: address(99n) }, { ...o, gross: o.gross + 1n },
    { ...o, refundOwner: word(66n) }, { ...o, destination: ARBITRUM }]) {
    await assert.rejects(src.pool.withdrawAcross.staticCall(proof, spend, bad, NO_PACKET_GAS), has('WrongTestProof'));
  }
  await assert.rejects(src.pool.withdraw.staticCall(proof, spend, o.recipient, o.gross), has('WrongTestProof'));
  const bt = { amount: o.gross, round: 1n, target: 5, recipient: o.recipient, salt: word(777n) };
  const reserveProof = encodeProof(spend, reservationLeg(await src.pool.domain(), bt, o.gross, o.refundOwner));
  await assert.rejects(src.pool.withdrawAcross.staticCall(reserveProof, spend, o, NO_PACKET_GAS), has('WrongTestProof'));
  const directProof = encodeProof(spend, directLeg(o.recipient, o.gross, src.staking.target));
  await assert.rejects(src.pool.withdrawAcross.staticCall(directProof, spend, o, NO_PACKET_GAS), has('WrongTestProof'));

  await sent(src.base.setStopped, true);
  await assert.rejects(src.pool.withdrawAcross.staticCall(proof, spend, o, NO_PACKET_GAS), has('TransportStopped'));
  await assert.rejects(sent(src.pool.withdrawAcross, proof, spend, o, NO_PACKET_GAS));
  assert.equal(await src.pool.spent(spend.nullifiers[0]), false);
  assert.equal(await src.pool.exitStage(route), Stage.Unseen);
  assert.deepEqual(await balances(src), before);
  assert.equal(await src.pool.reservedRefundLeaves(), 0n);
  await sent(src.base.setStopped, false);
  const first = queued(src, dst, await sent(src.pool.withdrawAcross, proof, spend, o, NO_PACKET_GAS));
  const retried = queued(src, dst, await sent(src.pool.connect(src.other).retryAcross, o, NO_PACKET_GAS));
  assert.equal(first.packet, retried.packet);
  const other = { ...o, salt: word(555n) };
  await assert.rejects(src.pool.withdrawAcross.staticCall(proof, spend, other, NO_PACKET_GAS), has('AlreadySpent'));
  await assert.rejects(dst.pool.acceptPacket.staticCall(route, o, Packet.Open), has('InvalidMessageSender'));
  await assert.rejects(dst.base.deliver.staticCall(address(56n), first.to, first.packet), has('InvalidMessageSender'));
  const wrongRealm = dst.pool.interface.encodeFunctionData('acceptPacket', [word(101n), o, Packet.Open]);
  await assert.rejects(dst.base.deliver.staticCall(first.from, first.to, wrongRealm), has('InvalidExit'));
  await deliver(dst, first);
  await deliver(dst, retried);
  assert.equal(await dst.pool.exitStage(route), Stage.Authorized);
  const prior = await balances(dst);
  assert.ok(prior.shielded > o.gross);
  await assert.rejects(dst.pool.claimAcross.staticCall(o), has('InsufficientLiquidity'));
  await addLiquidity(dst, o.gross - 1n);
  await assert.rejects(dst.pool.claimAcross.staticCall(o), has('InsufficientLiquidity'));
  await assert.rejects(src.pool.refundAcross.staticCall(o), has('InvalidExitStage'));
  assert.equal(await dst.staking.fundedWei(), prior.fees);
  await addLiquidity(dst, 1n);
  await sent(dst.pool.claimAcross, o);
  assert.equal(await dst.provider.getBalance(o.recipient), quoteFee(o.gross).net);
  await pushPacket(chains, o, Packet.Paid, await sent(dst.pool.publishOutcome, o, NO_PACKET_GAS));
  assert.equal((await balances(dst)).shielded, prior.shielded);
  assert.equal((await balances(dst)).liquidity, 0n);
  assert.equal((await balances(src)).liquidity, o.gross);
});

test('L2-to-L2 forwarding retries, zero-value alias and Outbox checks, cancellation recovers gross once', { timeout: 180_000 }, async (t) => {
  const chains = await labs(t);
  const src = chains.get(BASE), l1 = chains.get(ETHEREUM), dst = chains.get(ARBITRUM);
  await fundNotes(src);
  const reject = await dst.deploy(dst.artifacts.reject);
  const o = order(BASE, ARBITRUM, 98n, parseEther('0.2'), reject.target);
  const route = await src.pool.exitId(o);
  const old = await balances(src);
  const args = await makePlan(src, o, 2300n);
  const b = hopBid(ETHEREUM, ARBITRUM), value = hopValue(b);
  await assert.rejects(l1.pool.forwardPacket.staticCall(o, Packet.Open, b, { value }), has('InvalidExitStage'));
  await deliver(l1, queued(src, l1, await sent(src.pool.withdrawAcross, ...args, NO_PACKET_GAS)));
  await assert.rejects(l1.pool.forwardPacket.staticCall(o, Packet.Open, b, { value: value - 1n }), has('InvalidPacketGas'));
  await sent(l1.arb.setStopped, true);
  await assert.rejects((await l1.pool.forwardPacket(o, Packet.Open, b, { ...opts, value })).wait());
  assert.equal(await l1.pool.transitPackets(route), 1n);
  await sent(l1.arb.setStopped, false);
  const aboard = queued(l1, dst, await (await l1.pool.forwardPacket(o, Packet.Open, b, { ...opts, value })).wait());
  await assert.rejects(deliver(dst, aboard, { sender: address(909n) }));
  await deliver(dst, aboard);
  await addLiquidity(dst, o.gross);
  await assert.rejects(sent(dst.pool.claimAcross, o)); // bound recipient rejects ETH
  assert.equal((await balances(dst)).liquidity, o.gross);
  assert.equal(await dst.staking.fundedWei(), 0n);
  await assert.rejects(dst.pool.cancelAcross.staticCall(o, word(77n)), has('InvalidCancellation'));
  await sent(dst.pool.connect(dst.other).cancelAcross, o, word(598n));
  assert.equal(await dst.pool.exitStage(route), Stage.Cancelled);
  await assert.rejects(dst.pool.claimAcross.staticCall(o), has('InvalidExitStage'));
  await assert.rejects(src.pool.refundAcross.staticCall(o), has('InvalidExitStage'));
  const ack = await sent(dst.pool.publishOutcome, o, NO_PACKET_GAS);
  const q = queued(dst, l1, ack);
  for (const from of [l1.outbox.target, l1.bridge.target, l1.arb.target]) {
    await assert.rejects(l1.provider.call({ from, to: q.to, data: q.packet }), has('InvalidMessageSender'));
  }
  await assert.rejects(l1.outbox.deliver.staticCall(address(555n), l1.bridge.target, q.to, q.packet), has('InvalidMessageSender'));
  await pushPacket(chains, o, Packet.Cancelled, ack);
  assert.equal(await src.pool.exitStage(route), Stage.Refundable);
  assert.equal((await balances(src)).outbound, o.gross);
  const refundLeaf = await src.pool.commitment(o.gross, o.refundOwner);
  const done = await sent(src.pool.connect(src.other).refundAcross, o);
  const event = done.logs.filter((l) => l.address === src.pool.target).map((l) => src.pool.interface.parseLog(l)).find((l) => l?.name === 'ExitRefunded');
  assert.equal(event.args.leaf, refundLeaf);
  assert.equal(event.args.gross, o.gross);
  assert.deepEqual(await balances(src), old);
  assert.equal(await src.pool.reservedRefundLeaves(), 0n);
  await pushPacket(chains, o, Packet.Cancelled, ack);
  assert.equal(await src.pool.exitStage(route), Stage.Refunded);
  await assert.rejects(src.pool.refundAcross.staticCall(o), has('InvalidExitStage'));
  const forgedPaid = src.pool.interface.encodeFunctionData('acceptPacket', [route, o, Packet.Paid]);
  await assert.rejects(src.base.deliver.staticCall(l1.pool.target, src.pool.target, forgedPaid), has('InvalidExitStage'));
});


test('a saved hceth3 key restores only the proof-bound refund and separate cancellation preimage', () => {
  const cancelSecret = word(822n), gross = 10_002n, refund = openNote(ETH, gross);
  const context = { chainId: '31339', pool: address(82n), domain: word(54n) };
  const networkDomain = word(24n), lane = BASE;
  const o = { ...order(BASE, ARBITRUM, 8n, gross), refundOwner: refund.ownerCommit, cancelHash: keccak256(cancelSecret) };
  const route = { id: exitId(networkDomain, o), order: o, refundLeaf: refund.leaf, cancelSecret };
  const full = { ...privateBackup(context, [refund]), networkDomain, routes: [route] };
  const data = decodeNoteKey(encodeNoteKey(full));
  const { notes } = readBackup(data, context, codec);
  const restore = (d, current = networkDomain) => readRouteBackups(d, { networkDomain: current, lane }, notes);
  assert.deepEqual(restore(data), [route]);
  assert.deepEqual(restore(privateBackup(context, notes)), [], 'simple V3 keys need no route metadata');
  assert.throws(() => restore(data, word(25n)));
  for (const r of [{ ...route, cancelSecret: word(123n) }, { ...route, refundLeaf: word(678n) },
    { ...route, order: { ...o, recipient: address(10n) } }, { ...route, order: { ...o, destination: ETHEREUM } }]) {
    assert.throws(() => restore({ ...data, routes: [r] }));
  }
});

test('preview relay resumes only canonical, on-chain queued orders and cannot pay twice', { timeout: 180_000 }, async (t) => {
  const chains = await labs(t);
  const src = chains.get(ETHEREUM), dst = chains.get(ARBITRUM);
  for (const vm of chains.values()) Object.assign(vm, { relay: vm.other, write: (fn) => fn(),
    config: { networkDomain: await vm.pool.networkDomain() } });
  const clearing = localClearing(chains, hopBid(ETHEREUM, ARBITRUM));
  const o = order(ETHEREUM, ARBITRUM, 67n, parseEther('0.02') + 1n);
  const id = await src.pool.exitId(o);
  assert.equal((await clearing.route(src, id)).found, false);
  await assert.rejects(clearing.advance(src, id), /Unknown local exit/);
  await fundNotes(src);
  await fundNotes(dst);
  const { packetGas, value } = clearing.openingGas(src, o);
  const args = await makePlan(src, o, 4000n);
  const lock = await (await src.pool.withdrawAcross(...args, packetGas, { ...opts, value })).wait();
  const wireLog = lock.logs.find((l) => l.address === src.arb.target);
  assert.throws(() => clearing.recordLock(src, { to: lock.to, status: 0, logs: lock.logs }), /Unconfirmed/);
  assert.throws(() => clearing.recordLock(src, { to: lock.to, status: 1, logs: lock.logs.filter((l) => l !== wireLog) }), /transport event/);
  assert.equal(clearing.recordLock(src, lock), id);
  assert.equal(clearing.canCancel(dst, o), true);
  assert.equal(clearing.canCancel(src, o), false);
  assert.equal((await clearing.route(dst, id)).found, false);
  await assert.rejects(clearing.advance(dst, id), /Unknown local exit/);
  const waiting = await clearing.advance(src, id);
  assert.equal(waiting.sourceStage, Stage.Locked);
  assert.equal(waiting.destinationStage, Stage.Authorized);
  assert.equal(waiting.issue, 'liquidity');
  assert.equal(await dst.provider.getBalance(o.recipient), 0n);
  await addLiquidity(dst, o.gross * 2n);
  const done = await Promise.all([clearing.advance(src, id), clearing.advance(src, id)]);
  assert.equal(done[0].sourceStage, Stage.Settled);
  assert.deepEqual(done[0], done[1]);
  assert.ok(done[0].payoutTx);
  assert.equal(await dst.provider.getBalance(o.recipient), quoteFee(o.gross).net);
  assert.equal(await dst.pool.liquidityNative(), o.gross);

  // A second fresh lock can be cancelled successfully while authorized but
  // underfunded, and an advance after re-opening the backup finalizes the refund.
  const recover = order(ETHEREUM, ARBITRUM, 68n, o.gross + 1n);
  const secondArgs = await makePlan(src, recover, 4100n);
  const second = await (await src.pool.withdrawAcross(...secondArgs, packetGas, { ...opts, value })).wait();
  const otherId = clearing.recordLock(src, second);
  assert.equal((await clearing.advance(src, otherId)).issue, 'liquidity');
  await sent(dst.pool.cancelAcross, recover, word(568n));
  assert.equal((await clearing.route(src, otherId)).destinationStage, Stage.Cancelled);
  const restored = await clearing.advance(src, otherId);
  assert.equal(restored.sourceStage, Stage.Refunded);
  assert.deepEqual(await clearing.advance(src, otherId), restored);
  assert.equal(await src.pool.outboundNative(), 0n);
  assert.equal(await src.pool.reservedRefundLeaves(), 0n);
  assert.equal(await dst.pool.liquidityNative(), o.gross);
});
