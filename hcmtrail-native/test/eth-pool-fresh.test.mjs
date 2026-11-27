// Real WASM STARK proofs, local EVM only. Run sequentially on memory-limited devices.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseEther, toBeHex } from 'ethers';
import * as codec from '../testnet/notes.mjs';
import { TX_GAS_CAP } from '../testnet/networks.mjs';
import { deployEthPool } from '../pool/local.mjs';
import { readPool } from '../pool/view.mjs';
import { settleReady } from '../pool/keeper.mjs';
import { ETH, directLeg, parseProver, prepareProof, quoteFee, reservationLeg, validateProof } from '../pool/protocol.mjs';
import { proveInWasm } from '../pool/wasm.mjs';

const VM_WASM = new URL('../build/eth-pool/prover.wasm', import.meta.url);
const gasLimit = TX_GAS_CAP;
const to = (i) => toBeHex(0xacc000n + BigInt(i), 20);

test('local WASM → pinned verifier → ETH payment, then 5 real reserves → one keeper transaction', { timeout: 3_600_000 }, async (t) => {
  const vm = await deployEthPool();
  t.after(vm.close);
  const { pool, staking } = vm;
  const payer = pool.connect(await vm.provider.getSigner(1));
  const read = () => readPool(pool, vm.provider, vm.fromBlock, { snapshot: true });
  const sent = async (fn, ...args) => (await fn(...args, { gasLimit })).wait();
  const wasm = readFileSync(VM_WASM);
  const cache = process.env.POOL_PERIODIC_CACHE ? readFileSync(process.env.POOL_PERIODIC_CACHE) : undefined;
  const make = async (note, leg) => {
    const state = await read();
    assert.equal(codec.rebuildRoot(state.leaves), state.root);
    const index = state.leaves.indexOf(note.leaf);
    assert.ok(index > 0);
    const plan = prepareProof(codec, state, { note, index }, leg);
    const start = Date.now();
    const { proof, publicAndChange } = await proveInWasm(wasm, plan, { cache });
    t.diagnostic(`WASM proof ${(proof.length - 2) / 2} bytes in ${Math.round((Date.now() - start) / 1000)}s`);
    return validateProof(codec, plan, proof, parseProver(publicAndChange));
  };
  const fund = async (value) => {
    const note = codec.openNote(ETH, quoteFee(value).net);
    await (await pool.deposit(note.ownerCommit, { value, gasLimit })).wait();
    return note;
  };
  const full = parseEther('0.123456789012345678');
  const payout = parseEther('0.019876543210987654');
  const n = await fund(full);
  const simple = await make(n, directLeg(to(500), payout, staking.target));
  await assert.rejects(payer.withdraw.staticCall(simple.proof, simple.spend, to(501), payout));
  const receipt = await sent(payer.withdraw, simple.proof, simple.spend, to(500), payout);
  t.diagnostic(`real solo STARK withdrawal: ${receipt.gasUsed} gas`);
  assert.equal(await vm.provider.getBalance(to(500)), quoteFee(payout).net);
  assert.equal(simple.change[0].value, n.value - payout);
  assert.equal(await pool.shieldedNative(), n.value - payout);
  assert.ok((await read()).leaves.includes(simple.change[0].leaf));
  await assert.rejects(payer.withdraw.staticCall(simple.proof, simple.spend, to(500), payout));

  const domain = await pool.domain();
  // First spend the actual change note from the earlier withdrawal, with a one-wei reservation.
  // A separate tiny round demonstrates the 1-wei price/recipient binding and expiration.
  const one = { amount: 1n, round: 1n, target: 5, recipient: to(600), salt: toBeHex(31, 32) };
  const refund1 = codec.openNote(ETH, 1n);
  const tiny = await make(simple.change[0], reservationLeg(domain, one, 1n, refund1.ownerCommit));
  await assert.rejects(payer.withdraw.staticCall(tiny.proof, tiny.spend, to(600), 1n));
  await sent(payer.reserve, tiny.proof, tiny.spend, one, 1n, refund1.ownerCommit);

  const funding = parseEther('0.010000000000000001');
  const amount = quoteFee(funding).net;
  let backed = n.value;
  for (let i = 0; i < 5; ++i) {
    const note = await fund(funding);
    backed += amount;
    const terms = { amount, round: 1n, target: 5, recipient: to(i), salt: toBeHex(i + 1, 32) };
    const refund = codec.openNote(ETH, amount);
    const order = await make(note, reservationLeg(domain, terms, amount, refund.ownerCommit));
    if (i === 0) {
      await assert.rejects(payer.reserve.staticCall(order.proof, order.spend, { ...terms, recipient: to(610) }, amount, refund.ownerCommit));
      await assert.rejects(payer.reserve.staticCall(order.proof, order.spend, { ...terms, target: 26 }, amount, refund.ownerCommit));
      await assert.rejects(payer.reserve.staticCall(order.proof, order.spend, terms, amount, codec.openNote(ETH, amount).ownerCommit));
    }
    const admission = await sent(payer.reserve, order.proof, order.spend, terms, amount, refund.ownerCommit);
    t.diagnostic(`real entry ${i + 1}/5: ${admission.gasUsed} gas, no ETH sent to recipient yet`);
    assert.equal(await vm.provider.getBalance(terms.recipient), 0n);
    assert.equal((await pool.getBatch(amount, 1n)).count, BigInt(i + 1));
  }
  const settled = [];
  await settleReady({ pool, read, send: (name, args) => sent(pool[name], ...args), report: (x) => settled.push(x) });
  assert.equal(settled.length, 1);
  assert.ok(settled[0].receipt);
  t.diagnostic(`atomic execution of five real verified tickets: ${settled[0].receipt.gasUsed} gas`);
  for (let i = 0; i < 5; ++i) assert.equal(await vm.provider.getBalance(to(i)), quoteFee(amount).net);
  assert.equal(await pool.reservedNative(), 1n);
  const tinyBatch = await pool.getBatch(1n, 1n);
  await vm.provider.send('evm_setNextBlockTimestamp', [Number(tinyBatch.expiresAt)]);
  await vm.provider.send('evm_mine', []);
  await sent(payer.refundPart, one, tiny.spend.nullifiers[0]);
  assert.ok((await read()).leaves.includes(refund1.leaf));
  assert.equal(await pool.reservedNative(), 0n);
  assert.equal(await pool.shieldedNative(), backed - payout - amount * 5n);
  assert.equal(await staking.fundedWei(), quoteFee(full).fee + quoteFee(payout).fee + (quoteFee(funding).fee + quoteFee(amount).fee) * 5n);
  assert.equal(await vm.provider.getBalance(pool.target), backed - payout - amount * 5n);
});
