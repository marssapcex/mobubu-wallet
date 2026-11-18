// Optional real-receipt test. Requires a locally built, pinned RISC Zero host.
// Uses synthetic notes only, never an imported note file, RPC, or EVM mock.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getBytes } from 'ethers';
import { createNote, prepareLocalExit, treeFromLeaves } from 'mobubu-wallet/pool';

if (!process.env.POOL_STARK_TOOL) throw new Error('Set POOL_STARK_TOOL to the built local STARK tool; no fake-proof fallback');
const tool = resolve(process.env.POOL_STARK_TOOL);
const call = (args, input) => {
  const proc = spawnSync(tool, args, { input, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(proc.error);
  return proc;
};
const domain = '0x' + '50'.repeat(32);
const deposit = await createNote({ asset: 'ETH', domain, value: 120_000_000_000_000_000_001n });
const decoy = await createNote({ asset: 'ETH', domain, value: 17n });
const tree = await treeFromLeaves([decoy.leaf, deposit.leaf]);
const pack = await prepareLocalExit({ note: deposit, anchor: tree.path(1), debit: 10_000_000_000_000_000_001n,
  recipient: '0x' + 'bc'.repeat(20), submitter: '0x' + 'ad'.repeat(20), now: 1_794_960_000, deadline: 1_794_961_000 });
const journal = Buffer.from(getBytes(pack.journal)), witness = getBytes(pack.witness);
const input = Buffer.concat([journal, witness]);
const dir = mkdtempSync(join(tmpdir(), 'mobubu-stark-'));
try {
  const image = call(['image-id']);
  assert.equal(image.status, 0);
  assert.match(image.stdout.toString().trim(), /^(?!0{64}$)[a-f0-9]{64}$/);
  const receipt = call(['prove'], input);
  assert.equal(receipt.status, 0, 'STARK receipt generation failed');
  assert.ok(receipt.stdout.length > journal.length);
  const path = join(dir, 'journal');
  writeFileSync(path, journal, { mode: 0o600 });
  assert.equal(call(['verify', path], receipt.stdout).status, 0);
  assert.notEqual(call(['verify', path], receipt.stdout.subarray(0, -1)).status, 0);
  assert.notEqual(call(['verify', path], Buffer.concat([receipt.stdout, Buffer.of(0)])).status, 0);
  journal[96] ^= 1;
  writeFileSync(path, journal);
  assert.notEqual(call(['verify', path], receipt.stdout).status, 0, 'wrong nullifier accepted');
  input[224] ^= 1;
  assert.notEqual(call(['prove'], input).status, 0, 'invalid note opening received a proof');
  console.log(`Local STARK accepted correct journal and rejected tampering; program ${image.stdout.toString().trim()}, ${receipt.stdout.length} receipt bytes. Not EVM verification.`);
} finally {
  input.fill(0); witness.fill(0); rmSync(dir, { force: true, recursive: true });
}
