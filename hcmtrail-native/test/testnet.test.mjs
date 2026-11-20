import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes, hexlify, id, toBeHex, ZeroHash } from 'ethers';
import { TronWeb } from 'tronweb';
import { artifacts, assertRuntime, createSpec, deploy, verifyDeployment } from '../testnet/deployment.mjs';
import { deploymentDomain, hash2, limbs4, openNote, pack, rebuildRoot } from '../testnet/notes.mjs';
import { TESTNETS, GOLDILOCKS } from '../testnet/networks.mjs';
import { parseResult, proofShape } from '../testnet/prover.mjs';
import { address, EvmChain, httpRpc, txId } from '../testnet/rpc.mjs';
import { loadSignerKey, outsideSource, Store } from '../testnet/store.mjs';
import { TestnetWallet } from '../testnet/wallet.mjs';
import { localTvm } from './local-tvm.mjs';
import { DEMO_KEY, DEMO_RECIPIENT, DEMO_SENDER, evmFixture, walletFixture } from './testnet-fixture.mjs';
import { loadVector, stack } from './vault-fixture.mjs';

process.umask(0o077);
const selector = (s) => id(`${s}()`).slice(0, 10);
const reverted = (s) => (e) => e.data?.startsWith?.(selector(s)) || e.revert === selector(s);

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'hcmtrail-testnet-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new Store(root);
}

test('private storage: atomic 0600 notes, signer permission and symlink refusal, exclusive state', async (t) => {
  const store = scratch(t);
  store.write('note.json', { value: GOLDILOCKS - 1n });
  assert.equal(statSync(store.path('note.json')).mode & 0o777, 0o600);
  assert.equal(store.read('note.json').value, String(GOLDILOCKS - 1n));
  assert.throws(() => outsideSource(new URL('../README.md', import.meta.url).pathname), /outside/);
  const key = store.path('key');
  writeFileSync(key, DEMO_KEY, { mode: 0o600 });
  assert.equal(loadSignerKey(key), DEMO_KEY);
  chmodSync(key, 0o644);
  assert.throws(() => loadSignerKey(key), /owner-only/);
  symlinkSync(key, store.path('symlink'));
  assert.throws(() => loadSignerKey(store.path('symlink')), /symlink/);
  await store.locked(async () => assert.rejects(store.locked(() => {}), /locked/));
  await store.locked(() => {});
});

test('lossless Rust u64 parsing, canonical limbs, Poseidon cross-reference and address encodings', () => {
  const n = openNote(TESTNETS.ETH, 10_000_000_000_000_000n, [1617n, 1618n, 1619n, 1620n], [16n, 17n, 18n, 19n]);
  const v = loadVector('ETH');
  assert.equal(n.spendPk, pack([450798068082345897n, 4125708543947226853n, 7270994719425760054n, 3312676251090596708n]));
  assert.equal(n.ownerCommit, v.info.owners[0]);
  assert.equal(n.leaf, v.info.leaves[1]);
  assert.equal(rebuildRoot(v.info.leaves), v.info.exit.root);
  assert.equal(parseResult(`{"n":${GOLDILOCKS - 1n}}`).n, GOLDILOCKS - 1n);
  assert.throws(() => parseResult('{"n":18446744073709551616}'), /out of range/);
  assert.throws(() => parseResult('{"n":1e12}'), /u64 decimal/);
  assert.throws(() => limbs4([GOLDILOCKS, 0n, 0n, 0n]), /out of range/);
  assert.equal(hash2(ZeroHash, ZeroHash), '0x4bbbda1ac693e3d65a430037146e172f26df37317f569e223cda43bb24edcd9c');
  assert.equal(address(TESTNETS.TRX, TronWeb.address.fromHex(DEMO_RECIPIENT)), DEMO_RECIPIENT);
  assert.equal(address(TESTNETS.TRX, `41${DEMO_RECIPIENT.slice(2)}`), DEMO_RECIPIENT);
  assert.equal(txId(ZeroHash.slice(2)), ZeroHash);
  assert(proofShape(v.proof));
  assert(!proofShape('0x00'));
  assert(!proofShape(v.proof + '00'.repeat(128_000)));
});

test('HTTPS transport keeps Nile RPC and wallet methods on one host and refuses bad IDs', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push([url, body, options]);
    const response = body.method === 'eth_chainId' ? { id: body.id, result: '0xcd8690dc' }
      : { id: 0, result: 'an incorrect response id' };
    return Response.json(response);
  });
  const { rpc, native } = httpRpc('https://example.invalid/nile/', { tron: true });
  assert.equal(await rpc('eth_chainId'), '0xcd8690dc');
  await native('walletsolidity/getnowblock', {});
  await assert.rejects(rpc('eth_getLogs'), /eth_getLogs refused/);
  assert.deepEqual(calls.map(([url]) => url), ['https://example.invalid/nile/jsonrpc',
    'https://example.invalid/nile/walletsolidity/getnowblock', 'https://example.invalid/nile/jsonrpc']);
  assert(calls.every(([, , options]) => options.redirect === 'error'));
  assert.throws(() => httpRpc('http://example.invalid'), /HTTPS/);
  assert.throws(() => httpRpc('https://example.invalid/jsonrpc', { tron: true }), /base URL/);
});

test('foreign RPC/overpriced EVM gas are refused before preparing a signed transaction', async () => {
  const methods = [];
  const chain = new EvmChain(TESTNETS.ETH, (method) => { methods.push(method); return '0x1'; }, { key: DEMO_KEY, gasPriceCap: 1n });
  await assert.rejects(chain.prepare({ data: '0x' }), /chain ID mismatch/);
  assert.deepEqual(methods, ['eth_chainId']);
  const evm = await evmFixture('ETH');
  try {
    evm.chain.gasPriceCap = 1n;
    await assert.rejects(evm.chain.prepare({ data: '0x' }), /gas price/);
  } finally { evm.close(); }
});

for (const asset of ['ETH', 'BNB', 'HYPE', 'TRX']) test(`${asset} deploys correct testnet bytecode, journals a deposit, recovers by receipt and checks tree`, async (t) => {
  const f = await walletFixture(asset);
  t.after(() => f.close());
  const { wallet, chain, store, manifest: m, a, txs } = f;
  assert.equal(m.chainId, String(TESTNETS[asset].chainId));
  assert.deepEqual(deploymentDomain(chain.network, m.vault), { domain: m.domain, domainLeaf: m.domainLeaf });
  assert.equal((await deploy(chain, store, txs, a)).vault, m.vault);
  await assert.rejects(() => verifyDeployment(chain, { ...m, domain: ZeroHash }, a), /domain mismatch/);
  assert.throws(() => new TestnetWallet(chain, store, txs, { ...m, domain: ZeroHash }, a.vaults[asset].abi).checkContext(m), /another deployment/);
  const edited = getBytes(await chain.code(m.vault)); edited[0] ^= 1;
  assert.throws(() => assertRuntime(hexlify(edited), a.vaults[asset], asset), /runtime bytecode/);
  const amount = asset === 'TRX' ? 123_456n : 12_345_678_901_234_567n;
  const n = wallet.newNote(amount);
  await assert.rejects(wallet.recoverNote(n.note), /not confirmed/);
  if (asset === 'HYPE') {
    f.status.bigBlocks = false;
    await assert.rejects(wallet.deposit(n.note), /usingBigBlocks/);
    assert(!txs.existing(`deposit-${n.note}`));
    f.status.bigBlocks = true;
  }
  if (asset === 'TRX') {
    f.flags.foreignTapos = true;
    await assert.rejects(wallet.deposit(n.note), /block headers disagree/);
    f.flags.foreignTapos = false;
    chain.feeLimit = 1n;
    await assert.rejects(wallet.deposit(n.note), /Estimated Energy/);
    chain.feeLimit = 7_500_000_000n;
    assert(!txs.existing(`deposit-${n.note}`));
  }
  const broadcast = chain.broadcast.bind(chain);
  let publishes = 0;
  chain.broadcast = async (e) => {
    publishes++;
    assert(txs.existing(`deposit-${n.note}`)); // Signed ID/durable opening exist before send.
    assert(store.has(`note-${n.note}.json`));
    await broadcast(e);
    throw new Error('Fixture injects a lost response after accepting the signed tx');
  };
  const funded = await wallet.deposit(n.note);
  assert.equal(funded.index, 1n);
  assert.equal(await wallet.ledger.read('accountedNative'), amount);
  assert.equal(await chain.balance(m.vault), amount);
  assert.equal(await wallet.ledger.read('leafCount'), 2n);
  assert.equal((await wallet.deposit(n.note)).receipt.hash, funded.receipt.hash);
  assert.equal(publishes, 1);
  // Recover using ONLY saved note + manifest (no funding record or signed transaction).
  rmSync(store.path(`fund-${n.note}.json`));
  rmSync(store.path(`tx-deposit-${n.note}.json`));
  assert.equal((await wallet.recoverNote(n.note)).receipt.hash, funded.receipt.hash);
  await assert.rejects(() => wallet.recoverNote(n.note, m.created.tx), /matching vault deposit/);
  const safe = await wallet.ledger.snapshot();
  assert.deepEqual(safe.leaves, [m.domainLeaf, n.note]);
  const getLogs = chain.logs.bind(chain);
  chain.logs = async (...args) => (await getLogs(...args)).filter((l) => l.topics[2] !== n.note);
  await assert.rejects(() => wallet.ledger.snapshot(), /Incomplete|Missing/);
  chain.logs = getLogs;
  const old = loadVector(asset);
  await assert.rejects(chain.call(wallet.ledger.spec('withdraw', [old.proof, old.info.exit])), reverted('UnknownRoot'));
  if (asset === 'TRX') {
    f.flags.holdSolid = true;
    assert.equal(await chain.receipt(funded.receipt.hash), null);
    await assert.rejects(wallet.recoverNote(n.note), /confirmed receipt/);
    f.flags.holdSolid = false;
  }
});

test('new contract wrappers reject good stacks on the wrong chain, including Nile on TRON mainnet ID', async () => {
  const f = await walletFixture('ETH');
  try {
    const { prepare, walk, chunks } = f.manifest.stack;
    const wrong = createSpec(f.a.vaults.BNB, 'BscTestnetVault', [prepare, walk, chunks]);
    await assert.rejects(f.chain.prepare(wrong), reverted('WrongChain'));
    const foreign = await evmFixture('BNB');
    try {
      const { a } = f;
      const s = await stack(foreign.vm.deploy, a);
      await assert.rejects(() => foreign.chain.prepare(createSpec(a.vaults.ETH, 'SepoliaVault', s.args)), reverted('WrongChain'));
      await assert.rejects(() => foreign.chain.prepare(createSpec(a.vaults.HYPE, 'HyperEvmTestnetVault', s.args)), reverted('WrongChain'));
    } finally { foreign.close(); }
  } finally { f.close(); }
  const a = artifacts(TESTNETS.TRX);
  const tvm = await localTvm(); // Older fixture uses TRON mainnet ID.
  const s = await stack(tvm.deploy, a);
  const r = await tvm.deployRaw(a.vaults.TRX, s.args);
  assert.equal(hexlify(r.execResult.returnValue).slice(0, 10), selector('WrongChain'));
});
