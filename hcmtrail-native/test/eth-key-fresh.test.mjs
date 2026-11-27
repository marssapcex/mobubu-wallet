import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseEther, toBeHex } from 'ethers';
import { deployEthPool } from '../pool/local.mjs';
import { ETH, decodeNoteKey, directLeg, encodeNoteKey, parseProver, poolDomain, prepareProof, privateBackup, quoteFee,
  readBackup, validateProof } from '../pool/protocol.mjs';
import { readPool } from '../pool/view.mjs';
import { proveInWasm } from '../pool/wasm.mjs';
import { TX_GAS_CAP } from '../testnet/networks.mjs';
import { LOCAL_ID } from './local-evm.mjs';
import * as codec from '../testnet/notes.mjs';

const opts = { gasLimit: TX_GAS_CAP };
const send = async (f, ...a) => (await f(...a, opts)).wait();

test('Ethereum VM: recover a note, verify a real WASM STARK, withdraw ETH and claim fees with staked HCMT', { timeout: 1_800_000 }, async (t) => {
  const wasm = readFileSync(new URL('../build/eth-pool/prover.wasm', import.meta.url));
  const cache = process.env.POOL_PERIODIC_CACHE ? readFileSync(process.env.POOL_PERIODIC_CACHE) : undefined;
  const vm = await deployEthPool({ chainId: LOCAL_ID });
  t.after(vm.close);
  const { pool, token, staking, provider } = vm;
  const user = await provider.getSigner(1);
  const owner = await user.getAddress();
  const end = await staking.start();
  const period = await staking.PERIOD();
  const at = async (epoch) => {
    await provider.send('evm_setNextBlockTimestamp', [Number(end + period * epoch)]);
    await provider.send('evm_mine', []);
  };
  const staked = parseEther('1');
  assert.equal(await token.symbol(), 'HCMT');
  assert.equal(await staking.stakeToken(), token.target);
  await send(token.transfer, owner, staked);
  await send(token.connect(user).approve, staking.target, staked);
  await send(staking.connect(user).stake, staked);
  await at(1n);

  const gross = parseEther('1') + 17n;
  const deposit = quoteFee(gross);
  const note = codec.openNote(ETH, deposit.net);
  const context = { chainId: String(LOCAL_ID), pool: pool.target, domain: poolDomain(LOCAL_ID, pool.target) };
  assert.equal(await pool.domain(), context.domain);
  const key = encodeNoteKey(privateBackup(context, [note]));
  await (await pool.deposit(note.ownerCommit, { ...opts, value: gross })).wait();
  assert.equal(await pool.shieldedNative(), deposit.net);
  assert.equal(await staking.fundedWei(), deposit.fee);

  const [restored] = readBackup(decodeNoteKey(key), context, codec).notes;
  const state = await readPool(pool, provider, vm.fromBlock, { snapshot: true });
  assert.equal(codec.rebuildRoot(state.leaves), state.root);
  const recipient = toBeHex(0xec201n, 20);
  const expected = quoteFee(restored.value);
  const withdraw = pool.connect(user).withdraw;
  const plan = prepareProof(codec, state, { note: restored, index: state.leaves.indexOf(restored.leaf) },
    directLeg(recipient, restored.value, staking.target));
  const result = await proveInWasm(wasm, plan, { cache });
  const spend = validateProof(codec, plan, result.proof, parseProver(result.publicAndChange));
  assert.equal(spend.change.length, 0);
  await assert.rejects(withdraw.staticCall(spend.proof, spend.spend, toBeHex(0xec202n, 20), restored.value));
  await assert.rejects(withdraw.staticCall(spend.proof, spend.spend, recipient, restored.value - 1n));
  const receipt = await send(withdraw, spend.proof, spend.spend, recipient, restored.value);
  assert.equal(await provider.getBalance(recipient), expected.net);
  assert.equal(await provider.getBalance(pool.target), 0n);
  assert.equal(await pool.shieldedNative(), 0n);
  await assert.rejects(withdraw.staticCall(spend.proof, spend.spend, recipient, restored.value));

  const allFees = deposit.fee + expected.fee;
  assert.equal(await staking.fundedWei(), allFees);
  assert.equal(await provider.getBalance(staking.target), allFees);
  assert.equal((await staking.position(owner)).claimable, 0n);
  await at(2n);
  const scale = 1n << 128n;
  const claimable = ((allFees * scale / staked) * staked) / scale;
  assert.ok(allFees - claimable <= 1n);
  assert.equal((await staking.position(owner)).claimable, claimable);
  const rewardsTo = toBeHex(0xec203n, 20);
  await send(staking.connect(user).claim, rewardsTo);
  assert.equal(await provider.getBalance(rewardsTo), claimable);
  assert.equal(await provider.getBalance(staking.target), allFees - claimable);
  assert.equal((await staking.position(owner)).claimable, 0n);
  assert.equal(await token.balanceOf(staking.target), staked);
  assert.equal(await token.totalSupply(), parseEther('100000'));
  t.diagnostic(`${gross} → ${deposit.net} → ${expected.net} wei; staking ${allFees} wei; withdrawal ${receipt.gasUsed} gas; ${(spend.proof.length - 2) / 2} proof bytes`);
});
