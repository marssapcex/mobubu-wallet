import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AbiCoder, id, sha256, toUtf8Bytes } from 'ethers';
import { AGE, ANSWERS, ASSETS, EVM_MAX, FEE, GRACE, MAX_PRICE, NO_EPOCH, PRICES18, SKEW, SUN_MAX, UNITS,
  ZERO, exactQuote, localEvm, setup } from './local-evm.mjs';

async function testFixture(t, options) {
  const fixture = await setup(options);
  t.after(() => fixture.close());
  return fixture;
}
const expectRevert = (promise, name) => assert.rejects(promise, (error) => error.revert?.name === name ||
  error.reason?.includes(name) || error.shortMessage?.includes(name));
const emitEpoch = (oracle) => oracle.refresh().then((tx) => tx.wait());
const BASE_ROUND = 10n;

test('one immutable, nonpayable oracle; exactly four native assets and no caller-specified units', async (t) => {
  const f = await testFixture(t);
  assert.deepEqual(await Promise.all(ASSETS.map(async (_, i) => [...await f.oracle.nativeAssetInfo(i)])), [
    [1n, 10n ** 18n, EVM_MAX], [56n, 10n ** 18n, EVM_MAX], [0x2b6653dcn, 10n ** 6n, SUN_MAX], [999n, 10n ** 18n, EVM_MAX],
  ]);
  assert.equal(await f.oracle.oracleChainId(), 31337n);
  await assert.rejects(f.oracle.nativeAssetInfo(4));
  assert.equal((await f.oracle.publishedEpoch()).id, NO_EPOCH);
  await expectRevert(f.oracle.activeEpoch(), 'NoEpoch');
  const names = f.artifact.abi.filter((e) => e.type === 'function').map((e) => e.name).sort();
  assert.deepEqual(names, ['activeEpoch', 'feeBps', 'feedConfig', 'maxTimestampSkew', 'nativeAssetInfo', 'oracleChainId',
    'oracleDomain', 'publishedEpoch', 'quote', 'refresh', 'sequencerFeed', 'sequencerGrace']);
  assert.ok(f.artifact.abi.every((e) => e.stateMutability !== 'payable'));
  assert.equal(f.oracle.interface.getFunction('refresh').inputs.length, 0);
  await assert.rejects(f.provider.call({ from: f.signer.address, to: f.oracle.target, value: 1n }));
  assert.equal(await f.provider.getBalance(f.oracle.target), 0n);
});

test('constructor rejects wrong domain, EOA, incorrect decimals, duplicate proxy and invalid policy', async (t) => {
  const f = await testFixture(t);
  const replace = (proxy) => [f.args[0], [proxy, ...f.policy.slice(1)], ...f.args.slice(2)];
  await assert.rejects(f.deploy(f.artifact, f.args[0] + 1n, ...f.args.slice(1)));
  await assert.rejects(f.deploy(f.artifact, ...replace([f.signer.address, ...f.policy[0].slice(1)])));
  await assert.rejects(f.deploy(f.artifact, ...replace([f.policy[0][0], AGE, 9, 1n, MAX_PRICE])));
  await assert.rejects(f.deploy(f.artifact, ...replace([f.policy[0][0], AGE, 8, 5n, 4n])));
  await assert.rejects(f.deploy(f.artifact, ...replace(f.policy[1])));
  await assert.rejects(f.deploy(f.artifact, f.args[0], f.policy, 0, FEE, ZERO, 0));
  await assert.rejects(f.deploy(f.artifact, f.args[0], f.policy, SKEW, 10_000, ZERO, 0));
  await assert.rejects(f.deploy(f.artifact, f.args[0], f.policy, SKEW, FEE, ZERO, GRACE));
  const op = await localEvm(10n);
  t.after(() => op.close());
  // No OP pricing hub can be constructed without an uptime feed.
  await assert.rejects(op.deploy(f.artifact, 10, f.policy, SKEW, FEE, ZERO, 0));
});

test('permissionless refresh is idempotent, domain-bound and matches its independent ABI hash', async (t) => {
  const f = await testFixture(t);
  const keeper = await f.provider.getSigner(1);
  const tx = await (await f.oracle.connect(keeper).refresh()).wait();
  const event = f.oracle.interface.parseLog(tx.logs[0]);
  assert.equal(event.name, 'EpochPublished');
  const epoch = await f.oracle.activeEpoch();
  assert.equal(epoch.id, event.args.id);
  assert.equal(epoch.publishedAt, BigInt((await f.provider.getBlock(tx.blockNumber)).timestamp));
  assert.equal(epoch.validUntil, BigInt(f.start + AGE));
  assert.deepEqual(epoch.rounds.map((r) => [...r]), PRICES18.map((p) => [BASE_ROUND, p, BigInt(f.start)]));
  const coder = AbiCoder.defaultAbiCoder();
  const domain = sha256(coder.encode(['bytes32', 'uint256', 'address', 'tuple(address,uint32,uint8,uint80,uint80)[4]',
    'uint32', 'uint16', 'address', 'uint32'], [sha256(toUtf8Bytes('hcmtrail.native.price-epochs.v1')), 31337,
    f.oracle.target, f.policy, SKEW, FEE, ZERO, 0]));
  assert.equal(await f.oracle.oracleDomain(), domain);
  const expectedId = sha256(coder.encode(['bytes32', 'uint64', 'tuple(uint80,uint80,uint64)[4]'],
    [domain, epoch.validUntil, epoch.rounds]));
  assert.equal(epoch.id, expectedId);
  const duplicate = await emitEpoch(f.oracle);
  assert.equal(duplicate.logs.length, 0);
  assert.equal((await f.oracle.activeEpoch()).publishedAt, epoch.publishedAt);

  const second = await f.deploy(f.artifact, ...f.args);
  await emitEpoch(second);
  assert.notEqual(await second.oracleDomain(), domain);
  await expectRevert(second.quote(epoch.id, 0, 1, UNITS[0], 0), 'EpochChanged');
});

test('12 native reference routes match exact integer floor with decimals, fee and minOut', async (t) => {
  const f = await testFixture(t);
  await emitEpoch(f.oracle);
  const { id: epoch } = await f.oracle.activeEpoch();
  let routes = 0;
  for (let src = 0; src < ASSETS.length; src++) for (let dst = 0; dst < ASSETS.length; dst++) {
    if (src === dst) continue;
    for (const debit of [UNITS[src], UNITS[src] * 17n / 13n, UNITS[src] + 1n]) {
      const expected = exactQuote(src, dst, debit);
      const payout = await f.oracle.quote(epoch, src, dst, debit, expected);
      assert.equal(payout, expected, `${ASSETS[src]} → ${ASSETS[dst]} (${debit})`);
    }
    routes++;
  }
  assert.equal(routes, 12);
  assert.equal(await f.oracle.quote(epoch, 2, 0, 1, 0), 106756952n); // 1 sun, keep sub-USD precision.
  const out = exactQuote(0, 3, UNITS[0]);
  assert.equal(await f.oracle.quote(epoch, 0, 3, UNITS[0], out), out);
  await expectRevert(f.oracle.quote(epoch, 0, 3, UNITS[0], out + 1n), 'MinimumNotMet');
  await expectRevert(f.oracle.quote(id('another oracle'), 0, 3, UNITS[0], 0), 'EpochChanged');
});

test('range checks reject dust, invalid routes and out-of-range input or output', async (t) => {
  const f = await testFixture(t);
  await emitEpoch(f.oracle);
  const { id: epoch } = await f.oracle.activeEpoch();
  await expectRevert(f.oracle.quote(epoch, 0, 0, 1, 0), 'SameAsset');
  await expectRevert(f.oracle.quote(epoch, 0, 1, 0, 0), 'InvalidDebit');
  await expectRevert(f.oracle.quote(epoch, 2, 0, SUN_MAX + 1n, 0), 'InvalidDebit');
  await expectRevert(f.oracle.quote(epoch, 0, 1, EVM_MAX + 1n, 0), 'InvalidDebit');
  await expectRevert(f.oracle.quote(epoch, 0, 2, 1, 0), 'UnpayableAmount');
  await expectRevert(f.oracle.quote(epoch, 0, 1, EVM_MAX, 0), 'UnpayableAmount');
  assert.equal(await f.oracle.quote(epoch, 1, 0, EVM_MAX, 0), exactQuote(1, 0, EVM_MAX));

  // A low TRX price and a high source price would overflow signed int64 sun before violating uint256.
  await f.report(f.feeds[0], 11, 10n ** 14n, f.start);
  await f.report(f.feeds[2], 11, 1n, f.start);
  await emitEpoch(f.oracle);
  await expectRevert(f.oracle.quote((await f.oracle.activeEpoch()).id, 0, 2, EVM_MAX, 0), 'UnpayableAmount');
});

test('an advanced feed invalidates the current quote before a keeper refresh; no old rate can be selected', async (t) => {
  const f = await testFixture(t);
  await emitEpoch(f.oracle);
  const old = await f.oracle.activeEpoch();
  await f.report(f.feeds[3], 11n, ANSWERS[3] * 2n, await f.timestamp());
  await expectRevert(f.oracle.quote(old.id, 0, 3, UNITS[0], 0), 'EpochChanged');
  assert.equal((await f.oracle.publishedEpoch()).id, old.id);
  await emitEpoch(f.oracle);
  const fresh = await f.oracle.activeEpoch();
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.validUntil, old.validUntil); // Other assets still bound the expiry.
  await expectRevert(f.oracle.quote(old.id, 0, 3, UNITS[0], 0), 'EpochChanged');
  await f.report(f.feeds[3], 10, ANSWERS[3], f.start);
  await expectRevert(f.oracle.refresh.staticCall(), 'NonMonotonicRound');
  await f.report(f.feeds[3], 11, ANSWERS[3], Number(fresh.rounds[3].updatedAt));
  await expectRevert(f.oracle.refresh.staticCall(), 'NonMonotonicRound');
  await f.report(f.feeds[3], 12, ANSWERS[3], f.start);
  await expectRevert(f.oracle.refresh.staticCall(), 'NonMonotonicRound');
  assert.equal((await f.oracle.publishedEpoch()).id, fresh.id);
});

test('rejects stale/future/zero/negative/out-of-bounds and unavailable Chainlink answers', async (t) => {
  const f = await testFixture(t);
  const feed = f.feeds[2];
  async function fail(round, value, time, error) {
    await f.report(feed, round, value, time);
    await expectRevert(f.oracle.refresh.staticCall(), error);
  }
  await fail(0, ANSWERS[2], f.start, 'InvalidRound');
  await fail(10, 0, f.start, 'InvalidRound');
  await fail(10, -1, f.start, 'InvalidRound');
  await fail(10, 1, 0, 'InvalidRound');
  await fail(10, 1, f.start + AGE * 2, 'InvalidRound');
  await fail(10, (1n << 255n) - 1n, f.start, 'PriceOutsideBounds');
  await fail(10, ANSWERS[2], f.start - AGE, 'StaleRound');
  await fail(10, ANSWERS[2], f.start - SKEW - 1, 'TimestampSkew');
  await f.report(feed, 10, ANSWERS[2], f.start - SKEW);
  await emitEpoch(f.oracle);
  assert.equal((await f.oracle.activeEpoch()).validUntil, BigInt(f.start - SKEW + AGE));

  await (await feed.setOffline(true)).wait();
  await expectRevert(f.oracle.activeEpoch(), 'NO_DATA');
  await (await feed.setOffline(false)).wait();
  await (await feed.setDecimals(8)).wait();
  await expectRevert(f.oracle.activeEpoch(), 'FeedDecimalsChanged');
});

test('expiry is exclusive at the original report time; repeated refresh does not renew it', async (t) => {
  const f = await testFixture(t);
  await emitEpoch(f.oracle);
  const before = await f.oracle.activeEpoch();
  await f.setTime(Number(before.validUntil) - 1);
  assert.equal(await f.oracle.refresh.staticCall(), before.id);
  await f.setTime(Number(before.validUntil));
  await expectRevert(f.oracle.activeEpoch(), 'EpochExpired');
  await expectRevert(f.oracle.refresh.staticCall(), 'StaleRound');
});

test('optional L2 uptime feed blocks downtime, grace period and pre-recovery quotes', async (t) => {
  const f = await testFixture(t, { sequencer: true });
  await emitEpoch(f.oracle);
  const before = await f.oracle.activeEpoch();
  await f.report(f.seq, 2, 1, await f.timestamp());
  await expectRevert(f.oracle.activeEpoch(), 'SequencerUnavailable');
  const recovered = await f.timestamp();
  await f.report(f.seq, 3, 0, recovered);
  await expectRevert(f.oracle.refresh.staticCall(), 'SequencerUnavailable');
  await f.setTime(recovered + GRACE);
  await expectRevert(f.oracle.refresh.staticCall(), 'SequencerUnavailable');
  await f.setTime(recovered + GRACE + 1);
  await expectRevert(f.oracle.refresh.staticCall(), 'StaleRound');
  for (let i = 0; i < f.feeds.length; i++) await f.report(f.feeds[i], 11, ANSWERS[i], recovered);
  await emitEpoch(f.oracle);
  assert.notEqual((await f.oracle.activeEpoch()).id, before.id);
});
