import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getAddress, hexlify, toBeHex, ZeroHash } from 'ethers';
import { GOLDILOCKS, STARK_PARAMS } from './networks.mjs';
import { limbs4, openNote, pack, unpack, uint, word256 } from './notes.mjs';
import { need, OperatorError, privateText } from './store.mjs';

export const PROVER_SOURCE = 'a47d23ae969e23b5f841e30b49a1d483a80a6b02';
const BLAKE3_SOURCE = 'f3149ec5bb5449af877ba20377a11008ff499fa2';
export const MAX_PROOF_BYTES = 128_000;
const HEADER = `0x4e4f585007000100${STARK_PARAMS.slice(2)}`;
const MIN_PROOF_BYTES = 30_060; // fixed v7/body offsets from NativeStark
const runFile = promisify(execFile);
export const proofHash = (proof) => `0x${createHash('sha256').update(Buffer.from(proof.slice(2), 'hex')).digest('hex')}`;
export const proofShape = (proof) => typeof proof === 'string' && proof.startsWith(HEADER) &&
  proof.length >= MIN_PROOF_BYTES * 2 + 2 && proof.length <= MAX_PROOF_BYTES * 2 + 2 && /^0x(?:[0-9a-f]{2})+$/.test(proof);

export function checkProver(directory) {
  need(directory, 'Set NATIVE_STARK_PROVER_DIR (run scripts/build-testnet-prover.sh first).');
  const root = resolve(directory);
  try {
    const info = JSON.parse(privateText(join(root, 'prover.json'), 4_096));
    need(info.source === PROVER_SOURCE && info.blake3 === BLAKE3_SOURCE && info.rust === 'rustc 1.88.0 (6b00bc388 2025-06-23)',
      'Local prover is not the pinned build.');
    for (const bin of ['nox_bench', 'nox_share']) {
      need(createHash('sha256').update(readFileSync(join(root, bin))).digest('hex') === info[bin], 'Local prover checksum differs from its build manifest.');
    }
    return { root, info };
  } catch (e) { if (e instanceof OperatorError) throw e; throw new OperatorError('Cannot read the pinned local prover install.'); }
}

const nativeJson = (data) => JSON.stringify(data, (_, x) => typeof x === 'bigint' ? JSON.rawJSON(x.toString()) : x);

export function parseResult(text) {
  // Node 22 exposes the original token to the reviver, before u64 precision is lost to Number.
  return JSON.parse(text, (_, v, context) => {
    if (typeof v !== 'number') return v;
    need(/^(0|[1-9][0-9]*)$/.test(context.source), 'Prover result contains a non-u64 decimal token.');
    return uint(context.source, (1n << 64n) - 1n, 'prover u64');
  });
}

export function publicExit(words, request) {
  need(Array.isArray(words) && words.length === 37, 'Expected the 37-word NotBefore public statement.');
  const w = words.map((v) => uint(v, GOLDILOCKS - 1n, 'public limb'));
  const digest = (i) => pack(w.slice(i, i + 4));
  const to = (i) => {
    const chunks = w.slice(i, i + 4);
    need(chunks.slice(0, 3).every((n) => n < 1n << 48n) && chunks[3] < 1n << 16n, 'Noncanonical address in public limbs.');
    return getAddress(toBeHex(chunks.reduce((n, limb, j) => n | (limb << BigInt(j * 48)), 0n), 20));
  };
  const exit = { root: digest(0), nullifiers: [digest(8), digest(12)], change: [digest(16), digest(20)], recipient: to(28),
    feeRecipient: to(32), amount: w[24], fee: w[25], notBefore: w[36] };
  need(exit.root === request.note_root && digest(4) === request.note_root && exit.recipient === request.recipient &&
    exit.feeRecipient === request.fee_recipient && exit.amount === request.public_amount && exit.fee === request.fee &&
    w[26] === request.asset_id && w[27] === 0n && exit.notBefore === request.not_before, 'Proof publics do not match the requested deployment-bound exit.');
  need(exit.nullifiers[0] !== exit.nullifiers[1] && [...exit.nullifiers, ...exit.change].every((n) => n !== ZeroHash), 'Invalid proof nullifier or change commitment.');
  return exit;
}

export async function proveLocal(store, network, prover, request, seed, expectedNullifier, report = () => {}) {
  const scratch = store.scratch();
  const path = (...parts) => join(scratch, ...parts);
  const cache = store.path('periodic.top'); // Public parameters; validated by the pinned prover and the on-chain verifier.
  const requestFile = path('request.json'), seedFile = path('seed.json'), resultFile = path('result.json'), proofFile = path('proof.bin');
  const start = Date.now();
  try {
    writeFileSync(requestFile, nativeJson(request), { mode: 0o600, flag: 'wx' });
    writeFileSync(seedFile, nativeJson(seed), { mode: 0o600, flag: 'wx' });
    // Do not pass key paths, API keys, proxy variables, environment entropy/cache overrides, or private stdout to the child/logs.
    const run = async (bin, args) => {
      try {
        await runFile(join(prover.root, bin), args, { cwd: scratch, env: { NOX_CACHE: cache, NOX_ENTROPY: '/dev/urandom' },
          timeout: 1_800_000, maxBuffer: 256 * 1024 });
      } catch (e) {
        const reason = e.killed ? 'time/memory/output limit' : 'build, witness or periodic-cache check';
        throw new OperatorError(`Local ${bin} failed (${reason}). No withdrawal sent; inspect the local prover setup.`);
      }
    };
    report({ stage: 'local-proof', source: PROVER_SOURCE, build: prover.info });
    await run('nox_bench', [requestFile, seedFile, resultFile]);
    const result = parseResult(privateText(resultFile));
    const exit = publicExit(result.publics, request);
    need(exit.nullifiers[0] === expectedNullifier, 'Live witness nullifier does not match the saved note position.');
    need(result.outputs?.length === 2, 'Expected a pair of output openings.');
    const outputs = result.outputs.map((o, i) => {
      need(o.owned === true && o.value === request.output_values[i] && o.asset_id === network.assetId && word256(o.leaf) === exit.change[i],
        'Unexpected change ownership, value, asset or commitment.');
      const opened = openNote(network, o.value, limbs4(o.secret), limbs4(o.blinding));
      need(opened.leaf === exit.change[i] && opened.spendPk === pack(o.spend_pk), 'Change opening does not derive the verified leaf.');
      return opened;
    });
    await run('nox_share', [resultFile, cache, proofFile]);
    const proof = hexlify(readFileSync(proofFile));
    need(proofShape(proof), 'Proof does not fit the pinned format-7 size or image.');
    return { proof, exit, outputs, proofBytes: (proof.length - 2) / 2, proofSeconds: Math.round((Date.now() - start) / 1_000), build: prover.info };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
