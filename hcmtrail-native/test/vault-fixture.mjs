import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Contract, getAddress, hexlify, toBeHex } from 'ethers';
import { localEvm } from './local-evm.mjs';
import { TRON_ID, localTvm, ensureSuccess } from './local-tvm.mjs';
import { compileVaults } from '../scripts/build-vault.mjs';

export const ASSETS = Object.freeze({ ETH: 1n, BNB: 56n, TRX: TRON_ID, HYPE: 999n });
export const VAULT_TX_LIMIT = 1n << 24n;
export const NOT_BEFORE = 1_794_999_600n;
export const FEE_RECIPIENT = getAddress('0x' + 'aa'.repeat(20));
export const OTHER_RECIPIENT = getAddress('0x' + 'bb'.repeat(20));
const POSEIDON = ['function hash2(bytes32 left, bytes32 right) pure returns (bytes32)'];
const compiled = new Map();

export function artifacts(tvm) {
  if (!compiled.has(tvm)) compiled.set(tvm, compileVaults({ tvm, fixtures: true }));
  return compiled.get(tvm);
}

function words(xs, bits = 64n) {
  return xs.reduce((packed, x, i) => packed | (x << (bits * BigInt(i))), 0n);
}
const digest = (xs) => toBeHex(words(xs), 32);

export async function stack(deploy, compiler) {
  const prepare = await deploy(compiler.prepare);
  const walk = await deploy(compiler.walk, prepare.target);
  const chunks = [];
  for (const code of compiler.chunks) chunks.push((await deploy(compiler.chunk, code)).target);
  return { prepare, walk, chunks, args: [prepare.target, walk.target, chunks] };
}

export async function deployVault(symbol, chainId = ASSETS[symbol]) {
  const tvm = symbol === 'TRX';
  const compiler = artifacts(tvm);
  assert(compiler.vaults[symbol], `Unknown asset ${symbol}`);
  const vm = tvm ? await localTvm({ chainId }) : await localEvm(chainId);
  const deploy = tvm ? vm.deploy : (art, ...args) => vm.deploy(art, ...args, { gasLimit: VAULT_TX_LIMIT });
  try {
    const verifier = await stack(deploy, compiler);
    const vault = await deploy(compiler.vaults[symbol], ...verifier.args);
    const view = tvm ? vault.view : (method, args = []) => vault[method](...args);
    const poseidonAddress = await view('poseidon');
    const poseidon = tvm ? vm.attach(POSEIDON, poseidonAddress) : new Contract(poseidonAddress, POSEIDON, vm.signer);
    const hash2 = tvm ? (...pair) => poseidon.view('hash2', pair) : (...pair) => poseidon.hash2(...pair);
    const receiver = symbol === 'ETH' ? await deploy(compiler.reenter, vault.target) : null;
    const balance = tvm ? vm.balance : (at) => vm.provider.getBalance(at);
    return { tvm, compiler, vm, deploy, verifier, vault, view, hash2, receiver, balance, close: () => vm.close?.() };
  } catch (error) { vm.close?.(); throw error; }
}

export async function depositFixture(f, symbol) {
  const assetId = BigInt(Object.keys(ASSETS).indexOf(symbol));
  const value = symbol === 'TRX' ? 10_000_000n : 10_000_000_000_000_000n;
  const fee = value / 1_000n;
  const recipient = f.receiver?.target ?? OTHER_RECIPIENT;
  // Deliberately public local fixture from the NON-OS wallet vector. Never use these notes with real money.
  const sk = [1617n, 1618n, 1619n, 1620n];
  const pk = [450798068082345897n, 4125708543947226853n, 7270994719425760054n, 3312676251090596708n];
  const blind = [[16n, 17n, 18n, 19n], [17n, 18n, 19n, 20n]];
  const owners = [];
  const leaves = [await f.view('domainLeaf')];
  let depositGas;
  for (const b of blind) {
    const owner = await f.hash2(digest(pk), digest(b));
    const leaf = await f.view('commitment', [value, owner]);
    owners.push(owner);
    leaves.push(leaf);
    if (f.tvm) {
      const receipt = ensureSuccess(await f.vault.send('deposit', [owner], { value }));
      const [, topics, data] = receipt.logs.at(-1);
      const event = f.vault.iface.parseLog({ topics: topics.map((topic) => hexlify(topic)), data: hexlify(data) });
      assert.equal(event.name, 'Deposited');
      assert.deepEqual(event.args.toArray(), [BigInt(leaves.length - 1), leaf, value]);
      depositGas = receipt.executionGasUsed;
    } else {
      const receipt = await (await f.vault.deposit(owner, { value, gasLimit: VAULT_TX_LIMIT })).wait();
      const event = f.vault.interface.parseLog(receipt.logs.at(-1));
      assert.equal(event.name, 'Deposited');
      assert.deepEqual(event.args.toArray(), [BigInt(leaves.length - 1), leaf, value]);
      depositGas = receipt.gasUsed;
    }
  }
  assert.equal(await f.view('leafCount'), 3n);
  assert.equal(await f.view('accountedNative'), 2n * value);
  const root = await f.view('currentRoot');
  assert.equal(await f.view('knownRoot', [root]), true);
  return { root, leaves, owners, value, fee, depositGas,
    request: { asset_id: assetId, unit: value, note_root: root, assoc_root: root, pool_leaves: leaves, assoc_leaves: leaves,
      input_pool_index: [1, 2], input_assoc_index: [1, 2], recipient, fee_recipient: FEE_RECIPIENT, clearing_price: 0,
      not_before: NOT_BEFORE, public_amount: value, fee, output_values: [value - fee, 0] },
    seed: { secrets: [sk, sk], notes: blind.map((b) => ({ value, asset_id: assetId, spend_pk: pk, blinding: b })) },
  };
}

export function exitFromLimbs(limbs, req) {
  assert.equal(limbs.length, 37);
  const at = (i) => digest(limbs.slice(i, i + 4));
  const address = (i) => getAddress(toBeHex(words(limbs.slice(i, i + 4), 48n), 20));
  assert.equal(at(0), req.note_root);
  assert.equal(at(4), req.assoc_root);
  assert.deepEqual(limbs.slice(24, 28), [req.public_amount, req.fee, req.asset_id, 0n]);
  assert.equal(limbs[36], req.not_before);
  assert.equal(address(28), req.recipient);
  assert.equal(address(32), req.fee_recipient);
  return { root: at(0), nullifiers: [at(8), at(12)], change: [at(16), at(20)], recipient: address(28),
    feeRecipient: address(32), amount: limbs[24], fee: limbs[25], notBefore: limbs[36] };
}

export function loadVector(symbol) {
  const dir = new URL(`./vectors/${symbol}/`, import.meta.url);
  return { proof: hexlify(readFileSync(new URL('proof.bin', dir))),
    info: JSON.parse(readFileSync(new URL('public.json', dir), 'utf8')) };
}
