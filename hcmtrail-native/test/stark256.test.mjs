import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { L1Hardfork } from '@nomicfoundation/edr';
import { getBytes, hexlify, id } from 'ethers';
import { compileSolidity } from '../scripts/compile.mjs';
import { ETH_POOL_RELEASE_POLICY, requireEthPoolRelease } from '../pool/release-policy.mjs';
import { algebraicBudget, atLeastBits, errorBits, oracleTermScales, STARK256_RESEARCH } from '../pool/stark256-profile.mjs';
import { benchmarkCoefficients, framedHasher, HEADER_BYTES, mul, powBase, proveFri, QUERY_BYTES } from '../pool/stark256/fri-reference.mjs';
import { GOLDILOCKS as P, TX_GAS_CAP } from '../testnet/networks.mjs';
import { localEvm, LOCAL_ID } from './local-evm.mjs';

const dir = 'contracts/research/stark256';
const fri = `${dir}/WideFri256.sol`;
const fixture = 'test/fixtures/Stark256Fixture.sol';
const paths = [fri, fixture, `${dir}/GoldilocksFp8.sol`, `${dir}/WideTranscript256.sol`, `${dir}/Blake2b512.sol`];
const opts = { gasLimit: TX_GAS_CAP };
const hash = (bytes) => createHash('blake2b512').update(bytes).digest();
const has = (name) => (err) => err.revert?.name === name || err.data?.startsWith(id(`${name}()`).slice(0, 10));
const sequence = (len) => Uint8Array.from({ length: len }, (_, i) => (7 + 29 * i) % 256);
const flip = (data, at) => { const faulty = data.slice(); faulty[at] ^= 1; return faulty; };
let binaries;
function artifact(path, name) {
  binaries ??= compileSolidity(paths, { settings: { viaIR: true, metadata: { bytecodeHash: 'none' } } });
  return binaries.artifact(path, name);
}

test('256 is a hard minimum; no automatic downgrade, including when a worksheet passes', () => {
  const policy = ETH_POOL_RELEASE_POLICY;
  assert.equal(policy.minClassicalSoundnessBits, 256);
  assert.equal(policy.targetQuantumSecurityBits, 128);
  assert.equal(policy.requireReviewedQuantumAnalysis, true);
  assert.equal(policy.releaseAllowed, false);
  assert.equal(policy.approvedSpendProfile, null);
  const budget = algebraicBudget(STARK256_RESEARCH);
  assert(atLeastBits(budget.union, 399));
  assert(atLeastBits(budget.romProjection, 351));
  assert.equal(budget.meetsArithmeticTarget, true);
  assert.equal(budget.collisionWorkBits, 256);
  for (const params of [{ digestBits: 511 }, { queries: 88 }, { extensionDegree: 4 }]) {
    assert.equal(algebraicBudget({ ...STARK256_RESEARCH, ...params }).meetsArithmeticTarget, false);
  }
  const { rbr, idealCollision } = oracleTermScales();
  assert(atLeastBits(rbr, 143));
  assert.equal(errorBits(idealCollision), 128);
  assert.throws(requireEthPoolRelease, /≥256-bit classical soundness and separate reviewed evidence/);
  const paths = [
    ['../scripts/build-vault.mjs', '--pool'],
    ['../scripts/build-vault.mjs', '--pool-256'], ['../../scripts/eth-pool-preview.mjs'],
    ['../../scripts/eth-pool-preview.mjs', '--require-256'],
  ];
  for (const [script, ...args] of paths) {
    const path = fileURLToPath(new URL(script, import.meta.url));
    const run = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /ETH pool release blocked: requires ≥256-bit/);
    assert.equal(run.stdout, '');
  }
  for (const [script, ...args] of [
    ['../scripts/build-vault.mjs', '--pool-192'], // retired flags also fail closed
    ['../../scripts/eth-pool-preview.mjs', '--require-192'],
    ['../scripts/build-vault.mjs', '--pool-256', '--pool-legacy-devnet'],
    ['../../scripts/eth-pool-preview.mjs', '--require-256', '--legacy-devnet'],
  ]) {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Usage:/);
    assert.equal(run.stdout, '');
  }
  const script = fileURLToPath(new URL('../scripts/build-pool-wasm.sh', import.meta.url));
  const run = spawnSync('bash', [script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /prover release blocked/);
});

test('BLAKE2b-512, Fp8 basis and full-width sampling match the reference', { timeout: 90_000 }, async (t) => {
  const code = artifact(fixture, 'Stark256Fixture');
  const vm = await localEvm(LOCAL_ID, { hardfork: L1Hardfork.Osaka });
  t.after(vm.close);
  const f = await vm.deploy(code, opts);
  for (const length of [0, 1, 127, 128, 129, 256, 257, 4096]) {
    const input = sequence(length);
    assert.equal(await f.digest(input), hexlify(hash(input)));
  }
  // Binomial irreducibility: 8 | p-1, and 7 is nonsquare with maximal 2-adic order.
  assert.equal(P % 4n, 1n);
  assert.equal((P - 1n) % 8n, 0n);
  assert.equal(powBase(7n, (P - 1n) / 2n), P - 1n);
  const a = Array(8).fill(P - 1n);
  const b = a.map((n, i) => n - BigInt(i));
  assert.deepEqual(Array.from(await f.multiply(a, b)), mul(a, b));
  b[7] = P;
  await assert.rejects(f.multiply(a, b), has('NonCanonical'));
  const candidate = sequence(64);
  const view = new DataView(candidate.buffer);
  view.setBigUint64(56, P - 1n, true);
  const [ok, limbs] = await f.sample(candidate);
  assert.equal(ok, true);
  assert.equal(limbs[7], P - 1n);
  view.setBigUint64(56, P, true);
  assert.equal((await f.sample(candidate))[0], false);
  await assert.rejects(f.sample(candidate.slice(0, 56)), has('InvalidDigestLength'));
  const h = framedHasher(hash);
  const ctx = sequence(513);
  const { value, next } = h.challenge(h.start(ctx), 7);
  const [onchain, post] = await f.challenge(ctx, 7);
  assert.deepEqual(Array.from(onchain), value);
  assert.equal(post, hexlify(next));
});

test('HCFR v2 verifies all 144 queries across bounded windows without accepting v1, legacy or incomplete sessions', { timeout: 180_000 }, async (t) => {
  const code = artifact(fri, 'WideFri256');
  const vm = await localEvm(LOCAL_ID, { hardfork: L1Hardfork.Osaka });
  t.after(vm.close);
  const v = await vm.deploy(code, opts);
  const initBytes = getBytes(code.bytecode).length, runtimeBytes = getBytes(await vm.provider.getCode(v.target)).length;
  assert(initBytes <= 49_152 && runtimeBytes <= 24_576);
  const context = sequence(32), start = performance.now();
  const { header, queries } = proveFri(benchmarkCoefficients(), context, hash);
  const q = Number(await v.QUERIES()), window = Number(await v.MAX_QUERIES_PER_TX());
  assert.equal(q, STARK256_RESEARCH.queries);
  assert.equal(await v.ROUNDS(), BigInt(STARK256_RESEARCH.maxFoldRounds));
  assert.equal(await v.DOMAIN_LOG(), BigInt(STARK256_RESEARCH.maxDegreeLog + STARK256_RESEARCH.blowupLog));
  assert.equal(header.length, HEADER_BYTES);
  assert.equal(await v.HEADER_BYTES(), BigInt(HEADER_BYTES));
  assert.equal(queries.length, q * QUERY_BYTES);
  assert.equal(await v.QUERY_BYTES(), BigInt(QUERY_BYTES));
  assert.equal(await v.MAGIC(), hexlify(header.slice(0, 8)));
  assert.equal(createHash('sha256').update(header).update(queries).digest('hex'),
    'ebbb8ca639195e152a8b4c69f4097eb3f759b1e8f2d4eb2b076159a280bb81dc');
  t.diagnostic(`HCFR v2 sparse polynomial: ${header.length + queries.length} proof bytes in ${(performance.now() - start).toFixed(0)}ms; ${initBytes}/${runtimeBytes} byte initcode/runtime`);
  const calldataFloor = [header, queries].reduce((n, bytes) => bytes.reduce((g, b) => g + (b ? 40n : 10n), n), 21_000n);
  assert(calldataFloor > TX_GAS_CAP);
  t.diagnostic(`single submission calldata floor ≥ ${calldataFloor} gas (before ABI overhead)`);
  for (const prefix of ['0x4843465201061858', '0x4e4f585007000100']) {
    const older = header.slice(); older.set(getBytes(prefix));
    await assert.rejects(v.open.staticCall(context, older), has('InvalidHeader'));
  }
  const overflow = header.slice();
  new DataView(overflow.buffer).setBigUint64(overflow.length - 8, P, true);
  await assert.rejects(v.open.staticCall(context, overflow), has('InvalidHeader'));
  const open = async (h) => {
    const r = await (await v.open(context, h, opts)).wait();
    const [e] = r.logs.map((log) => v.interface.parseLog(log));
    assert.equal(hexlify(framedHasher(hash).sessionKey(context, h)), `${e.args.first}${e.args.second.slice(2)}`);
    return [e.args.id, r.gasUsed];
  };
  const [sess, openGas] = await open(header);
  const first = queries.slice(0, QUERY_BYTES);
  await assert.rejects(v.check.staticCall(sess, flip(context, 1), header, first), has('WrongProof'));
  await assert.rejects(v.check.staticCall(sess, context, flip(header, 40), first), has('WrongProof'));
  await assert.rejects(v.check.staticCall(sess, context, header, first.slice(1)), has('InvalidWindow'));
  await assert.rejects(v.check.staticCall(sess, context, header, flip(first, 512 + 40)), has('InvalidOpening'));
  const cursor = async (s) => Array.from(await v.progress(s));
  let total = openGas, max = 0n, min = TX_GAS_CAP;
  for (let i = 0; i < q; i += window) {
    const segment = queries.slice(i * QUERY_BYTES, (i + window) * QUERY_BYTES);
    const receipt = await (await v.check(sess, context, header, segment, opts)).wait();
    assert(receipt.gasUsed < TX_GAS_CAP);
    total += receipt.gasUsed;
    if (receipt.gasUsed > max) max = receipt.gasUsed;
    if (receipt.gasUsed < min) min = receipt.gasUsed;
    if (i === 0) assert.deepEqual(await cursor(sess), [BigInt(window), false]);
  }
  assert.deepEqual(await cursor(sess), [BigInt(q), true]);
  await assert.rejects(v.check.staticCall(sess, context, header, first), has('InvalidWindow'));
  // Constant codeword paths stay valid across a change of query positions.
  // Leave every opening intact and require rejection of a wrong constant tail.
  const constant = proveFri(new Map(), context, hash);
  const wrong = flip(constant.header, constant.header.length - 8);
  const [bad] = await open(wrong);
  await assert.rejects(v.check.staticCall(bad, context, wrong, constant.queries.slice(0, QUERY_BYTES)), has('InvalidFold'));
  assert.deepEqual(await cursor(bad), [0n, false]);
  t.diagnostic(`open ${openGas} gas; ${Math.ceil(q/window)} windows each ${min}–${max} gas; ${total} gas total (Osaka, FRI only)`);
});
