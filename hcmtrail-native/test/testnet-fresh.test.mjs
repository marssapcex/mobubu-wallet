// Opt-in: fresh randomized proof(s), never broadcasts to a real network. Run serially (several GB RAM).
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id } from 'ethers';
import { DEMO_RECIPIENT, walletFixture } from './testnet-fixture.mjs';
import { checkProver } from '../testnet/prover.mjs';
import { TESTNETS } from '../testnet/networks.mjs';
import { json } from '../testnet/store.mjs';

process.umask(0o077);
const prover = checkProver(process.env.NATIVE_STARK_PROVER_DIR);
const assets = (process.env.NATIVE_TESTNET_ASSETS ?? 'ETH,BNB,TRX,HYPE').split(',');
assert(assets.every((a) => Object.hasOwn(TESTNETS, a)));
const cache = mkdtempSync(join(tmpdir(), 'hcmtrail-testnet-periodic-'));
const cacheFile = join(cache, 'periodic.top');
process.on('exit', () => rmSync(cache, { recursive: true, force: true }));
const say = (asset, data) => console.log(`${asset} ${json(data).trim()}`);

for (const asset of assets) test(`${asset} testnet domain: fresh proof pays a funded local exit, then refuses replay`, { timeout: 3_900_000 }, async () => {
  const f = await walletFixture(asset, (stage) => say(asset, stage));
  try {
    const { wallet, store, chain } = f;
    if (existsSync(cacheFile)) copyFileSync(cacheFile, store.path('periodic.top'));
    const value = asset === 'TRX' ? 2_000_000n : 10_000_000_000_000_000n;
    const n = wallet.newNote(value);
    const deposit = await wallet.deposit(n.note);
    say(asset, { manifest: f.manifest, deposit });
    assert.equal(await wallet.ledger.read('accountedNative'), value);
    const before = await chain.balance(DEMO_RECIPIENT);
    const payout = value / 2n;
    const plan = await wallet.prove(n.note, payout, DEMO_RECIPIENT, prover);
    assert(plan.changeNote && store.has(`note-${plan.changeNote}.json`));
    assert(!JSON.stringify(store.read(plan.publicFile)).includes('"secret"'));
    say(asset, { plan, preflight: await wallet.preflight(plan.exitId) });
    const paid = await wallet.withdraw(plan.exitId);
    say(asset, { paid });
    assert.equal(await chain.balance(DEMO_RECIPIENT) - before, payout);
    assert.equal(await wallet.ledger.read('accountedNative'), value - payout);
    assert.equal(await chain.balance(f.manifest.vault), value - payout);
    assert.equal(await wallet.ledger.read('leafCount'), 4n);
    const e = wallet.loadExit(plan.exitId);
    for (const nf of e.exit.nullifiers) assert(await wallet.ledger.read('spent', [nf]));
    await assert.rejects(() => chain.call(wallet.ledger.spec('withdraw', [e.proof, e.exit])), (error) => {
      const code = id('AlreadySpent()').slice(0, 10);
      return error.data?.startsWith?.(code) || error.revert === code;
    });
    await assert.rejects(() => wallet.preflight(plan.exitId), /AlreadySpent/);
    // Delete *indexes only*, retaining the secret backup. Recover from logs + confirmed receipts.
    rmSync(store.path(`fund-${plan.changeNote}.json`));
    rmSync(store.path(`paid-${plan.exitId}.json`));
    assert.equal((await wallet.recoverNote(plan.changeNote)).index, paid.appendedAt);
    assert.equal((await wallet.recoverExit(plan.exitId)).receipt.hash, paid.receipt.hash);
    assert.equal((await wallet.withdraw(plan.exitId)).receipt.hash, paid.receipt.hash);
    if (!existsSync(cacheFile)) copyFileSync(store.path('periodic.top'), cacheFile);
    if (asset === 'ETH') {
      // A second, fresh real proof spends the recovered private change note (not just its public event).
      const tail = await wallet.prove(plan.changeNote, value - payout, DEMO_RECIPIENT, prover);
      assert.equal(tail.changeNote, null);
      say(asset, { recoveredChangePlan: tail });
      say(asset, { recoveredChangePaid: await wallet.withdraw(tail.exitId) });
      assert.equal(await chain.balance(DEMO_RECIPIENT) - before, value);
      assert.equal(await wallet.ledger.read('accountedNative'), 0n);
      assert.equal(await chain.balance(f.manifest.vault), 0n);
    }
  } finally { f.close(); }
});
