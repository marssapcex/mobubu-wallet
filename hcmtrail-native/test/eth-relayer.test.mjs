import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, keccak256, parseEther, toBeHex } from 'ethers';
import { deployEthPool } from '../pool/local.mjs';
import { startLabRelayer } from '../pool/relayer.mjs';
import { ETH, abi, directLeg, quoteEqualBatch, quoteFee, reservationLeg, statement } from '../pool/protocol.mjs';
import { openNote } from '../testnet/notes.mjs';
import { sent, opts } from './message-driver.mjs';

const wei = parseEther;
const address = (i) => getAddress(toBeHex(0xb00000n + BigInt(i), 20));
const word = (n) => toBeHex(n, 32);

test('equal-ticket quotes reject indivisible totals and never shift a wei to one recipient', () => {
  assert.deepEqual(quoteEqualBatch(wei('10'), 20), {
    gross: wei('0.5'), fee: wei('0.00045'), net: wei('0.49955'), totalFee: wei('0.009'), totalNet: wei('9.991'),
  });
  assert.throws(() => quoteEqualBatch(wei('10') + 1n, 20), /chia hết/);
  assert.throws(() => quoteEqualBatch(wei('10'), 101));
  assert.deepEqual(quoteEqualBatch(5555n, 5), { gross: 1111n, fee: 0n, net: 1111n, totalFee: 0n, totalNet: 5555n });
});

test('100 active HCMT, payout-only worker, exact 20-way batch and capped relay credit', { timeout: 180_000 }, async (t) => {
  const vm = await deployEthPool({ fixtures: true, harness: true });
  t.after(vm.close);
  const { pool, token, staking, provider } = vm;
  const operator = await provider.getSigner(1);
  const user = staking.connect(operator);
  const start = await staking.start(), period = await staking.PERIOD();
  const at = async (epoch) => {
    await provider.send('evm_setNextBlockTimestamp', [Number(start + period * BigInt(epoch))]);
    await provider.send('evm_mine', []);
  };
  const workerArgs = { pool, staking, signer: operator, write: (f) => f() };
  const min = wei('100'), cap = wei('0.003');
  assert.equal(await staking.MIN_RELAY_STAKE(), min);
  assert.equal(await staking.MAX_RELAY_REWARD(), cap);
  assert.equal(await staking.relayEnabled(), true);
  await sent(token.transfer, operator.address, min);
  await assert.rejects(startLabRelayer(workerArgs), /100 HCMT/, 'a wallet balance alone does not count');
  await sent(token.connect(operator).approve, staking.target, min);
  await sent(user.stake, min - 1n);
  await at(1);
  await assert.rejects(startLabRelayer(workerArgs), /100 HCMT/, 'one token unit below the floor');
  await sent(user.stake, 1n);
  await assert.rejects(startLabRelayer(workerArgs), /100 HCMT/, 'a scheduled top-up does not count yet');
  await at(2);
  const worker = await startLabRelayer(workerArgs);
  assert.equal((await worker.status()).activeStake, min);
  assert.equal((await worker.status()).credit, 0n);
  await assert.rejects(staking.fundPayoutFees.staticCall(operator.address, { value: wei('1') }), /InvalidFeeSource/);

  // Same 9 bps on 10 ETH gross, whether deposited or paid out as twenty tickets.
  const total = wei('10'), count = 20;
  const q = quoteEqualBatch(total, count);
  const deposit = async (value) => {
    const note = openNote(ETH, quoteFee(value).net);
    await (await pool.deposit(note.ownerCommit, { ...opts, value })).wait();
  };
  await deposit(total);
  assert.equal(await staking.fundedWei(), q.totalFee);
  await deposit(wei('1')); // provide the post-deposit principal to cover the full batch + other tests
  const depositFees = q.totalFee + wei('0.0009');
  assert.equal(await staking.fundedWei(), depositFees);
  assert.equal(await staking.relayFundedWei(), 0n);

  // Fixture proof only: real custody, verifier-facing statements and EVM payouts.
  const domain = await pool.domain(), root = await pool.currentRoot();
  const block = await provider.getBlock('latest');
  let seq = 1000n;
  const spend = () => ({ root, notBefore: BigInt(block.timestamp) / 600n * 600n,
    nullifiers: [word(seq++), word(seq++)], change: [word(seq++), word(seq++)] });
  const proof = (s, leg) => keccak256(abi.encode(['uint256[]'], [statement(s, leg)]));
  const ticket = (i, salt = i + 1) => {
    const terms = { amount: q.gross, round: 1n, target: count, recipient: address(i), salt: word(salt) };
    const refund = openNote(ETH, q.gross).ownerCommit, s = spend();
    return [proof(s, reservationLeg(domain, terms, q.gross, refund)), s, terms, q.gross, refund];
  };
  await sent(pool.reserve, ...ticket(0));
  const duplicate = ticket(0, 70);
  await assert.rejects(sent(pool.reserve, ...duplicate));
  assert.equal(await pool.spent(duplicate[1].nullifiers[0]), false);
  assert.equal(await pool.reservedNative(), q.gross);
  assert.equal((await pool.getBatch(q.gross, 1n)).count, 1n);
  for (let i = 1; i < count; ++i) await sent(pool.reserve, ...ticket(i));
  assert.equal(await pool.reservedNative(), total);
  assert.equal(await staking.quoteRelayReward(operator.address, q.totalFee), cap);
  assert.equal(await staking.quoteRelayReward(vm.signer.address, q.totalFee), 0n);

  const payBatch = { chainId: '31337', pool: pool.target, value: '0', data: pool.interface.encodeFunctionData('executeBatch', [q.gross, 1n]) };
  await assert.rejects(worker.submit({ ...payBatch, chainId: '1' }));
  await assert.rejects(worker.submit({ ...payBatch, pool: address(70) }));
  await assert.rejects(worker.submit({ ...payBatch, value: '1' }));
  await assert.rejects(worker.submit({ ...payBatch, fee: '1' }));
  await assert.rejects(worker.submit({ ...payBatch, data: payBatch.data + '00' }));
  assert.throws(() => worker.send('deposit', [word(88)]));
  const profitWorker = await startLabRelayer({ ...workerArgs, minProfitWei: cap + 1n });
  await assert.rejects(profitWorker.submit(payBatch), /không đủ bù gas/);
  assert.equal((await pool.getBatch(q.gross, 1n)).paid, false);
  const receipt = await worker.submit(payBatch);
  assert.equal(receipt.from, operator.address);
  const event = receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)).find((l) => l?.name === 'BatchPaid');
  assert.deepEqual(event.args.toArray(), [q.gross, 1n, BigInt(count), q.totalNet, q.totalFee]);
  for (let i = 0; i < count; ++i) assert.equal(await provider.getBalance(address(i)), q.net);
  assert.equal(await staking.relayCredit(operator.address), cap);
  assert.equal(await staking.fundedWei(), depositFees + q.totalFee - cap);
  assert.equal(await pool.reservedNative(), 0n);
  await assert.rejects(worker.submit(payBatch));
  assert.equal(await staking.relayCredit(operator.address), cap);
  t.diagnostic(`10 ETH / 20 recipients: 499550000000000000 wei each; 450000000000000 wei fee each; relay ${cap} wei once; ${receipt.gasUsed} gas`);

  const soloGross = wei('0.1'), to = address(300);
  const s = spend(), leg = directLeg(to, soloGross, staking.target), w = proof(s, leg);
  await assert.rejects(worker.send('withdraw', [w, s, address(301), soloGross]));
  await assert.rejects(worker.send('withdraw', [w, s, to, soloGross - 1n]));
  assert.equal(await pool.spent(s.nullifiers[0]), false);
  await worker.send('withdraw', [w, s, to, soloGross]);
  assert.equal(await provider.getBalance(to), leg.amount);
  assert.equal(await provider.getBalance(address(301)), 0n);
  const credited = cap + leg.fee / 2n;
  assert.equal(await staking.relayCredit(operator.address), credited);

  const reject = await vm.deploy(vm.artifacts.reject);
  const r = spend();
  await assert.rejects(sent(pool.connect(operator).withdraw, proof(r, directLeg(reject.target, soloGross, staking.target)), r, reject.target, soloGross));
  assert.equal(await pool.spent(r.nullifiers[0]), false);
  assert.equal(await staking.relayCredit(operator.address), credited);

  await sent(user.requestUnstake, 1n);
  assert.equal(await worker.active(), true);
  await at(3);
  assert.equal(await worker.active(), false);
  const direct = spend(), recipient = address(302), sig = proof(direct, directLeg(recipient, soloGross, staking.target));
  await assert.rejects(worker.send('withdraw', [sig, direct, recipient, soloGross]), /100 HCMT/);
  await sent(pool.connect(operator).withdraw, sig, direct, recipient, soloGross); // users are not gated
  assert.equal(await provider.getBalance(recipient), leg.amount);
  assert.equal(await staking.relayCredit(operator.address), credited);
  await assert.rejects(sent(user.claimRelayReward, reject.target));
  assert.equal(await staking.relayCredit(operator.address), credited);
  await sent(user.claimRelayReward, address(303));
  await sent(user.claimRelayReward, address(303));
  assert.equal(await provider.getBalance(address(303)), credited);
  assert.equal(await staking.relayClaimedWei(), credited);
  assert.equal(await staking.relayFundedWei(), credited);
  assert.equal(await staking.relayCredit(operator.address), 0n);
  assert.equal(await provider.getBalance(staking.target), await staking.fundedWei());
  assert.equal(await token.totalSupply(), wei('100000'));
});
