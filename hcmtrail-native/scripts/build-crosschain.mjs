import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const quorum = `${dir}/ReceiptQuorum.sol`;
const pinFile = new URL(`${dir}/WithdrawalConfigPinData.sol`, root);
const noMetadataHash = { metadata: { bytecodeHash: 'none' } };
const feeds = 'test/fixtures/FeedFixture.sol';
const recipient = 'test/fixtures/DaoRecipients.sol';
const sources = [oracle, 'contracts/NativeAssets.sol', ...paths('contracts/vendor/nonos'), ...paths('contracts/vault'),
  ...paths('contracts/dao'), ...paths(dir)];

export function compileCrosschain({ tvm = false, fixtures = false, pins = false } = {}) {
  const { artifact } = compileSolidity([...sources, ...(fixtures ? [feeds, recipient] : [])],
    { tvm, settings: noMetadataHash });
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

export function renderWithdrawalConfigPins() {
  const targets = [false, true].map((tvm) => compileSolidity([oracle, quorum, `${dir}/WithdrawalTerms.sol`,
    'contracts/NativeAssets.sol', 'contracts/dao/HcmtPolicy.sol', 'contracts/vendor/nonos/libraries/Goldilocks.sol'],
  { tvm, settings: noMetadataHash }));
  const impl = (fn, path, name) => {
    const entries = targets.map(({ artifact }) => {
      const a = artifact(path, name);
      const length = (a.runtimeTemplate.length - 2) / 2;
      const groups = Object.values(a.immutableReferences).map((xs) => xs.toSorted((a, b) => a.start - b.start))
        .sort((a, b) => a[0].start - b[0].start);
      let cursor = 0;
      for (const ref of groups.flat().sort((a, b) => a.start - b.start)) {
        assert.equal(ref.length, 32);
        assert(ref.start >= cursor && ref.start < 65536 && ref.start + ref.length <= length);
        cursor = ref.start + ref.length;
        assert.equal(a.runtimeTemplate.slice(2 + ref.start * 2, 2 + cursor * 2), '0'.repeat(64));
      }
      const layout = groups.map((refs) => {
        assert(refs.length > 0 && refs.length < 256);
        return refs.length.toString(16).padStart(2, '0') + refs.map(({ start }) => start.toString(16).padStart(4, '0')).join('');
      }).join('');
      return `(${length}, bytes32(${keccak256(a.runtimeTemplate)}), hex"${layout}")`;
    });
    return `    function ${fn}(bool tvm) internal pure returns (uint256, bytes32, bytes memory) {
        if (tvm) return ${entries[1]};
        return ${entries[0]};
    }`;
  };
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Generated: node scripts/build-crosschain.mjs --config-pins (with pinned TRON_SOLC).
// solc and tron-solc 0.8.24, Paris, optimizer 200, metadata bytecodeHash none.
library WithdrawalConfigPinData {
${impl('oracle', oracle, 'ChainlinkPriceEpochs')}

${impl('quorum', quorum, 'ReceiptQuorum')}
}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--config-pins', '--check-config-pins'].includes(args[0])) {
    const expected = renderWithdrawalConfigPins();
    if (args[0] === '--config-pins') process.stdout.write(expected);
    else {
      assert.equal(readFileSync(pinFile, 'utf8'), expected, 'Withdrawal config pin table differs from the pinned compilers.');
      console.log('Verified EVM and TVM oracle/quorum runtime pins.');
    }
    process.exit(0);
  }
  if (new Set(args).size !== args.length || args.some((a) => !['--tvm', '--pins'].includes(a))) {
    throw new Error('Usage: npm run build:crosschain -- [--tvm] [--pins] | --config-pins | --check-config-pins');
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
