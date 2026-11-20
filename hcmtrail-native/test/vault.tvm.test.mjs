import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexlify, id, sha256, ZeroHash } from 'ethers';
import { ensureSuccess, localTvm, TRON_ID, TVM_RELAYER } from './local-tvm.mjs';
import { artifacts, depositFixture, deployVault, loadVector, stack } from './vault-fixture.mjs';

function reverted({ execResult }, name) {
  assert.equal(execResult.exceptionError?.error, 'revert', hexlify(execResult.returnValue));
  if (name) assert.equal(hexlify(execResult.returnValue).slice(0, 10), id(`${name}()`).slice(0, 10));
}

test('TRON bytecode refuses a foreign VM chain and a mismatched STARK stack', async () => {
  const a = artifacts(true);
  const foreign = await localTvm({ chainId: 999n });
  const s = await stack(foreign.deploy, a);
  reverted(await foreign.deployRaw(a.vaults.TRX, s.args), 'WrongChain');
  const home = await localTvm();
  const h = await stack(home.deploy, a);
  reverted(await home.deployRaw(a.vaults.TRX, [h.prepare.target, h.chunks[0], h.chunks]), 'WrongStarkCode');
});

test('TRON compiler + TVM: sun deposits through a real STARK to exactly one native exit', async (t) => {
  const f = await deployVault('TRX');
  const { vault: v } = f;
  assert.equal(await v.view('homeChainId'), TRON_ID);
  assert.equal(await v.view('asset'), 2n);
  assert.equal(await v.view('unitsPerCoin'), 1_000_000n);
  const cap = 2n ** 63n - 1n;
  assert.equal(await v.view('custodyCap'), cap);
  const d = await depositFixture(f, 'TRX');
  const { proof, info } = loadVector('TRX');
  const x = info.exit;
  assert.equal(v.target, info.vault);
  assert.equal(info.chainId, TRON_ID.toString());
  assert.equal(info.depositValue, d.value.toString());
  assert.equal(d.root, x.root);
  assert.deepEqual(d.leaves, info.leaves);
  assert.deepEqual(d.owners, info.owners);
  assert.equal(sha256(proof), info.proofSha256);
  assert.equal(await f.balance(v.target), 20_000_000n);

  // ABI integers stay exact in sun even past Number.MAX_SAFE_INTEGER.
  const big = 9_007_199_254_740_993n;
  assert.notEqual(await v.view('commitment', [big, d.owners[0]]), await v.view('commitment', [big - 1n, d.owners[0]]));
  reverted(await v.send('commitment', [cap + 1n, d.owners[0]]), 'InvalidAmount');
  reverted(await v.send('deposit', [d.owners[0]]), 'InvalidAmount');
  reverted(await v.raw(new Uint8Array(), { value: 1n }));
  const exit = (p = proof, mod = {}, opts) => v.send('withdraw', [p, { ...x, ...mod }], { from: TVM_RELAYER, ...opts });
  reverted(await exit(proof, { root: ZeroHash }), 'UnknownRoot');
  reverted(await exit(proof, { amount: BigInt(x.amount) + 1n }), 'InvalidStarkProof');
  reverted(await exit(proof, { recipient: TVM_RELAYER }), 'InvalidStarkProof');
  reverted(await exit(proof.slice(0, -2)), 'InvalidStarkProof');
  reverted(await exit(proof, {}, { timestamp: BigInt(x.notBefore) - 1n }), 'InvalidTime');
  assert.equal(await v.view('leafCount'), 3n);
  assert.equal(await v.view('accountedNative'), 20_000_000n);
  for (const nf of x.nullifiers) assert.equal(await v.view('spent', [nf]), false);

  const before = await f.balance(x.recipient);
  const beforeFee = await f.balance(x.feeRecipient);
  const receipt = ensureSuccess(await exit());
  const [, topics, data] = receipt.logs.at(-1);
  const event = v.iface.parseLog({ topics: topics.map((topic) => hexlify(topic)), data: hexlify(data) });
  assert.equal(event.name, 'Withdrawn');
  assert.deepEqual(event.args.toArray(), [...x.nullifiers, x.recipient, BigInt(x.amount), x.feeRecipient, BigInt(x.fee)]);
  assert.equal(await f.balance(x.recipient) - before, BigInt(x.amount));
  assert.equal(await f.balance(x.feeRecipient) - beforeFee, BigInt(x.fee));
  assert.equal(await f.balance(v.target), d.value - d.fee);
  assert.equal(await v.view('accountedNative'), d.value - d.fee);
  assert.equal(await v.view('leafCount'), 5n);
  for (const nf of x.nullifiers) assert.equal(await v.view('spent', [nf]), true);
  reverted(await exit(), 'AlreadySpent');
  t.diagnostic(`TRX emulator: deploy ${v.deployment.executionGasUsed}, deposit ${d.depositGas}, exit ${receipt.executionGasUsed} execution units; no live Energy claim`);
});
