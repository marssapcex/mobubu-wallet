import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id, ZeroAddress, ZeroHash } from 'ethers';
import { daoCommand } from '../testnet/dao-ops.mjs';
import { daoFee, HCMT_LOCAL_SUPPLY, HCMT_PROJECT_SUPPLY, HCMT_RELAY_BOND as BOND, relayLimits } from '../testnet/dao-policy.mjs';
import { createSpec, deploy, verifyDeployment } from '../testnet/deployment.mjs';
import { exitContext } from '../testnet/exit-terms.mjs';
import { proofHash } from '../testnet/prover.mjs';
import { validateQuote } from '../testnet/relay.mjs';
import { daoFixture } from './dao-fixture.mjs';
import { DEMO_RECIPIENT, DEMO_SENDER, evmFixture } from './testnet-fixture.mjs';
import { loadVector } from './vault-fixture.mjs';

process.umask(0o077);
const selector = (err) => id(`${err}()`).slice(0, 10);
const reverted = (err) => (e) => e.data?.startsWith?.(selector(err)) || e.revert === selector(err);
const assets = ['ETH', 'BNB', 'TRX', 'HYPE'];

for (const asset of assets) test(`${asset} pins fee vault, local HCMT and treasury; exact per-deposit native conservation`, async (t) => {
  const f = await daoFixture(asset);
  t.after(f.close);
  const { a, chain, store, txs, wallet, manifest: m, tokenView, treasuryView } = f;
  assert.equal(m.deployments.length, 8);
  assert.equal(await tokenView('totalSupply'), HCMT_LOCAL_SUPPLY);
  assert.equal(await tokenView('PROJECT_SUPPLY'), HCMT_PROJECT_SUPPLY);
  assert.equal(await tokenView('balanceOf', [DEMO_SENDER]), HCMT_LOCAL_SUPPLY);
  assert.equal(HCMT_LOCAL_SUPPLY * BigInt(assets.length), HCMT_PROJECT_SUPPLY);
  assert.equal((await deploy(chain, store, txs, a, DEMO_SENDER)).dao.token, m.dao.token);
  await assert.rejects(() => deploy(chain, store, txs, a, DEMO_RECIPIENT), /different genesis holder/);
  assert.equal(await wallet.ledger.read('DAO_FEE_BPS'), 25n);
  const { min, max } = relayLimits(chain.network);
  assert.equal(await wallet.ledger.read('minRelayFee'), min);
  assert.equal(await wallet.ledger.read('maxRelayFee'), max);
  await assert.rejects(() => chain.simulate(wallet.ledger.spec('deposit', [ZeroHash], 10_000n)), reverted('InvalidCommitment'));
  const lots = asset === 'ETH' ? [399n, 400n, 401n, 12_345_678_901_234_567n] : [400n, 1_234_567n];
  const sum = lots.reduce((n, x) => n + x, 0n), fee = lots.reduce((n, x) => n + daoFee(x), 0n);
  for (const gross of lots) {
    const n = wallet.newNote(gross);
    assert.equal(n.daoFee, gross * 25n / 10_000n);
    assert.equal(n.amount, gross - n.daoFee);
    const r = await wallet.deposit(n.note);
    assert.equal((await wallet.deposit(n.note)).receipt.hash, r.receipt.hash);
  }
  assert.equal(await chain.balance(m.vault), sum - fee);
  assert.equal(await wallet.ledger.read('accountedNative'), sum - fee);
  assert.equal(await chain.balance(m.dao.treasury), fee);
  assert.equal(await treasuryView('receiptsByPeriod', [1n]), fee);
  assert.equal((await wallet.ledger.snapshot()).leaves.length, 1 + lots.length);
});

test('immutable bindings reject the wrong chain, token, treasury and tampered creation provenance', async (t) => {
  const f = await daoFixture('ETH');
  t.after(f.close);
  const { a, chain, manifest: m } = f;
  const wrong = await evmFixture('ETH', { chainId: 1n });
  t.after(wrong.close);
  await assert.rejects(() => wrong.chain.rpc('eth_estimateGas', [{ from: DEMO_SENDER,
    data: createSpec(a.token, 'HcmtToken', [DEMO_SENDER]).data }]), reverted('WrongChain'));
  await assert.rejects(() => chain.simulate(createSpec(a.token, 'HcmtToken', [ZeroAddress])), reverted('InvalidAccount'));
  const { prepare, walk, chunks } = m.stack;
  await assert.rejects(() => chain.simulate(createSpec(a.treasury, 'HcmtTreasury', [m.vault, prepare, walk, chunks])), reverted('WrongToken'));
  await assert.rejects(() => chain.simulate(createSpec(a.treasury, 'HcmtTreasury', [m.dao.token, m.vault, walk, chunks])), reverted('WrongStarkCode'));
  await assert.rejects(() => chain.simulate(createSpec(a.vaults.ETH, a.vaults.ETH.name, [prepare, walk, chunks, m.dao.token])), reverted('WrongTreasury'));
  await assert.rejects(() => verifyDeployment(chain, { ...m, dao: { ...m.dao, genesisHolder: DEMO_RECIPIENT } }, a), /creation does not match/);
  await assert.rejects(() => verifyDeployment(chain, { ...m, dao: { ...m.dao, tokenTx: m.created.tx } }, a), /creation does not match/);
  await assert.rejects(() => verifyDeployment(chain, { ...m, dao: { ...m.dao, stakeGate: m.vault } }, a), /Wrong treasury stakeGate/);
  await assert.rejects(() => verifyDeployment(chain, { ...m, dao: { ...m.dao, profile: undefined } }, a), /Wrong STARK staking profile/);
  await assert.rejects(() => f.relayChain.simulate(f.tokenSpec('transfer', [DEMO_SENDER, 1n])), reverted('InsufficientBalance'));
  await assert.rejects(() => f.relayChain.simulate(f.tokenSpec('transferFrom', [DEMO_SENDER, DEMO_RECIPIENT, 1n])), reverted('InsufficientAllowance'));
});

test('first stake fixes the proof root, approves exact amount, and activates only next period', async (t) => {
  const f = await daoFixture('ETH');
  t.after(f.close);
  const { chain, manifest: m, stakeWallet, treasuryView: get, treasurySpec: spec } = f;
  const cmd = (method, ...args) => daoCommand(chain, f.txs, m, f.a, method, args);
  const key = await stakeWallet.newKey(DEMO_SENDER);
  assert.equal((await stakeWallet.newKey(DEMO_SENDER)).authRoot, key.authRoot);
  await assert.rejects(() => chain.simulate(spec('stake', [1n, ZeroHash])), reverted('InvalidAuthority'));
  await cmd('stake', 'first', String(BOND - 1n), key.authRoot);
  await cmd('stake', 'top-up', '1', key.authRoot);
  await assert.rejects(() => cmd('stake', 'different-root', '1', id('forged root')), /root is already fixed/);
  const status = await cmd('dao-status', DEMO_SENDER);
  assert.equal(status.authRoot, key.authRoot);
  assert.equal(status.authNonce, 0n);
  assert.equal(key.profile, m.dao.profile);
  assert.equal(key.treasury, m.dao.treasury);
  assert(!Object.hasOwn(key, 'secret'));
  assert.equal(status.unlockAmount, 0n);
  assert.equal(status.activeStake, 0n);
  assert.equal(status.nextStake, BOND);
  assert.equal(status.isBroadcaster, false);
  await assert.rejects(() => stakeWallet.prove(DEMO_SENDER, { kind: 'unstake', amount: BOND + 1n, recipient: DEMO_SENDER }), /exceed scheduled stake/);
  await assert.rejects(() => stakeWallet.prove(DEMO_SENDER, { kind: 'claim', periods: '1', recipient: DEMO_SENDER }), /Period must be closed/);
  await assert.rejects(() => cmd('close', 'too-early', '1'), reverted('InvalidBatch'));
  await f.time(2);
  assert.equal(await get('isBroadcaster', [DEMO_SENDER]), true);
  assert.equal(await get('stakeAt', [DEMO_SENDER, 1n]), 0n);
  await assert.rejects(() => chain.simulate(spec('closePeriods', [25n])), reverted('InvalidBatch'));
  await assert.rejects(() => cmd('release', 'without-authorization', DEMO_SENDER), reverted('StillLocked'));
  assert(!f.a.treasury.abi.some((entry) => entry.type === 'function' && (
    (entry.name === 'requestUnstake' && entry.inputs.length === 1) ||
    (entry.name === 'claim' && entry.inputs.length === 1) ||
    (entry.name === 'releaseStake' && entry.inputs.length === 0))));
});

test('relay floor, cap, exact quoted signer, shape/domain checks and underfunded guard precede proof work', async (t) => {
  const f = await daoFixture('ETH');
  t.after(f.close);
  const { chain, relayChain, relayTxs, wallet, manifest: m } = f;
  const { min, max } = relayLimits(chain.network);
  const relay = f.operator(min);
  assert.throws(() => f.operator(min - 1n), /outside/);
  assert.throws(() => f.operator(max + 1n), /outside/);
  await assert.rejects(() => relay.quote(), /100 active/);
  await f.transfer(BOND);
  await f.stake(BOND, true);
  const note = wallet.newNote(10n ** 16n);
  await wallet.deposit(note.note);
  const old = loadVector('ETH');
  const exit = { ...old.info.exit, root: await wallet.ledger.read('currentRoot'), recipient: DEMO_SENDER,
    amount: 10n ** 15n, feeRecipient: DEMO_RECIPIENT, fee: min, notBefore: (await chain.head()).timestamp / 600n * 600n };
  const sim = (delta, caller = relayChain) => caller.call(wallet.ledger.spec('withdraw', [old.proof, { ...exit, ...delta }]));
  await assert.rejects(() => sim({}), reverted('UnauthorizedBroadcaster'));
  await f.time(2);
  const quote = await relay.quote();
  assert.deepEqual(validateQuote(chain.network, m, quote), { fee: min, feeRecipient: DEMO_RECIPIENT });
  assert.throws(() => validateQuote(chain.network, m, { ...quote, chainId: '1' }), /deployment/);
  assert.throws(() => validateQuote(chain.network, m, { ...quote, fee: max + 1n }), /outside/);
  await assert.rejects(() => wallet.prove(note.note, note.amount, DEMO_SENDER, null, quote), /exceeds the input note/);
  await assert.rejects(() => sim({ fee: min - 1n }), reverted('InvalidRelayFee'));
  await assert.rejects(() => sim({ fee: max + 1n }), reverted('InvalidRelayFee'));
  await assert.rejects(() => sim({ feeRecipient: ZeroAddress }), reverted('InvalidRecipient'));
  await assert.rejects(() => sim({ amount: note.amount }, relayChain), reverted('InsufficientBacking'));
  await assert.rejects(() => sim({ fee: min }, chain), reverted('UnauthorizedBroadcaster'));
  await assert.rejects(() => sim({ fee: max }), reverted('InvalidStarkProof')); // Exact cap admitted by relay guard.
  const request = { ...exitContext(chain.network, m), id: proofHash(old.proof), proof: old.proof, exit };
  assert.throws(() => relay.request({ ...request, value: '1' }), /only the public/);
  assert.throws(() => relay.request({ ...request, vault: m.dao.treasury }), /configured vault/);
  assert.throws(() => relay.request({ ...request, id: ZeroHash }), /hash mismatch/);
  assert.throws(() => relay.request({ ...request, exit: { ...exit, fee: max } }), /quoted fee/);
  assert.throws(() => relay.request({ ...request, exit: { ...exit, feeRecipient: DEMO_SENDER } }), /quoted fee/);
  await assert.rejects(() => relay.submit(request), reverted('InvalidStarkProof'));
  assert.equal(relayTxs.existing(`relay-${request.id}`), null);
  const busy = id('unconfirmed-local-relay');
  relayTxs.store.write('relay-pending.json', { id: busy });
  relayTxs.store.write(`tx-relay-${busy}.json`, { envelope: { hash: id('not a confirmed tx') } });
  await assert.rejects(() => relay.submit(request), /Previous relay is not confirmed/);
});
