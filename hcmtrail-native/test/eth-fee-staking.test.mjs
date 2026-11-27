import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id, keccak256, parseEther, toBeHex } from 'ethers';
import { deployEthPool } from '../pool/local.mjs';
import { ETH, FEE_BPS, MIN_DEPOSIT, abi, directLeg, quoteFee, statement } from '../pool/protocol.mjs';
import { openNote } from '../testnet/notes.mjs';
import { TX_GAS_CAP } from '../testnet/networks.mjs';

const opts = { gasLimit: TX_GAS_CAP };
const send = async (method, ...args) => (await method(...args, opts)).wait();
const to = (n) => toBeHex(0x5a7100n + BigInt(n), 20);
const has = (name) => (e) => e.revert?.name === name || e.data?.startsWith(id(`${name}()`).slice(0, 10));

async function lab(t) {
  const vm = await deployEthPool({ fixtures: true, harness: true, vmOptions: { keys: [1, 2, 3, 4].map((k) => toBeHex(k, 32)) } });
  t.after(vm.close);
  const { token, staking, provider } = vm;
  const [a, b, c] = await Promise.all([1, 2, 3].map((k) => provider.getSigner(k)));
  const start = await staking.start(), period = await staking.PERIOD();
  assert.equal(period, 2_592_000n);
  const at = async (e, offset = 0n) => {
    await provider.send('evm_setNextBlockTimestamp', [Number(start + BigInt(e) * period + offset)]);
    await provider.send('evm_mine', []);
  };
  const fund = async (value) => (await staking.fundFees({ ...opts, value })).wait();
  const stake = async (who, amount) => {
    await send(token.transfer, who.address, amount);
    await send(token.connect(who).approve, staking.target, amount);
    await send(staking.connect(who).stake, amount);
  };
  return { ...vm, a, b, c, at, stake, fund, period, position: (who) => staking.position(who.address) };
}

test('vault fees at 30-day boundaries are proportional to active HCMT, not wallet balances', { timeout: 120_000 }, async (t) => {
  const { a, b, c, at, stake, position, staking, token, pool, provider } = await lab(t);
  const cap = parseEther('100000'), one = parseEther('1'), three = parseEther('3');
  assert.equal(await token.totalSupply(), cap);
  assert.equal(await token.symbol(), 'HCMT');
  assert.equal(await staking.stakeToken(), token.target);
  await send(token.transfer, a.address, parseEther('1000')); // Bigger wallet, but smaller stake than b.
  await send(token.transfer, c.address, parseEther('100')); // Holder who does not stake receives no ETH.
  await stake(a, one);
  await stake(b, three);
  assert.equal((await position(a)).active, 0n);
  assert.equal((await position(b)).active, 0n);
  await at(1);
  assert.equal((await position(a)).active, one);
  assert.equal((await position(b)).active, three);
  assert.equal((await staking.epochState()).active, one + three);
  assert.equal(await token.balanceOf(staking.target), one + three);

  // These pot sizes divide exactly in both wei and the Q128 index for 4e18 shares.
  const wdFee = 4n * 5n ** 18n, depFee = 2n * wdFee;
  const grossForFee = (fee) => (fee * 10_000n + FEE_BPS - 1n) / FEE_BPS;
  const deposited = grossForFee(depFee), withdrawn = grossForFee(wdFee);
  const deposit = quoteFee(deposited), withdrawal = quoteFee(withdrawn);
  assert.ok(deposited >= MIN_DEPOSIT && deposit.net >= withdrawn);
  assert.equal(deposit.fee, depFee);
  assert.equal(withdrawal.fee, wdFee);
  const note = openNote(ETH, deposit.net);
  const receipt = await (await pool.deposit(note.ownerCommit, { ...opts, value: deposited })).wait();
  const feeTopic = staking.interface.getEvent('FeesFunded').topicHash;
  const feeEvent = receipt.logs.find((log) => log.address === staking.target && log.topics[0] === feeTopic);
  assert.deepEqual(staking.interface.parseLog(feeEvent).args.toArray(), [1n, pool.target, depFee]);
  await at(2, -1n);
  assert.equal((await position(a)).claimable, 0n, 'no ETH before period close');
  assert.equal((await position(b)).claimable, 0n);

  await at(2);
  assert.equal((await position(a)).claimable, depFee / 4n);
  assert.equal((await position(b)).claimable, depFee * 3n / 4n);
  assert.equal((await position(c)).claimable, 0n);
  await send(staking.connect(a).claim, to(51));
  assert.equal(await provider.getBalance(to(51)), depFee / 4n);

  // Exercise the vault payout accounting with the explicitly test-only spend verifier.
  const tip = await provider.getBlock('latest');
  const spend = { root: await pool.currentRoot(), notBefore: BigInt(tip.timestamp) / 600n * 600n,
    nullifiers: [toBeHex(5001n, 32), toBeHex(5002n, 32)], change: [toBeHex(5003n, 32), toBeHex(5004n, 32)] };
  const recipient = to(53);
  const proof = keccak256(abi.encode(['uint256[]'], [statement(spend, directLeg(recipient, withdrawn, staking.target))]));
  await send(pool.withdraw, proof, spend, recipient, withdrawn);
  assert.equal(await provider.getBalance(recipient), withdrawal.net);
  assert.equal(await staking.fundedWei(), depFee + wdFee);
  assert.equal((await position(a)).claimable, 0n, 'new fee is not mature');
  assert.equal((await position(b)).claimable, depFee * 3n / 4n, 'unclaimed ETH survives');

  await at(3);
  const total = depFee + wdFee;
  assert.equal((await position(a)).claimable, wdFee / 4n);
  assert.equal((await position(b)).claimable, total * 3n / 4n);
  await send(staking.connect(a).claim, to(51));
  await send(staking.connect(b).claim, to(52)); // Waited two periods, claimed once.
  assert.equal(await provider.getBalance(to(51)), total / 4n);
  assert.equal(await provider.getBalance(to(52)), total * 3n / 4n);
  assert.equal(await staking.claimedWei(), total);
  assert.equal(await provider.getBalance(staking.target), 0n);
  assert.equal(await token.balanceOf(staking.target), one + three, 'claims do not touch HCMT');
  assert.equal(await token.totalSupply(), cap);
  t.diagnostic(`1 HCMT vs 3 HCMT: ${total / 4n} vs ${total * 3n / 4n} wei from two closed periods`);
});

test('monthly fixed shares, delayed activation and exit, manual claims can accumulate without an epoch loop', { timeout: 90_000 }, async (t) => {
  const { a, b, c, at, stake, fund, position, staking, token, provider, artifacts, deploy } = await lab(t);
  await fund(400n); // no active stake yet, ETH carries forward
  await stake(a, 1n);
  await stake(b, 3n);
  assert.deepEqual((await staking.epochState()).toArray().slice(2), [0n, 4n, 400n]);
  assert.equal((await position(a)).claimable, 0n);

  await at(1);
  assert.equal((await position(a)).active, 1n);
  assert.equal((await position(b)).active, 3n);
  assert.equal((await position(b)).claimable, 0n);
  await send(staking.connect(a).requestUnstake, 1n);
  await assert.rejects(staking.connect(a).withdrawStake.staticCall(1n, a.address), has('InvalidAmount'));
  assert.equal((await position(a)).active, 1n);
  await stake(b, 1n);
  await stake(c, 4n);
  assert.equal((await position(c)).active, 0n);
  await fund(4n);

  await at(2);
  assert.equal((await position(a)).withdrawable, 1n);
  assert.equal((await position(a)).active, 0n);
  assert.equal((await position(a)).claimable, 101n);
  assert.equal((await position(b)).claimable, 303n);
  assert.equal((await position(c)).claimable, 0n);
  assert.equal((await position(c)).active, 4n);
  await assert.rejects(staking.connect(c).withdrawStake.staticCall(1n, c.address), has('InvalidAmount'));
  await send(staking.connect(a).withdrawStake, 1n, a.address);
  assert.equal(await token.balanceOf(a.address), 1n);
  assert.equal(await staking.heldStake(), 8n);

  const reject = await deploy(artifacts.reject);
  await assert.rejects(send(staking.connect(a).claim, reject.target));
  assert.equal((await position(a)).claimable, 101n);
  await send(staking.connect(a).claim, to(1));
  assert.equal(await provider.getBalance(to(1)), 101n);
  assert.equal(await staking.connect(a).claim.staticCall(to(1)), 0n);
  await fund(200n);
  await at(3);
  await fund(80n);
  await at(83); // no writes during these months, including no keeper
  assert.equal((await position(b)).claimable, 443n);
  assert.equal((await position(c)).claimable, 140n);
  const collect = await send(staking.connect(b).claim, to(2));
  assert.ok(collect.gasUsed < 200_000n);
  await send(staking.connect(c).claim, to(3));
  assert.equal(await provider.getBalance(to(2)), 443n);
  assert.equal(await provider.getBalance(to(3)), 140n);
  assert.equal(await staking.fundedWei(), 684n);
  assert.equal(await staking.claimedWei(), 684n);
  assert.equal(await provider.getBalance(staking.target), 0n);
  assert.equal(await token.balanceOf(staking.target), 8n);
  t.diagnostic(`claim after 80 skipped epochs: ${collect.gasUsed} gas`);
});

test('unassigned fees and fractional residues carry forward, and early claims do not destroy dust', { timeout: 90_000 }, async (t) => {
  const { a, b, at, stake, fund, position, staking, provider } = await lab(t);
  await fund(3n);
  await at(9);
  await stake(a, 1n);
  await stake(b, 2n);
  assert.equal((await staking.epochState()).potWei, 3n);
  // Skip the next boundary and close the first eligible month with no writes.
  await at(11);
  assert.equal((await position(a)).claimable, 1n);
  assert.equal((await position(b)).claimable, 2n);
  await send(staking.connect(a).claim, to(11));
  await send(staking.connect(b).claim, to(12));
  for (let epoch = 11; epoch < 14; epoch++) {
    await fund(1n);
    await at(epoch + 1);
    await send(staking.connect(b).claim, to(12));
  }
  await send(staking.connect(a).claim, to(11));
  assert.equal(await provider.getBalance(to(11)), 2n);
  assert.equal(await provider.getBalance(to(12)), 4n);
  assert.equal(await staking.claimedWei(), 6n);
  assert.equal(await provider.getBalance(staking.target), 0n);
});

test('reject short token transfers and leave custody accounting unchanged', { timeout: 90_000 }, async (t) => {
  const { a, artifacts, deploy } = await lab(t);
  const token = await deploy(artifacts.taxedToken);
  const staking = await deploy(artifacts.staking, token.target);
  await send(token.mint, a.address, 10n);
  await send(token.connect(a).approve, staking.target, 10n);
  await assert.rejects(staking.connect(a).stake.staticCall(10n), has('TokenTransferFailed'));
  await assert.rejects(send(staking.connect(a).stake, 10n));
  assert.equal(await staking.heldStake(), 0n);
  assert.equal(await staking.nextStake(), 0n);
  assert.equal(await token.balanceOf(a.address), 10n);
  assert.equal(await token.balanceOf(staking.target), 0n);
});

test('lazy monthly accounting matches an explicit period-by-period ledger across changing stakes', { timeout: 90_000 }, async (t) => {
  const { a, b, c, at, stake, fund, position, staking, token, provider } = await lab(t);
  const unit = 1n << 128n;
  const accounts = [a, b, c].map((signer, i) => ({ signer, payout: to(20 + i), active: 0n, next: 0n,
    exiting: 0n, withdrawable: 0n, credit: 0n, paid: 0n }));
  let carry = 0n, funded = 0n, epoch = 0;
  function settleUntil(target) {
    // Slow reference: account for every elapsed month and every participant.
    while (epoch < target) {
      const shares = accounts.reduce((sum, p) => sum + p.active, 0n);
      if (shares) {
        const perShare = carry / shares;
        for (const p of accounts) p.credit += p.active * perShare;
        carry -= perShare * shares;
      }
      for (const p of accounts) { p.active = p.next; p.withdrawable += p.exiting; p.exiting = 0n; }
      ++epoch;
    }
  }
  let x = 9173;
  const rnd = (n) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return Math.floor(x / 2 ** 32 * n);
  };
  for (let i = 0; i < 72; ++i) {
    if (i % 6 === 5) {
      const wall = epoch + 1 + rnd(9);
      await at(wall);
      settleUntil(wall);
    }
    const p = accounts[rnd(accounts.length)];
    const actor = staking.connect(p.signer);
    const qty = BigInt(1 + rnd(59));
    const op = rnd(5);
    if (op === 0) {
      await fund(qty);
      carry += qty * unit;
      funded += qty;
    } else if (op === 1) {
      await stake(p.signer, qty);
      p.next += qty;
    } else if (op === 2 && p.next) {
      const exit = qty < p.next ? qty : p.next;
      await send(actor.requestUnstake, exit);
      p.next -= exit;
      p.exiting += exit;
    } else if (op === 3 && p.withdrawable) {
      const release = qty < p.withdrawable ? qty : p.withdrawable;
      await send(actor.withdrawStake, release, p.signer.address);
      p.withdrawable -= release;
    } else if (op === 4) {
      await send(actor.claim, p.payout);
      p.paid += p.credit / unit;
      p.credit %= unit;
      assert.equal(await provider.getBalance(p.payout), p.paid);
    }
    for (const p of accounts) {
      assert.deepEqual((await position(p.signer)).toArray(), [p.active, p.next, p.exiting, p.withdrawable, p.credit / unit]);
    }
    const held = accounts.reduce((sum, p) => sum + p.next + p.exiting + p.withdrawable, 0n);
    const paid = accounts.reduce((sum, p) => sum + p.paid, 0n);
    assert.equal(await staking.heldStake(), held);
    assert.equal(await token.balanceOf(staking.target), held);
    assert.equal(await staking.fundedWei(), funded);
    assert.equal(await staking.claimedWei(), paid);
    assert.equal(await provider.getBalance(staking.target), funded - paid);
  }
});
