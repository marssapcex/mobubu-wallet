import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { getBytes, keccak256, sha256 } from 'ethers';
import { openLocalEvm } from './support/local-evm.mjs';
import { compileContracts } from '../scripts/compile-contracts.mjs';
import { createNote, evmDomain, formatAmount, merkleRoot, noteLeaf, parseAmount, readNote, ZERO } from '../packages/pool/src/notes.mjs';
import { exitMessage, journalBytes, prepareLocalExit, verifyExitSignature } from '../packages/pool/src/spend.mjs';
import { openEvmPool } from '../packages/pool/src/evm.mjs';
import { exactOutput } from '../packages/pool/src/withdrawal-quote.mjs';

const path = 'contracts/ShieldedNativePoolDevnet.sol';
const fixture = 'RejectUnproven.sol';
const fixedHash = '0x' + '85'.repeat(32);
let compiled;
const chains = [];
before(() => {
  compiled = compileContracts({ [fixture]: `pragma solidity 0.8.24; contract RejectUnproven {
    function verify(bytes32,bytes32,bytes calldata) external pure returns (bool) { return false; }
  }` });
});
after(() => chains.forEach(({ close }) => close()));

async function deploy(id) {
  const chain = await openLocalEvm(id);
  chains.push(chain);
  const rejector = await chain.deploy(compiled[fixture].RejectUnproven);
  const codeHash = keccak256(await chain.provider.getCode(rejector.target));
  return { ...chain, codeHash, rejector,
    pool: async (hash = codeHash) => chain.deploy(compiled[path].ShieldedNativePoolDevnet, rejector.target, hash, fixedHash) };
}

function assertRevert(contract, expected) {
  const selector = contract.interface.getError(expected).selector;
  return (err) => err?.data?.slice(0, 10) === selector || err?.revert?.name === expected;
}

function runRelation(exit, expected, mutate) {
  if (!process.env.POOL_RELATION_CHECKER) return;
  const statement = Buffer.concat([getBytes(exit.journal), getBytes(exit.witness)]);
  if (mutate) mutate(statement);
  const result = spawnSync(process.env.POOL_RELATION_CHECKER, { input: statement, timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stderr.toString());
}

test('three native assets accept exact decimals without float conversion or fixed denominations', () => {
  assert.equal(parseAmount('100.000000000000000001', 'ETH'), 100_000_000_000_000_000_001n);
  assert.equal(parseAmount('0.000000000000000001', 'BNB'), 1n);
  assert.equal(parseAmount('0.00000001', 'BTC'), 1n);
  assert.equal(formatAmount(parseAmount('3.51246201', 'BTC'), 'BTC'), '3.51246201');
  assert.equal(exactOutput({ from: 'ETH', to: 'BNB', rate: { numerator: 3n, denominator: 2n } }, 3n), 4n);
  assert.throws(() => exactOutput({ from: 'ETH', to: 'BTC', rate: { numerator: 1n, denominator: 1n } }, 999n), /dust floor/);
  for (const [value, name] of [['0','ETH'], ['1e5','ETH'], ['1.000000000','BTC'], ['1','ETH@base'], ['1','WBNB'], ['1','BNB@ethereum']]) {
    assert.throws(() => parseAmount(value, name));
  }
});

for (const [asset, chainId, amount] of [['ETH', 31_337n, '100.000000000000000001'], ['BNB', 31_338n, '0.000000000000000001']]) {
  test(`${asset}: native local deposit makes a note from msg.value, with no quote or exit key`, async () => {
    const chain = await deploy(chainId), pool = await chain.pool();
    const domain = await evmDomain(chainId, pool.target);
    assert.equal(await pool.domain(), domain);
    const units = parseAmount(amount, asset);
    const rpc = chain.provider.send.bind(chain.provider);
    const config = { asset, rpc, vault: pool.target, deploymentBlock: (await pool.deploymentTransaction().wait()).blockNumber,
      genesis: (await chain.provider.getBlock(0)).hash, codeHash: keccak256(await chain.provider.getCode(pool.target)) };
    const sdk = await openEvmPool(config);
    const { note, transaction } = await sdk.draft(units);
    assert.equal(note.domain, domain);
    const signer = await chain.provider.getSigner(0);
    const tx = await (await signer.sendTransaction(transaction)).wait();
    const deposit = tx.logs.map((log) => pool.interface.parseLog(log)).find((log) => log?.name === 'Deposited');
    assert.equal(tx.status, 1);
    assert.deepEqual([...deposit.args], [0n, note.leaf, units]);
    assert.equal(await pool.escrowed(), units);
    assert.equal(await chain.provider.getBalance(pool.target), units);
    const other = await sdk.draft(41n);
    await (await signer.sendTransaction(other.transaction)).wait();
    const snapshot = await sdk.snapshot(), anchor = await snapshot.anchor(note);
    const root = await pool.root();
    assert.equal(anchor.count, 2);
    assert.equal(anchor.siblings[0], other.note.leaf);
    assert.equal(await merkleRoot(note.leaf, anchor.index, anchor.siblings, anchor.count), root);
    await assert.rejects(snapshot.anchor(await createNote({ asset, domain, value: units })), /no finalized deposit/);
    await assert.rejects((await openEvmPool({ ...config, rpc: async (method, params) => method === 'eth_getLogs' ? [] : rpc(method, params) })).snapshot(), /finalized root/);
    await assert.rejects((await openEvmPool({ ...config, genesis: fixedHash })).draft(units), /genesis/);
    await assert.rejects(pool.deposit.staticCall(note.key, { value: units }), assertRevert(pool, 'InvalidNote'));
    await assert.rejects(pool.deposit.staticCall(note.key, { value: 0 }), assertRevert(pool, 'InvalidNote'));
    await assert.rejects(readNote({ ...note, value: String(units + 1n) }), /does not match/);
    assert.notEqual(await noteLeaf(domain, note.key, units + 1n), note.leaf);

    const head = await chain.provider.getBlock('latest');
    const submitter = (await chain.provider.getSigner(0)).address, recipient = (await chain.provider.getSigner(2)).address;
    const opts = { note, anchor, recipient, submitter, deadline: head.timestamp + 600, now: head.timestamp };
    await assert.rejects(prepareLocalExit({ ...opts, debit: units + 1n }), /exceeds this note/);
    const exit = await prepareLocalExit({ ...opts, debit: 1n });
    assert.equal(exit.changeNote?.value ?? null, units > 1n ? String(units - 1n) : null);
    assert.equal(exit.terms.quote, ZERO);
    assert.notEqual(exit.terms.key, note.key);
    assert.equal(await pool.exitMessage(exit.terms), exitMessage(domain, exit.terms));
    assert.equal(await pool.journalHash(exit.terms), sha256(journalBytes(domain, exit.terms)));
    assert.equal(verifyExitSignature(domain, exit.terms, exit.signature), true);
    assert.equal(verifyExitSignature(domain, { ...exit.terms, amountOut: 2n }, exit.signature), false);
    const second = await prepareLocalExit({ ...opts, debit: 1n, recipient: (await chain.provider.getSigner(3)).address });
    assert.equal(second.terms.nullifier, exit.terms.nullifier);
    assert.notEqual(second.terms.key, exit.terms.key);
    assert.notEqual(second.journal, exit.journal);

    // No verifier that accepts a dummy proof is ever attached. SLH-DSA alone cannot release a note.
    await assert.rejects(pool.withdraw.staticCall(exit.terms, recipient, exit.signature, '0x01'), assertRevert(pool, 'InvalidProof'));
    await assert.rejects(pool.withdraw.staticCall({ ...exit.terms, count: 3 }, recipient, exit.signature, '0x01'), assertRevert(pool, 'InvalidExit'));
    await assert.rejects(pool.withdraw.staticCall(exit.terms, recipient, '0x', '0x01'), assertRevert(pool, 'InvalidSignature'));
    assert.equal(await pool.spent(exit.terms.nullifier), false);
    assert.equal(await pool.escrowed(), units + 41n);
    assert.equal(await pool.root(), root);
    runRelation(exit, 0);
    runRelation(exit, 1, (v) => v[32] ^= 1); // Root.
    runRelation(exit, 1, (v) => v[96] ^= 1); // Nullifier.
    runRelation(exit, 1, (v) => v[145] = 255); // Debit range.
    runRelation(exit, 1, (v) => v[160] ^= 1); // Change commitment.
    runRelation(exit, 1, (v) => v[224 + 51] = 2); // Index outside count.
    runRelation(exit, 1, (v) => v[224 + 52] ^= 1); // First sibling.
  });
}

test('vault refuses an unpinned verifier and cannot deploy on Ethereum mainnet or BNB Smart Chain', async () => {
  const local = await deploy(31_337n);
  await assert.rejects(local.pool(fixedHash));
  for (const id of [1n, 56n]) {
    const other = await deploy(id);
    await assert.rejects(other.pool());
  }
});
