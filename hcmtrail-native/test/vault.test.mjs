import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractFactory, id, sha256, toBeHex, ZeroAddress, ZeroHash } from 'ethers';
import { GAS, localEvm } from './local-evm.mjs';
import { ASSETS, artifacts, depositFixture, deployVault, loadVector, OTHER_RECIPIENT, VAULT_TX_LIMIT, stack } from './vault-fixture.mjs';

const GOLDILOCKS_P = 0xffffffff00000001n;
const badField = toBeHex(GOLDILOCKS_P, 32);
const changedDigest = toBeHex(314159n, 32);

async function reverts(call, signature) {
  await assert.rejects(call, (err) => {
    assert.equal(err.data?.slice(0, 10), id(`${signature}()`).slice(0, 10), String(err));
    return true;
  });
}

async function rebuild(hash2, leaves) {
  let row = leaves;
  let zero = ZeroHash;
  for (let level = 0; level < 32; ++level) {
    const parents = [];
    for (let i = 0; i < row.length; i += 2) parents.push(await hash2(row[i], row[i + 1] ?? zero));
    row = parents;
    if (level < 31) zero = await hash2(zero, zero);
  }
  assert.equal(row.length, 1);
  return row[0];
}

test('EVM vault constructors reject the wrong chain, spoofed verifier bytecode, wrong immutable link and changed code chunks', async (t) => {
  const a = artifacts(false);
  const vm = await localEvm(ASSETS.ETH);
  t.after(vm.close);
  const from = await vm.signer.getAddress();
  const s = await stack((art, ...args) => vm.deploy(art, ...args, { gasLimit: GAS }), a);
  const badLink = (await vm.deploy(a.walk, s.chunks[0])).target;
  const create = async (symbol, args = s.args) => {
    const artifact = a.vaults[symbol];
    const init = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args);
    return vm.provider.call({ ...init, from, gasLimit: GAS });
  };
  await reverts(() => create('BNB'), 'WrongChain');
  await reverts(() => create('HYPE'), 'WrongChain');
  await reverts(() => create('ETH', [s.chunks[0], s.walk.target, s.chunks]), 'WrongStarkCode');
  await reverts(() => create('ETH', [s.prepare.target, s.chunks[0], s.chunks]), 'WrongStarkCode');
  await reverts(() => create('ETH', [s.prepare.target, badLink, s.chunks]), 'WrongStarkCode');
  await reverts(() => create('ETH', [s.prepare.target, s.walk.target, [...s.chunks].reverse()]), 'ChunkMismatch');
});

for (const [symbol, chain] of Object.entries(ASSETS).filter(([a]) => a !== 'TRX')) {
  test(`${symbol}: a real STARK of funded notes pays native amount and fee once from an unrelated relayer`, async (t) => {
    const f = await deployVault(symbol);
    t.after(f.close);
    const v = f.vault;
    assert.equal(await v.homeChainId(), chain);
    assert.equal(await v.asset(), BigInt(Object.keys(ASSETS).indexOf(symbol)));
    assert.equal(await v.unitsPerCoin(), 10n ** 18n);
    assert.equal(await v.custodyCap(), GOLDILOCKS_P - 2n);
    assert.equal(await v.starkWalk(), f.verifier.walk.target);
    const deployment = (await v.deploymentTransaction().wait()).gasUsed;
    assert(deployment < VAULT_TX_LIMIT, `vault creation uses ${deployment} gas`);
    const d = await depositFixture(f, symbol);
    assert.equal(await f.balance(v.target), 2n * d.value);
    const { proof, info } = loadVector(symbol);
    const x = info.exit;
    assert.equal(v.target, info.vault);
    assert.equal(info.chainId, chain.toString());
    assert.equal(d.value.toString(), info.depositValue);
    assert.equal(d.root, x.root);
    assert.deepEqual(d.leaves, info.leaves);
    assert.deepEqual(d.owners, info.owners);
    assert.equal(sha256(proof), info.proofSha256);
    const relay = await f.vm.provider.getSigner(1);
    const relayerAddress = await relay.getAddress();
    assert.notEqual(relayerAddress, await f.vm.signer.getAddress());
    assert.notEqual(relayerAddress, x.recipient);
    assert.notEqual(relayerAddress, x.feeRecipient);
    const withdrawal = v.connect(relay);
    const viewExit = (p = proof, mod = {}) => withdrawal.withdraw.staticCall(p, { ...x, ...mod }, { gasLimit: GAS });

    await reverts(() => viewExit('0x' + '00'.repeat(32)), 'InvalidStarkProof'); // no digest/attestation path
    await reverts(() => viewExit(proof, { recipient: ZeroAddress }), 'InvalidRecipient');
    await reverts(() => viewExit(proof, { amount: BigInt(x.amount) + 1n }), 'InvalidStarkProof');
    await reverts(() => viewExit(proof, { recipient: OTHER_RECIPIENT === x.recipient ? x.feeRecipient : OTHER_RECIPIENT }),
      'InvalidStarkProof');
    if (symbol === 'ETH') {
      assert.equal(await rebuild(f.hash2, d.leaves), d.root);
      assert.notEqual(await v.commitment(d.value + 1n, d.owners[0]), d.leaves[1]);
      await reverts(() => v.deposit.staticCall(d.owners[0]), 'InvalidAmount');
      await reverts(() => v.deposit.staticCall(d.owners[0], { value: GOLDILOCKS_P - 2n }), 'InvalidAmount');
      await reverts(() => v.deposit.staticCall(badField, { value: 1n }), 'InvalidCommitment');
      await assert.rejects(() => f.vm.provider.call({ to: v.target, data: '0x', value: 1n, from: relayerAddress }));
      await reverts(() => viewExit(proof, { feeRecipient: OTHER_RECIPIENT }), 'InvalidStarkProof');
      await reverts(() => viewExit(proof, { fee: BigInt(x.fee) + 1n }), 'InvalidStarkProof');
      await reverts(() => viewExit(proof, { change: [x.change[0], changedDigest] }), 'InvalidStarkProof');
      await reverts(() => viewExit(proof, { nullifiers: [x.nullifiers[0], changedDigest] }), 'InvalidStarkProof');
      await reverts(() => viewExit(proof, { nullifiers: [x.nullifiers[0], x.nullifiers[0]] }), 'InvalidNullifier');
      await reverts(() => viewExit(proof, { notBefore: BigInt(x.notBefore) - 600n }), 'InvalidStarkProof');
      await reverts(() => viewExit(proof, { notBefore: BigInt(x.notBefore) + 600n }), 'InvalidTime');
      await reverts(() => viewExit(proof.slice(0, -2)), 'InvalidStarkProof');
      // A balance increase that did not perform a deposit cannot increase proof-authorized claims.
      await f.vm.deploy(f.compiler.force, v.target, { value: d.value });
      assert.equal(await v.accountedNative(), 2n * d.value);
      assert.equal(await f.balance(v.target), 3n * d.value);
      await reverts(() => viewExit(proof, { amount: 2n * d.value + 1n }), 'InsufficientBacking');
      // Actual reverted transaction from the relayer: state, nullifiers and payouts all roll back.
      await reverts(() => viewExit(), 'PayoutFailed');
      await assert.rejects(async () => (await withdrawal.withdraw(proof, x, { gasLimit: VAULT_TX_LIMIT })).wait(),
        (err) => err.receipt?.status === 0);
      assert.equal(await f.balance(x.recipient), 0n);
      assert.equal(await f.balance(x.feeRecipient), 0n);
      assert.equal(await v.accountedNative(), 2n * d.value);
      assert.equal(await v.leafCount(), 3n);
      assert.equal(await v.currentRoot(), d.root);
      for (const nf of x.nullifiers) assert.equal(await v.spent(nf), false);
      await (await f.receiver.allowPayment()).wait();

      // Same chain and same funding of the same owners at another vault address is not the same domain.
      const clone = await f.deploy(f.compiler.vaults.ETH, ...f.verifier.args);
      for (const owner of d.owners) await (await clone.deposit(owner, { value: d.value, gasLimit: GAS })).wait();
      const cloneRoot = await clone.currentRoot();
      assert.notEqual(cloneRoot, d.root);
      await reverts(() => clone.withdraw.staticCall(proof, x, { gasLimit: GAS }), 'UnknownRoot');
      await reverts(() => clone.withdraw.staticCall(proof, { ...x, root: cloneRoot }, { gasLimit: GAS }), 'InvalidStarkProof');
    } else {
      // In separate EVM simulations vault addresses can be identical; cross-chain replay still fails.
      const eth = loadVector('ETH');
      assert.equal(v.target, eth.info.vault);
      await reverts(() => withdrawal.withdraw.staticCall(eth.proof, eth.info.exit, { gasLimit: GAS }), 'UnknownRoot');
      await reverts(() => withdrawal.withdraw.staticCall(eth.proof, { ...eth.info.exit, root: d.root }, { gasLimit: GAS }),
        'InvalidStarkProof');
    }
    const before = await f.balance(x.recipient);
    const beforeFee = await f.balance(x.feeRecipient);
    const beforeVault = await f.balance(v.target);
    const tx = await withdrawal.withdraw(proof, x, { gasLimit: VAULT_TX_LIMIT });
    const receipt = await tx.wait();
    assert.equal(receipt.status, 1);
    assert.equal(receipt.from, await relay.getAddress());
    assert.equal(await f.balance(x.recipient) - before, BigInt(x.amount));
    assert.equal(await f.balance(x.feeRecipient) - beforeFee, BigInt(x.fee));
    assert.equal(beforeVault - await f.balance(v.target), BigInt(x.amount) + BigInt(x.fee));
    assert.equal(await v.accountedNative(), d.value - d.fee);
    assert.equal(await v.leafCount(), 5n);
    assert.equal(await v.knownRoot(d.root), true);
    for (const nf of x.nullifiers) assert.equal(await v.spent(nf), true);
    if (f.receiver) {
      assert.equal(await f.receiver.blocked(), true);
      assert.equal(await v.currentRoot(), await rebuild(f.hash2, [...d.leaves, ...x.change]));
    }
    await reverts(() => viewExit(), 'AlreadySpent');
    t.diagnostic(`${symbol}: deploy ${deployment}, deposit ${d.depositGas}, exit ${receipt.gasUsed} gas; ${(tx.data.length - 2) / 2} calldata bytes`);
  });
}
