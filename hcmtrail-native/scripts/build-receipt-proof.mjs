import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSolidity } from './compile.mjs';

const dir = 'contracts/receipt-proof';
const contract = `${dir}/EvmCheckpointReceiptVerifier.sol`;
const fixture = 'test/fixtures/ReceiptProofFixture.sol';

export function compileReceiptProof({ fixtures = false } = {}) {
  const { artifact } = compileSolidity([contract, ...['ReceiptEvidence', 'ExecutionHeaderChain', 'ExecutionReceiptTrie',
    'SettlementReceipt', 'StrictRlp'].map((n) => `${dir}/${n}.sol`), 'contracts/crosschain/WithdrawalTerms.sol',
  'contracts/NativeAssets.sol', 'contracts/dao/HcmtPolicy.sol', 'contracts/vendor/nonos/libraries/Goldilocks.sol',
  ...(fixtures ? [fixture] : [])], { settings: { metadata: { bytecodeHash: 'none' } } });
  return {
    EvmCheckpointReceiptVerifier: artifact(contract, 'EvmCheckpointReceiptVerifier'),
    ...(fixtures ? { ReceiptProofFixture: artifact(fixture, 'ReceiptProofFixture') } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: npm run build:receipt-proof');
  const out = new URL('../build/evm/receipt-proof/', import.meta.url);
  mkdirSync(out, { recursive: true });
  const a = compileReceiptProof().EvmCheckpointReceiptVerifier;
  writeFileSync(new URL('EvmCheckpointReceiptVerifier.json', out), `${JSON.stringify(a, null, 2)}\n`);
  console.log('Built EVM checkpoint receipt verifier (historical proof experiment; no deployment).');
}
