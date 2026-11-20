import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAddress, getBytes, hexlify, id, Interface, toBeHex, toQuantity, ZeroHash } from 'ethers';
import { test } from 'node:test';
import { HCMT_RELAY_BOND as BOND } from '../testnet/dao-policy.mjs';
import { callSpec } from '../testnet/deployment.mjs';
import { checkProver } from '../testnet/prover.mjs';
import { proveStake, stakeChallenge, stakeCredential, intentHash } from '../testnet/staking.mjs';
import { json, outsideSource } from '../testnet/store.mjs';
import { daoFixture } from './dao-fixture.mjs';
import { DEMO_RECIPIENT, DEMO_SENDER } from './testnet-fixture.mjs';

process.umask(0o077);
const generate = process.env.NATIVE_STAKE_GENERATE === '1';
const target = generate && process.env.NATIVE_STAKE_VECTORS_DIR ? outsideSource(process.env.NATIVE_STAKE_VECTORS_DIR) : null;
const prover = generate ? checkProver(process.env.NATIVE_STARK_PROVER_DIR) : undefined;
const assets = generate && process.env.NATIVE_TESTNET_ASSETS ? process.env.NATIVE_TESTNET_ASSETS.split(',') : ['ETH', 'TRX'];
assert(assets.every((a) => ['ETH', 'TRX'].includes(a)));
const expectedSelector = (name) => id(`${name}()`).slice(0, 10);
const reverted = (name) => (e) => e.revert === expectedSelector(name) || e.data?.startsWith?.(expectedSelector(name));
const recipient = computeAddress(toBeHex(3, 32));
const effectiveAt = 3n;
const baseUnstake = BOND / 5n;
const vectorDir = fileURLToPath(new URL('./vectors/stake/', import.meta.url));
const canonicalTime = 1_790_000_000n / 600n * 600n;

const sameProof = (packet) => JSON.parse(json(packet));
const value = (r) => r.gasUsed ?? r.energyUsed;
const publicFixture = (role, ctx, who) => stakeCredential(ctx, who,
  [17n, 45n, 187n, 219n].map((x) => x + role * 101n), [8n, 32n, 129n, 153n].map((x) => x + role * 373n));

async function packet(f, label, who, key, action, nonce) {
  const { store, stakeWallet: sw } = f;
  if (generate) {
    const start = Date.now();
    const out = await proveStake(store, prover, sw.ctx, who, key, action, nonce, canonicalTime);
    console.log(`${f.chain.network.asset} ${label} proof ${(out.proof.length - 2) / 2} B ${Math.round((Date.now() - start) / 1000)}s ${out.id}`);
    return sameProof(out);
  }
  const prefix = resolve(vectorDir, f.chain.network.asset, label);
  const out = { ...JSON.parse(readFileSync(`${prefix}.json`, 'utf8')), proof: hexlify(readFileSync(`${prefix}.bin`)) };
  assert.deepEqual(out.action, JSON.parse(json(action)));
  assert.equal(out.staker, who);
  assert.equal(out.permit.nonce, String(nonce));
  return out;
}

function saveVectors(asset, records) {
  if (!target) return;
  const dir = resolve(target, asset);
  assert(!existsSync(dir), 'Use a new vector output directory (do not overwrite fixtures).');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, { proof, ...metadata }] of Object.entries(records)) {
    writeFileSync(resolve(dir, `${name}.bin`), getBytes(proof), { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(dir, `${name}.json`), json(metadata), { flag: 'wx', mode: 0o600 });
  }
}

async function failedClaim(f, spec) {
  const { chain, relayChain } = f;
  await assert.rejects(() => relayChain.call(spec, 'latest'), reverted('NativeTransferFailed'));
  if (chain.network.tvm) {
    const r = await f.vm.attach(f.a.treasury.abi, f.manifest.dao.treasury).raw(getBytes(spec.data), {
      from: relayChain.sender, timestamp: (await chain.head()).timestamp,
    });
    assert(r.execResult.exceptionError);
    assert.equal(hexlify(r.execResult.returnValue), expectedSelector('NativeTransferFailed'));
    assert.equal(r.execResult.logs?.length ?? 0, 0);
  } else {
    const tx = await chain.rpc('eth_sendTransaction', [{ from: relayChain.sender, to: spec.to, data: spec.data, gas: toQuantity(12_000_000) }]);
    const receipt = await chain.receipt(tx);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.logs.length, 0);
  }
}

for (const asset of assets) test(`${asset}: ${generate ? 'fresh' : 'pinned'} STARKs authorize HCMT refund and batched native rewards without the staker's gas key`,
  { timeout: 3_900_000 }, async (t) => {
    const f = await daoFixture(asset);
    t.after(f.close);
    const { chain, relayChain, manifest, wallet, treasuryView: get, treasurySpec: spec, tokenView, stakeWallet: sw, relayStakeWallet: worker } = f;
    const treasury = manifest.dao.treasury;
    const receiver = await f.switchReceiver();
    const kA = publicFixture(1n, sw.ctx, DEMO_SENDER), kB = publicFixture(2n, sw.ctx, DEMO_RECIPIENT);
    await f.transfer(2n * BOND);
    await f.stake(BOND, false, 'alice', kA.root);
    await f.stake(2n * BOND, true, 'bob', kB.root);
    assert.deepEqual(Array.from(await sw.read('authorities', [DEMO_SENDER])), [kA.root, 0n]);
    await assert.rejects(() => sw.newKey(DEMO_SENDER), /already exists/);
    await assert.rejects(() => chain.call(spec('stake', [1n, kB.root]), 'latest'), reverted('InvalidAuthority'));
    await assert.rejects(() => chain.call({ ...spec('stake', [1n, ZeroHash]), from: recipient }, 'latest'), reverted('InvalidAuthority'));
    assert.equal(await get('totalAt', [1n]), 0n);
    assert.equal(await get('totalAt', [2n]), 3n * BOND);
    assert.equal(await get('isBroadcaster', [DEMO_SENDER]), false);
    await wallet.deposit(wallet.newNote(4_000n).note); // fee 10 in period 1 without active stakes
    await f.time(2);
    assert.equal(await get('isBroadcaster', [DEMO_SENDER]), true);
    await wallet.deposit(wallet.newNote(7_600n).note); // fee 19 in period 2
    const unlockAction = { kind: 'unstake', amount: baseUnstake, recipient, effectivePeriod: effectiveAt };
    const unlock = await packet(f, 'unlock-a', DEMO_SENDER, kA, unlockAction, 0n);
    const normalized = worker.request(unlock);
    const { permit, spec: unlockSpec } = normalized;
    const challenge = stakeChallenge(sw.ctx, DEMO_SENDER, 0n, unlockAction);
    assert.equal((await sw.read('stakeChallenge', [DEMO_SENDER, 0n, intentHash(unlockAction)]))[0], challenge);
    assert.throws(() => sw.request({ ...unlock, profile: 'legacy' }), /not a public permit/);
    assert.throws(() => sw.request({ ...unlock, id: ZeroHash }), /hash/);
    assert.throws(() => sw.request({ ...unlock, secret: [0n] }), /not a public permit/);
    await assert.rejects(() => chain.call(spec('requestUnstake', [DEMO_SENDER, baseUnstake, recipient, effectiveAt, '0x', permit]), 'latest'), reverted('InvalidStarkProof'));
    const varied = (changes) => worker.request({ ...unlock, action: { ...unlock.action, ...changes } }).spec;
    await assert.rejects(() => relayChain.call(varied({ recipient: DEMO_RECIPIENT }), 'latest'), reverted('InvalidStarkProof'));
    await assert.rejects(() => relayChain.call(varied({ amount: String(baseUnstake + 1n) }), 'latest'), reverted('InvalidStarkProof'));
    await assert.rejects(() => relayChain.call(varied({ effectivePeriod: '4' }), 'latest'), reverted('WrongUnlockPeriod'));
    await assert.rejects(() => relayChain.call(spec('requestUnstake', [DEMO_SENDER, baseUnstake, recipient, effectiveAt, unlock.proof,
      { ...permit, notBefore: permit.notBefore + 1n }]), 'latest'), reverted('InvalidStakeStatement'));
    await assert.rejects(() => relayChain.call(worker.request({ ...unlock, staker: DEMO_RECIPIENT }).spec, 'latest'), reverted('InvalidStarkProof'));
    if (asset === 'ETH') {
      const wrongDomain = stakeChallenge({ ...sw.ctx, chainId: '97' }, DEMO_SENDER, 0n, unlockAction);
      await assert.rejects(() => relayChain.call(callSpec(new Interface(f.a.stakeGate.abi), manifest.dao.stakeGate,
        'verify', [unlock.proof, kA.root, wrongDomain, permit]), 'latest'), reverted('InvalidStarkProof'));
    }
    assert.deepEqual(Array.from(await sw.read('unlocks', [DEMO_SENDER])), [0n, 0n, '0x0000000000000000000000000000000000000000']);
    const preflight = await worker.check(unlock);
    const unlocked = await worker.submit(unlock);
    console.log(`${asset} proof unlock: ${value(unlocked.receipt)} VM units ${preflight.calldataBytes} bytes ${unlocked.receipt.hash}`);
    assert.equal(preflight.id, unlock.id);
    assert.deepEqual(preflight.action, unlockAction);
    assert.equal(unlocked.receipt.from, DEMO_RECIPIENT);
    assert.equal((await sw.read('authorities', [DEMO_SENDER]))[1], 1n);
    assert.deepEqual(Array.from(await sw.read('unlocks', [DEMO_SENDER])), [effectiveAt, baseUnstake, recipient]);
    await assert.rejects(() => relayChain.call(spec('releaseStake', [DEMO_SENDER]), 'latest'), reverted('StillLocked'));
    assert.equal((await worker.submit(unlock)).receipt.hash, unlocked.receipt.hash);
    await f.time(3);
    assert.equal(await get('stakeAt', [DEMO_SENDER, 2n]), BOND);
    assert.equal(await get('stakeAt', [DEMO_SENDER, 3n]), BOND - baseUnstake);
    assert.equal(await get('isBroadcaster', [DEMO_SENDER]), false);
    const release = await f.send('release-to-proof-recipient', spec('releaseStake', [DEMO_SENDER]), true);
    console.log(`${asset} release with bound recipient: ${value(release)} VM units`);
    assert.equal(await tokenView('balanceOf', [recipient]), baseUnstake);
    assert.equal(await tokenView('balanceOf', [treasury]), 3n * BOND - baseUnstake);
    await assert.rejects(() => relayChain.call(spec('releaseStake', [DEMO_SENDER]), 'latest'), reverted('StillLocked'));
    await assert.rejects(() => relayChain.call(unlockSpec, 'latest'), reverted('WrongUnlockPeriod'));
    await wallet.deposit(wallet.newNote(2_800n).note); // fee 7 in period 3
    await f.time(4);
    await f.send('close', spec('closePeriods', [3n]), true);
    assert.equal(await get('reservedNative'), 36n);
    assert.equal(await get('claimable', [DEMO_SENDER, 2n]), 9n);
    assert.equal(await get('claimable', [DEMO_SENDER, 3n]), 2n);
    assert.equal(await get('claimable', [DEMO_RECIPIENT, 2n]), 19n);
    const claimAction = { kind: 'claim', recipient: receiver.at, periods: [2n, 3n] };
    const claim = await packet(f, 'claim-a', DEMO_SENDER, kA, claimAction, 1n);
    const claimSpec = worker.request(claim).spec;
    await assert.rejects(() => chain.call(spec('claim', [DEMO_SENDER, receiver.at, [2n, 3n], '0x', worker.request(claim).permit]), 'latest'), reverted('InvalidStarkProof'));
    await assert.rejects(() => relayChain.call(worker.request({ ...claim, action: { ...claim.action, recipient: DEMO_RECIPIENT } }).spec, 'latest'), reverted('InvalidStarkProof'));
    await assert.rejects(() => relayChain.call(worker.request({ ...claim, action: { ...claim.action, periods: ['2'] } }).spec, 'latest'), reverted('InvalidStarkProof'));
    await assert.rejects(() => relayChain.call(worker.request({ ...claim, permit: { ...claim.permit, nonce: '0' } }).spec, 'latest'), reverted('WrongStakeNonce'));
    const [reward2, reward3] = await Promise.all([sw.read('rewards', [2n]), sw.read('rewards', [3n])]);
    await failedClaim(f, claimSpec);
    assert.deepEqual(Array.from(await sw.read('rewards', [2n])), Array.from(reward2));
    assert.deepEqual(Array.from(await sw.read('rewards', [3n])), Array.from(reward3));
    assert.equal(await chain.balance(treasury), 36n);
    assert.equal(await get('reservedNative'), 36n);
    assert.equal((await sw.read('authorities', [DEMO_SENDER]))[1], 1n);
    for (const p of [2n, 3n]) assert.equal(await get('claimed', [p, DEMO_SENDER]), false);
    await f.send('allow-payout', receiver.spec('allowPayment'));
    const paid = await worker.submit(claim);
    console.log(`${asset} proof claim: ${value(paid.receipt)} VM units ${paid.receipt.hash}`);
    assert.equal(paid.receipt.from, DEMO_RECIPIENT);
    assert.equal(await chain.balance(receiver.at), 11n);
    assert.equal(await get('reservedNative'), 25n);
    assert.equal((await sw.read('authorities', [DEMO_SENDER]))[1], 2n);
    await assert.rejects(() => relayChain.call(claimSpec, 'latest'), reverted('AlreadyClaimed'));
    assert.equal((await worker.submit(claim)).receipt.hash, paid.receipt.hash);
    assert.throws(() => worker.request({ ...claim, action: { ...claim.action, periods: ['2', '2'] } }), /distinct/);
    const vectors = { 'unlock-a': unlock, 'claim-a': claim };
    if (asset === 'ETH') {
      const b = await packet(f, 'claim-b', DEMO_RECIPIENT, kB, { kind: 'claim', recipient, periods: [2n] }, 0n);
      const before = await chain.balance(recipient);
      const reward = await sw.submit(b); // Alice sponsors Bob, still pays his proof's exact recipient.
      console.log(`${asset} proof claim-b: ${value(reward.receipt)} VM units ${reward.receipt.hash}`);
      assert.equal(await chain.balance(recipient) - before, 19n);
      assert.equal(await get('reservedNative'), 5n);
      assert.equal(await get('receiptsByPeriod', [4n]), 1n);
      assert.equal(await chain.balance(treasury), 6n);
      vectors['claim-b'] = b;
    }
    if (generate) saveVectors(asset, vectors);
  });
