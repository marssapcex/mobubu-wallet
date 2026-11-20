import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBytes, keccak256 } from 'ethers';
import { compileSolidity } from './compile.mjs';

const root = new URL('../', import.meta.url);
const nonos = 'contracts/vendor/nonos';
const nb = `${nonos}/verifier/nb`;
const prepare = `${nb}/PrepareNb_A.sol`;
const walk = `${nb}/WalkNb_A.sol`;
const chunk = `${nonos}/verifier/shapes/CodeChunk.sol`;
const fixture = 'test/fixtures/VaultRecipients.sol';
const testnetFile = 'contracts/testnet/NativeTestnetVaults.sol';
const testnets = Object.entries({ ETH: 'SepoliaVault', BNB: 'BscTestnetVault', TRX: 'NileVault', HYPE: 'HyperEvmTestnetVault' })
  .map(([asset, name]) => [asset, testnetFile, name]);
const daoDir = 'contracts/dao';
const daoVaults = testnets.map(([symbol, , name]) => [symbol, `${daoDir}/HcmtTestnetVaults.sol`, `${name.slice(0, -5)}FeeVault`]);
const vaults = [
  ['ETH', 'contracts/ethereum/EthereumVault.sol', 'EthereumVault'],
  ['BNB', 'contracts/bsc/BscVault.sol', 'BscVault'],
  ['TRX', 'contracts/tron/TronVault.sol', 'TronVault'],
  ['HYPE', 'contracts/hyperevm/HyperEvmVault.sol', 'HyperEvmVault'],
];

function files(dir) {
  return readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    return e.isDirectory() ? files(path) : path.endsWith('.sol') ? [path] : [];
  }).sort();
}

function pins({ prepare, walk }) {
  const positions = Object.values(walk.immutableReferences).flat().sort((a, b) => a.start - b.start);
  const bytes = getBytes(walk.runtimeTemplate);
  assert.equal(Object.keys(walk.immutableReferences).length, 1);
  assert.equal(positions.length, 2);
  for (const { start, length } of positions) {
    assert.equal(length, 32);
    assert(bytes.subarray(start, start + length).every((b) => b === 0));
  }
  assert.deepEqual(prepare.immutableReferences, {});
  return [keccak256(prepare.runtimeTemplate), keccak256(walk.runtimeTemplate), bytes.length,
    ...positions.map((ref) => ref.start)];
}

export function compileDao(tvm = false) {
  const { artifact } = compileSolidity([...files(nonos), 'contracts/vault/NativeStark.sol',
    ...['HcmtPolicy', 'HcmtPins', 'HcmtToken', 'HcmtTreasury', 'HcmtStakeGate'].map((name) => `${daoDir}/${name}.sol`)],
    { tvm, settings: { metadata: { bytecodeHash: 'none' } } });
  return { token: artifact(`${daoDir}/HcmtToken.sol`, 'HcmtToken'), treasury: artifact(`${daoDir}/HcmtTreasury.sol`, 'HcmtTreasury') };
}

export function compileVaults({ tvm = false, fixtures = false, pinsOnly = false, testnet = false, dao = false } = {}) {
  const entryPoints = (dao ? daoVaults : testnet ? testnets : vaults).filter(([symbol]) => (symbol === 'TRX') === tvm);
  const paths = files(nonos);
  if (!pinsOnly) paths.push('contracts/NativeAssets.sol', ...files('contracts/vault'), ...new Set(entryPoints.map(([, path]) => path)));
  if (dao && !pinsOnly) paths.push(...files(daoDir).filter((path) => !paths.includes(path)));
  if (fixtures) paths.push(fixture);
  const { artifact } = compileSolidity(paths, { tvm, settings: { metadata: { bytecodeHash: 'none' } } });
  const stack = { prepare: artifact(prepare, 'PrepareNb_A'), walk: artifact(walk, 'WalkNb_A') };
  if (pinsOnly) return pins(stack);
  return {
    ...stack,
    chunk: artifact(chunk, 'Chunk'),
    chunks: Array.from({ length: 3 }, (_, i) => `0x${readFileSync(new URL(`${nonos}/chunk${i}.hex`, root), 'utf8').trim()}`),
    ...(testnet || dao ? {
      poseidon: artifact(`${nonos}/PoseidonGoldilocks.sol`, 'PoseidonGoldilocks'),
      evaluator: artifact(`${nb}/NbStraightEvaluatorAt.sol`, 'NbStraightEvaluatorAt'),
    } : {}),
    ...(dao ? {
      token: artifact(`${daoDir}/HcmtToken.sol`, 'HcmtToken'),
      treasury: artifact(`${daoDir}/HcmtTreasury.sol`, 'HcmtTreasury'),
      stakeGate: artifact(`${daoDir}/HcmtStakeGate.sol`, 'HcmtStakeGate'),
    } : {}),
    vaults: Object.fromEntries(entryPoints.map(([symbol, path, name]) => [symbol, { ...artifact(path, name), name }])),
    ...(fixtures ? { reenter: artifact(fixture, 'ReenterNative'), force: artifact(fixture, 'ForceNative') } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const modes = ['--pins', '--testnet', '--dao', '--dao-pins'];
  if (args.filter((arg) => modes.includes(arg)).length > 1 || args.some((arg) => arg !== '--tvm' && !modes.includes(arg)) || new Set(args).size !== args.length) {
    throw new Error('Usage: node scripts/build-vault.mjs [--tvm] [--pins|--testnet|--dao|--dao-pins]');
  }
  const tvm = args.includes('--tvm');
  const testnet = args.includes('--testnet');
  const dao = args.includes('--dao');
  if (args.includes('--dao-pins')) {
    const releases = compileDao(tvm);
    for (const a of Object.values(releases)) assert.deepEqual(a.immutableReferences, {});
    console.log(JSON.stringify(Object.fromEntries(Object.entries(releases).map(([key, a]) => [key, keccak256(a.runtimeTemplate)]))));
  } else if (args.includes('--pins')) {
    console.log(JSON.stringify(compileVaults({ tvm, pinsOnly: true }), null, 2));
  } else {
    const { prepare, walk, chunk, chunks, vaults, poseidon, evaluator, token, treasury, stakeGate } = compileVaults({ tvm, testnet, dao });
    const dir = new URL(`build/${tvm ? 'tvm' : 'evm'}/${dao ? 'dao-vaults' : testnet ? 'testnet-vaults' : 'vaults'}/`, root);
    mkdirSync(dir, { recursive: true });
    const artifacts = { PrepareNb_A: prepare, WalkNb_A: walk, Chunk: chunk,
      EvaluatorChunks: chunks, ...(testnet || dao ? { PoseidonGoldilocks: poseidon, NbStraightEvaluatorAt: evaluator } : {}),
      ...(dao ? { HcmtToken: token, HcmtTreasury: treasury, HcmtStakeGate: stakeGate } : {}),
      ...Object.fromEntries(Object.values(vaults).map((v) => [v.name, v])) };
    for (const [name, artifact] of Object.entries(artifacts)) {
      writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(artifact, null, 2)}\n`);
    }
    console.log(`Built native lab vaults: ${Object.keys(vaults).join(', ')} (${walk.compiler}); no deployment.`);
  }
}
