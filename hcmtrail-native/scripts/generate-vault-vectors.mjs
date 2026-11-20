// Make PUBLIC, emulator-only note/proof fixtures. Never pass a private wallet seed to this script.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hexlify, sha256 } from 'ethers';
import { ensureSuccess, TVM_RELAYER } from '../test/local-tvm.mjs';
import { ASSETS, depositFixture, deployVault, exitFromLimbs, VAULT_TX_LIMIT } from '../test/vault-fixture.mjs';

const [dir, ...symbols] = process.argv.slice(2);
const prover = process.env.NATIVE_STARK_PROVER_DIR;
if (!dir || !prover || !symbols.length || symbols.some((s) => !Object.hasOwn(ASSETS, s))) {
  throw new Error('Usage: NATIVE_STARK_PROVER_DIR=/path/to/release node scripts/generate-vault-vectors.mjs OUTDIR ETH [BNB TRX HYPE]');
}
const work = mkdtempSync(join(tmpdir(), 'hcmtrail-vault-vectors-'));
const cache = resolve(process.env.NATIVE_PERIODIC_CACHE ?? join(work, 'periodic.top'));
const encode = (obj) => JSON.stringify(obj, (_, n) => typeof n === 'bigint' ? JSON.rawJSON(n.toString()) : n);
const publicJson = (obj) => `${JSON.stringify(obj, (_, n) => typeof n === 'bigint' ? n.toString() : n, 2)}\n`;
const run = (binary, args) => execFileSync(resolve(prover, binary), args, {
  cwd: work, env: { ...process.env, NOX_CACHE: cache, NOX_ENTROPY: '/dev/urandom' }, stdio: 'inherit', timeout: 30 * 60_000,
});

try {
  for (const symbol of symbols) {
    const f = await deployVault(symbol);
    try {
      const d = await depositFixture(f, symbol);
      console.log(`${symbol}: funded ${d.root}; proving the two deposits of ${d.value} base units...`);
      const reqPath = join(work, 'request.json');
      const seedPath = join(work, 'seed.json');
      const jsonPath = join(work, 'result.json');
      const binPath = join(work, 'proof.bin');
      writeFileSync(reqPath, encode(d.request));
      writeFileSync(seedPath, encode(d.seed));
      run('nox_bench', [reqPath, seedPath, jsonPath]);
      run('nox_share', [jsonPath, cache, binPath]);
      // The prover emits JSON u64 numbers; do not round Goldilocks limbs through JS Number.
      const text = readFileSync(jsonPath, 'utf8');
      const publicWords = text.match(/"publics"\s*:\s*\[([\d,\s]+)\]/)?.[1];
      assert(publicWords, 'Expected decimal u64 public words from the prover');
      const exit = exitFromLimbs(publicWords.split(',').map((word) => BigInt(word.trim())), d.request);
      const bytes = readFileSync(binPath);
      const proof = hexlify(bytes);
      if (f.receiver) await (await f.receiver.allowPayment()).wait();
      const before = await f.balance(exit.recipient);
      const beforeFee = await f.balance(exit.feeRecipient);
      let payoutGas;
      if (f.tvm) {
        payoutGas = ensureSuccess(await f.vault.send('withdraw', [proof, exit], { from: TVM_RELAYER })).executionGasUsed;
      } else {
        const submitter = await f.vm.provider.getSigner(1);
        payoutGas = (await (await f.vault.connect(submitter).withdraw(proof, exit, { gasLimit: VAULT_TX_LIMIT })).wait()).gasUsed;
      }
      assert.equal(await f.balance(exit.recipient) - before, exit.amount);
      assert.equal(await f.balance(exit.feeRecipient) - beforeFee, exit.fee);
      assert.equal(await f.view('accountedNative'), d.value - d.fee);
      for (const nf of exit.nullifiers) assert.equal(await f.view('spent', [nf]), true);
      const path = join(dir, symbol);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'proof.bin'), bytes);
      writeFileSync(join(path, 'public.json'), publicJson({ vault: f.vault.target, proofSha256: sha256(proof), exit,
        chainId: ASSETS[symbol], owners: d.owners, leaves: d.leaves, depositValue: d.value,
      }));
      console.log(`${symbol} OK: ${bytes.length} proof bytes, ${d.depositGas} deposit, ${payoutGas} withdrawal (${f.tvm ? 'TVM execution units' : 'EVM gas'}).`);
    } finally { f.close(); }
  }
} finally { rmSync(work, { recursive: true, force: true }); }
