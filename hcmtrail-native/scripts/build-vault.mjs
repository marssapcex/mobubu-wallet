import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBytes, Interface, keccak256, ZeroAddress, ZeroHash } from 'ethers';
import { compileSolidity } from './compile.mjs';
import { requireEthPoolRelease } from '../pool/release-policy.mjs';

const root = new URL('../', import.meta.url);
const nonos = 'contracts/vendor/nonos';
const nb = `${nonos}/verifier/nb`;
const poolPath = 'contracts/ethereum/EthShieldedPool.sol';
const stakingPath = 'contracts/ethereum/EthFeeStaking.sol';
const hcmtPath = 'contracts/ethereum/HcmtToken.sol';
const poolFixture = 'test/fixtures/EthPoolFixture.sol';
const labTokenPath = 'test/fixtures/LabStakeToken.sol';
const labMessages = 'test/fixtures/LocalMessageTransport.sol';

function files(dir) {
  return readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    return e.isDirectory() ? files(path) : e.name.endsWith('.sol') ? [path] : [];
  }).sort();
}

function enforceSize(a, args) {
  a.initWithArgsBytes = getBytes(a.bytecode).length + getBytes(new Interface(a.abi).encodeDeploy(args)).length;
  assert(a.initWithArgsBytes <= 49_152, 'ETH pool exceeds the EIP-3860 initcode limit');
  assert(getBytes(a.runtimeTemplate).length <= 24_576, 'ETH pool exceeds the EIP-170 runtime limit');
}

export function compileVaults({ fixtures = false, labToken = false } = {}) {
  const paths = [...files(nonos), 'contracts/vault/NativeStark.sol', 'contracts/vault/NativeNoteTree.sol',
    'contracts/vault/NativeNoteDeposits.sol', stakingPath, hcmtPath, poolPath, 'contracts/ethereum/EthPoolState.sol',
    'contracts/ethereum/EthNetworkState.sol', 'contracts/ethereum/RollupMessageTransport.sol'];
  if (fixtures) paths.push(poolFixture);
  if (labToken || fixtures) paths.push(labTokenPath, labMessages);
  const { artifact } = compileSolidity(paths, { settings: { metadata: { bytecodeHash: 'none' } } });
  const pool = artifact(poolPath, 'EthShieldedPool');
  const staking = artifact(stakingPath, 'EthFeeStaking');
  const hcmt = artifact(hcmtPath, 'HcmtToken');
  enforceSize(pool, [31337, ...Array(5).fill(ZeroAddress), [ZeroHash, Array(3).fill(ZeroAddress), Array(4).fill(ZeroAddress)]]);
  enforceSize(staking, [ZeroAddress]);
  enforceSize(hcmt, [ZeroAddress]);
  return {
    pool, staking, hcmt,
    prepare: artifact(`${nb}/PrepareNb_A.sol`, 'PrepareNb_A'),
    walk: artifact(`${nb}/WalkNb_A.sol`, 'WalkNb_A'),
    evaluator: artifact(`${nb}/NbStraightEvaluatorAt.sol`, 'NbStraightEvaluatorAt'),
    chunk: artifact(`${nonos}/verifier/shapes/CodeChunk.sol`, 'Chunk'),
    chunks: Array.from({ length: 3 }, (_, i) => `0x${readFileSync(new URL(`${nonos}/chunk${i}.hex`, root), 'utf8').trim()}`),
    poseidon: artifact(`${nonos}/PoseidonGoldilocks.sol`, 'PoseidonGoldilocks'),
    ...((labToken || fixtures) && {
      labToken: artifact(labTokenPath, 'LabStakeToken'),
      labMessenger: artifact(labMessages, 'LocalMessageTransport'),
      labBridge: artifact(labMessages, 'LocalArbMessageBridge'),
      labOutbox: artifact(labMessages, 'LocalArbMessageOutbox'),
    }),
    ...(fixtures && {
      poolHarness: artifact(poolFixture, 'EthPoolHarness'), networkHarness: artifact(poolFixture, 'EthNetworkHarness'), reject: artifact(poolFixture, 'RejectEth'),
      taxedToken: artifact(labTokenPath, 'LabTaxedToken'),
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, extra] = process.argv.slice(2);
  const lab = '--pool-legacy-devnet';
  if (!extra && [undefined, '--pool', '--pool-256'].includes(mode)) requireEthPoolRelease();
  if (extra || ![lab, '--pins'].includes(mode)) {
    throw new Error('Usage: node scripts/build-vault.mjs [--pool-legacy-devnet | --pins] (test ETH only).');
  }
  const { prepare, walk, evaluator, chunk, chunks, poseidon, pool, staking, hcmt } = compileVaults();
  if (mode === '--pins') {
    console.log(JSON.stringify(Object.fromEntries(Object.entries({ prepare, walk, evaluator, poseidon }).map(([key, a]) =>
      [key, { hash: keccak256(a.runtimeTemplate), bytes: getBytes(a.runtimeTemplate).length, immutables: a.immutableReferences }])), null, 2));
  } else {
    const dir = new URL('build/eth-pool/', root);
    mkdirSync(dir, { recursive: true });
    const a = { PrepareNb_A: prepare, WalkNb_A: walk, NbStraightEvaluatorAt: evaluator, Chunk: chunk,
      EvaluatorChunks: chunks, PoseidonGoldilocks: poseidon, EthShieldedPool: pool, EthFeeStaking: staking, HcmtToken: hcmt };
    for (const [name, artifact] of Object.entries(a)) {
      writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify(artifact, null, 2)}\n`);
    }
    console.log(`Built ETH pool + staking for local lab only: ${pool.initWithArgsBytes} B pool initcode+args, ` +
      `${getBytes(pool.runtimeTemplate).length} B pool runtime, ${getBytes(staking.runtimeTemplate).length} B staking runtime. No deployment.`);
  }
}
