import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSolidity } from './compile.mjs';

const root = new URL('../', import.meta.url);
const paths = (dir) => readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((entry) => {
  const path = `${dir}/${entry.name}`;
  return entry.isDirectory() ? paths(path) : entry.name.endsWith('.sol') ? [path] : [];
}).sort();
const dir = 'contracts/crosschain';
const names = ['CrosschainNoteVault', 'CrosschainLiquidity', 'SpendGate', 'ReceiptQuorum'];
const oracle = 'contracts/ChainlinkPriceEpochs.sol';
const feeds = 'test/fixtures/FeedFixture.sol';
const recipient = 'test/fixtures/DaoRecipients.sol';
const sources = [oracle, 'contracts/NativeAssets.sol', ...paths('contracts/vendor/nonos'), ...paths('contracts/vault'),
  ...paths('contracts/dao'), ...paths(dir)];

export function compileCrosschain({ tvm = false, fixtures = false, pins = false } = {}) {
  const { artifact } = compileSolidity([...sources, ...(fixtures ? [feeds, recipient] : [])],
    { tvm, settings: { metadata: { bytecodeHash: 'none' } } });
  if (pins) {
    const pins = Object.fromEntries(['PrepareNb_A', 'WalkNb_A', 'NbStraightEvaluatorAt', 'SpendGate'].map((name) => {
      const a = artifact(name === 'SpendGate' ? `${dir}/${name}.sol` : `contracts/vendor/nonos/verifier/nb/${name}.sol`, name);
      const offsets = Object.values(a.immutableReferences).map((xs) => xs.map((x) => {
        assert.equal(x.length, 32);
        assert.equal(a.runtimeTemplate.slice(2 + x.start * 2, 2 + (x.start + 32) * 2), '0'.repeat(64));
        return x.start;
      }));
      return [name, { bytes: (a.runtimeTemplate.length - 2) / 2, hash: keccak256(a.runtimeTemplate), offsets }];
    }));
    return pins;
  }
  return {
    ...Object.fromEntries(names.map((name) => [name, artifact(`${dir}/${name}.sol`, name)])),
    ChainlinkPriceEpochs: artifact(oracle, 'ChainlinkPriceEpochs'),
    ...(fixtures ? { FeedFixture: artifact(feeds, 'FeedFixture'), PayoutSwitch: artifact(recipient, 'PayoutSwitch') } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some((a) => !['--tvm', '--pins'].includes(a))) {
    throw new Error('Usage: npm run build:crosschain -- [--tvm] [--pins]');
  }
  const tvm = args.includes('--tvm');
  if (args.includes('--pins')) {
    console.log(JSON.stringify(compileCrosschain({ tvm, pins: true }), null, 2));
    process.exit(0);
  }
  const output = new URL(`build/${tvm ? 'tvm' : 'evm'}/crosschain/`, root);
  mkdirSync(output, { recursive: true });
  for (const [name, artifact] of Object.entries(compileCrosschain({ tvm }))) {
    writeFileSync(new URL(`${name}.json`, output), `${JSON.stringify(artifact, null, 2)}\n`);
  }
  console.log(`Built ${tvm ? 'TVM' : 'EVM'} cross-chain withdrawal devnet profile; no deployment.`);
}
