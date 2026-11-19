// Opt-in. Fresh proof generation is serial and takes minutes per proof; never connects to a public RPC.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes, hexlify, id, toQuantity, ZeroAddress } from 'ethers';
import { test } from 'node:test';
import { daoFee, HCMT_RELAY_BOND, relayLimits } from '../testnet/dao-policy.mjs';
import { TESTNETS } from '../testnet/networks.mjs';
import { checkProver } from '../testnet/prover.mjs';
import { json } from '../testnet/store.mjs';
import { daoFixture } from './dao-fixture.mjs';
import { DEMO_SENDER } from './testnet-fixture.mjs';

process.umask(0o077);
const prover = checkProver(process.env.NATIVE_STARK_PROVER_DIR);
const assets = (process.env.NATIVE_TESTNET_ASSETS ?? 'ETH,TRX,BNB,HYPE').split(',');
assert(assets.every((a) => Object.hasOwn(TESTNETS, a)));
const cache = mkdtempSync(join(tmpdir(), 'hcmtrail-dao-periodic-'));
const cacheFile = join(cache, 'periodic.top');
process.on('exit', () => rmSync(cache, { recursive: true, force: true }));
const say = (asset, data) => console.log(`${asset} ${json(data).trim()}`);
const selector = (err) => id(`${err}()`).slice(0, 10);
const reverted = (err) => (e) => e.data?.startsWith?.(selector(err)) || e.revert === selector(err);

for (const asset of assets) test(`${asset} HCMT: real bonded withdrawal with DAO fee, payout rollback, recovery and replay refusal`,
  { timeout: 3_900_000 }, async (t) => {
    const f = await daoFixture(asset, (event) => say(asset, event));
    t.after(() => f.close());
    const { chain, relayChain, relayTxs, store, wallet, manifest: m, treasuryView } = f;
    if (existsSync(cacheFile)) copyFileSync(cacheFile, store.path('periodic.top'));
    const fee = relayLimits(chain.network).min;
    const relay = f.operator(fee, chain.network.tvm ? fee : 10n ** 18n); // EVM gas subsidy deliberately enabled in fixture.
    await assert.rejects(() => relay.quote(), /100 active/);
    await f.transfer(HCMT_RELAY_BOND);
    await f.stake(HCMT_RELAY_BOND, true);
    await assert.rejects(() => relay.quote(), /100 active/);
    const gross = chain.network.tvm ? 2_000_003n : 10_000_000_000_000_003n;
    const levy = daoFee(gross);
    const n = wallet.newNote(gross);
    const funded = await wallet.deposit(n.note);
    say(asset, { vault: m.vault, deployments: m.deployments, funded, gross, credited: n.amount, depositFee: levy });
    assert.equal(n.amount, gross - levy);
    assert.equal(await chain.balance(m.dao.treasury), levy);
    assert.equal(await treasuryView('receiptsByPeriod', [1n]), levy);
    assert.equal(await chain.balance(m.vault), n.amount);
    await f.time(2);
    const quote = await relay.quote();
    const receiver = await f.switchReceiver();
    const payout = gross / 2n;
    const plan = await wallet.prove(n.note, payout, receiver.at, prover, quote);
    const request = JSON.parse(json(wallet.exportRelay(plan.exitId)));
    const e = wallet.loadExit(plan.exitId);
    assert(!JSON.stringify(request).includes('"secret"'));
    assert.equal(e.exit.fee, fee);
    assert.deepEqual(Object.keys(request).sort(), ['asset', 'chainId', 'domain', 'exit', 'id', 'proof', 'schema', 'vault']);
    assert(plan.changeNote && store.has(`note-${plan.changeNote}.json`));
    const show = (why, extra) => say(asset, { stage: why, ...extra });
    show('fee-proof', { plan });
    if (!existsSync(cacheFile)) copyFileSync(store.path('periodic.top'), cacheFile);
    const call = (changed = {}, who = relayChain, proof = e.proof) =>
      who.call(wallet.ledger.spec('withdraw', [proof, { ...e.exit, ...changed }]), 'latest');
    await assert.rejects(() => call({}, chain), reverted('UnauthorizedBroadcaster'));
    await assert.rejects(() => call({ fee: 0n, feeRecipient: ZeroAddress }), reverted('InvalidStarkProof'));
    await assert.rejects(() => call({ recipient: DEMO_SENDER }), reverted('InvalidStarkProof'));
    if (asset === 'ETH') {
      await assert.rejects(() => call({ amount: payout + 1n }), reverted('InvalidStarkProof'));
      await assert.rejects(() => call({ fee: fee + 1n }), reverted('InvalidStarkProof'));
    }
    await assert.rejects(() => wallet.withdraw(plan.exitId), /quoted broadcaster/);
    const before = {
      balance: await chain.balance(m.vault), dao: await chain.balance(m.dao.treasury),
      tree: await wallet.ledger.read('currentRoot'), count: await wallet.ledger.read('leafCount'),
    };
    const spec = wallet.ledger.spec('withdraw', [e.proof, e.exit]);
    if (chain.network.tvm) {
      const raw = await f.vm.attach(f.a.vaults[asset].abi, m.vault).raw(getBytes(spec.data), {
        from: relayChain.sender, timestamp: (await chain.head()).timestamp,
      });
      assert(raw.execResult.exceptionError);
      assert.equal(hexlify(raw.execResult.returnValue).slice(0, 10), selector('PayoutFailed'));
      assert.equal(raw.execResult.logs?.length ?? 0, 0);
    } else {
      await assert.rejects(() => call(), reverted('PayoutFailed'));
      const gasPrice = await chain.rpc(chain.network.bigBlocks ? 'eth_bigBlockGasPrice' : 'eth_gasPrice');
      const hash = await chain.rpc('eth_sendTransaction', [{ from: relayChain.sender, to: spec.to, data: spec.data, gas: toQuantity(12_000_000), gasPrice }]);
      const failed = await chain.receipt(hash);
      assert(failed && !failed.ok && failed.logs.length === 0);
    }
    assert.equal(await chain.balance(m.vault), before.balance);
    assert.equal(await wallet.ledger.read('accountedNative'), before.balance);
    assert.equal(await chain.balance(m.dao.treasury), before.dao);
    assert.equal(await treasuryView('receiptsByPeriod', [2n]), 0n);
    assert.equal(await wallet.ledger.read('currentRoot'), before.tree);
    assert.equal(await wallet.ledger.read('leafCount'), before.count);
    for (const nf of e.exit.nullifiers) assert.equal(await wallet.ledger.read('spent', [nf]), false);
    await f.send('allow-payout', receiver.spec('allowPayment'));
    if (!chain.network.tvm) {
      await assert.rejects(() => f.operator(fee).submit(request), /cost threshold/);
      assert.equal(relayTxs.existing(`relay-${e.id}`), null);
    }
    const preflight = await relay.preflight(request);
    const relayBefore = await chain.balance(relayChain.sender);
    const sent = await relay.submit(request);
    show('fee-exit', { preflight, sent });
    const gas = sent.receipt.gasUsed != null ? sent.receipt.gasUsed * sent.receipt.effectiveGasPrice : sent.receipt.feeSun;
    assert.equal(await chain.balance(relayChain.sender) - relayBefore, fee - gas);
    assert.equal(await chain.balance(receiver.at), payout - daoFee(payout));
    assert.equal(await treasuryView('receiptsByPeriod', [2n]), daoFee(payout));
    assert.equal(await chain.balance(m.dao.treasury), levy + daoFee(payout));
    const change = n.amount - payout - fee;
    assert.equal(await chain.balance(m.vault), change);
    assert.equal(await wallet.ledger.read('accountedNative'), change);
    assert.equal(await wallet.ledger.read('leafCount'), before.count + 2n);
    for (const nf of e.exit.nullifiers) assert.equal(await wallet.ledger.read('spent', [nf]), true);
    await assert.rejects(() => call(), reverted('AlreadySpent'));
    assert.equal((await relay.submit(request)).receipt.hash, sent.receipt.hash);
    await assert.rejects(() => relay.preflight(request), /AlreadySpent/);
    const recovered = await wallet.recoverExit(e.id, sent.receipt.hash);
    assert.equal(recovered.changeNote, plan.changeNote);
    rmSync(store.path(`fund-${plan.changeNote}.json`));
    assert.equal((await wallet.recoverNote(plan.changeNote)).index, sent.appendedAt);
    if (asset === 'ETH' || asset === 'TRX') {
      const tail = await wallet.prove(plan.changeNote, change, receiver.at, prover);
      assert.equal(tail.changeNote, null);
      const self = await wallet.withdraw(tail.exitId);
      assert.equal(self.broadcasterFee, 0n);
      assert.equal(self.amount, change - daoFee(change));
      assert.equal(await chain.balance(receiver.at), payout + change - daoFee(payout) - daoFee(change));
      assert.equal(await chain.balance(m.vault), 0n);
      assert.equal(await wallet.ledger.read('accountedNative'), 0n);
      assert.equal(await chain.balance(m.dao.treasury), levy + daoFee(payout) + daoFee(change));
      show('self-exit-recovered-change', { plan: tail, self });
    }
    await f.time(3);
    await f.send('close', f.treasurySpec('closePeriods', [2n]));
    const claimable = await treasuryView('claimable', [relayChain.sender, 2n]);
    assert.equal(claimable, await chain.balance(m.dao.treasury));
    const claim = await f.send('claim', f.treasurySpec('claim', [[2n]]), true);
    assert.equal(await chain.balance(m.dao.treasury), 0n);
    assert.equal(await treasuryView('reservedNative'), 0n);
    show('monthly-reward', { claimable, claim: claim.hash });
  });
