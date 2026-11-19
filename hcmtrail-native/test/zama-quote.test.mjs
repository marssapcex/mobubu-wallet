import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZeroHash } from 'ethers';
import { ANSWERS, ASSETS, MAX_PRICE, SUN_MAX, UNITS, exactQuote, localEvm, setup } from './local-evm.mjs';
import { KIND, MASK128, artifacts, attest, evaluate, fixture, pack, quoteInput, rejects, request } from './zama-quote-fixture.mjs';

const invalid = 'InvalidKMSSignatures';

test('Zama-only deployment: nonpayable, pinned host addresses and no host on the other three native chains', async (t) => {
  const f = await setup();
  t.after(() => f.close());
  const { quote } = artifacts();
  await rejects(f.deploy(quote, f.oracle.target), 'MissingZamaHost');
  for (const chain of [56n, 0x2b6653dcn, 999n]) {
    const vm = await localEvm(chain);
    try { await rejects(vm.deploy(quote, f.oracle.target), 'ZamaProtocolUnsupported'); }
    finally { vm.close(); }
  }
  assert(quote.abi.every(({ stateMutability, type }) => stateMutability !== 'payable' && !['fallback', 'receive'].includes(type)));
});

test('Solidity schedules exact floor quotes on all twelve pairs; ACL outputs belong to the requester', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.book.oracle(), f.oracle.target);
  await rejects(f.deploy(artifacts().quote, f.signer.address), 'WrongOracle');
  let count = 0;
  for (let src = 0; src < ASSETS.length; src++) for (let dst = 0; dst < ASSETS.length; dst++) {
    if (src === dst) continue;
    const debit = src === 2 ? 9_007_199_254_740_993n : UNITS[src] + 1n;
    const expected = exactQuote(src, dst, debit);
    assert.equal(await f.oracle.quote(f.epoch.id, src, dst, debit, expected), expected);
    const { numerator: n, denominator: d, maxDebit } = await f.book.quoteParameters(f.epoch.id, src, dst);
    assert.equal(debit * n / d, expected);
    assert(debit <= maxDebit);
    const packed = pack(f, debit, expected);
    const result = await request(f, packed, quoteInput(f, packed, src, dst));
    assert.deepEqual(evaluate(packed, result), { amount: expected, eligible: true });
    const { q } = result;
    assert.deepEqual([q.epochId, q.src, q.dst, q.validUntil, q.verdict],
      [f.epoch.id, BigInt(src), BigInt(dst), f.epoch.validUntil, 0n]);
    assert.equal(q.requester, f.signer.address);
    for (const h of [q.amount, q.eligible]) {
      assert(await f.acl.persistent(h, f.signer.address));
      assert(await f.acl.persistent(h, f.book.target));
      assert.equal(await f.acl.isAllowed(h, f.reader.address), false);
      assert.equal(await f.acl.isAllowedForDecryption(h), false);
    }
    for (const h of packed.handles) {
      assert.equal(await f.acl.isAllowed(h, f.book.target), false);
      assert.equal(await f.acl.isAllowed(h, f.signer.address), false);
      assert.equal(await f.acl.isAllowedForDecryption(h), false);
    }
    count++;
  }
  assert.equal(count, 12);
  await assert.rejects(f.provider.call({ from: f.signer.address, to: f.book.target, value: 1n }));
  assert.equal(await f.provider.getBalance(f.book.target), 0n);
});

test('encrypted reject never wraps into a payable quote; exact minimum, zero, source/destination caps and product envelope', async (t) => {
  const f = await fixture(t);
  const run = async (src, dst, debit, minimum, expected) => {
    const packed = pack(f, debit, minimum);
    const result = await request(f, packed, quoteInput(f, packed, src, dst));
    assert.deepEqual(evaluate(packed, result), { amount: expected, eligible: expected > 0n });
  };
  await run(0, 1, 0n, 0n, 0n);
  await run(0, 2, 1n, 0n, 0n); // positive debit, zero payout in sun
  await run(0, 1, 13n, exactQuote(0, 1, 13n) + 1n, 0n);
  await run(0, 1, 13n, MASK128, 0n);
  await run(2, 0, SUN_MAX, 0n, exactQuote(2, 0, SUN_MAX));
  await run(2, 0, SUN_MAX + 1n, 0n, 0n);
  const dest = await f.book.quoteParameters(f.epoch.id, 0, 2);
  await run(0, 2, dest.maxDebit, 0n, SUN_MAX);
  assert(exactQuote(0, 2, dest.maxDebit + 1n) > SUN_MAX);
  await run(0, 2, dest.maxDebit + 1n, 0n, 0n);
  const product = await f.book.quoteParameters(f.epoch.id, 0, 3);
  assert.equal(product.maxDebit, MASK128 / product.numerator);
  const payout = exactQuote(0, 3, product.maxDebit);
  await run(0, 3, product.maxDebit, payout, payout);
  const wrap = product.maxDebit + 10n;
  assert(((wrap * product.numerator) & MASK128) / product.denominator > 0n);
  await run(0, 3, wrap, 0n, 0n);
});

test('unsupported wide rate is explicit, not a narrowed denominator or approximate price', async (t) => {
  const f = await fixture(t);
  const answers = [10n ** 18n + 3n, 73n, MAX_PRICE - 1n, 49n];
  const start = await f.timestamp();
  for (let i = 0; i < 4; ++i) {
    await (await f.feeds[i].setDecimals(18)).wait();
    await f.report(f.feeds[i], 11, answers[i], start);
  }
  const policy = f.policy.map(([address, age, , min, max]) => [address, age, 18, min, max]);
  const oracle = await f.deploy(f.artifact, f.args[0], policy, ...f.args.slice(2));
  await (await oracle.refresh()).wait();
  const { id } = await oracle.activeEpoch();
  const book = await f.deploy(artifacts().quote, oracle.target);
  assert.equal(await oracle.quote(id, 0, 2, 10n ** 19n, 0n), 9n);
  await rejects(book.quoteParameters(id, 0, 2), 'UnsupportedRate');
});

test('encrypted input proof must cover both typed handles and exactly this caller and contract', async (t) => {
  const f = await fixture(t);
  const packed = pack(f, 1_000n, 1n);
  const input = quoteInput(f, packed, 0, 1);
  const quote = (i, p = packed.proof) => f.book.requestQuote.staticCall(i, p);
  await rejects(quote(input, '0x'), 'MissingEncryptedInput');
  await rejects(quote({ ...input, debit: ZeroHash }), 'MissingEncryptedInput');
  await rejects(quote({ ...input, minOut: ZeroHash }), 'MissingEncryptedInput');
  await rejects(quote({ ...input, dst: 0 }), 'SameAsset');
  await rejects(quote({ ...input, epochId: ZeroHash }), 'EpochChanged');
  await assert.rejects(quote({ ...input, src: 4 }));
  await rejects(f.book.connect(f.reader).requestQuote.staticCall(input, packed.proof), 'BadInputProof');
  const other = await f.deploy(artifacts().quote, f.oracle.target);
  await rejects(other.requestQuote.staticCall(input, packed.proof), 'BadInputProof');
  const altered = pack(f, 1n, 0n);
  await rejects(quote({ ...input, minOut: altered.handles[1] }), 'BadInputProof');
  const wrongType = pack(f, 1n, 0n, { kinds: [KIND.bool, KIND.uint128] });
  await rejects(quote(quoteInput(f, wrongType, 0, 1), wrongType.proof), 'WrongType');
});

test('optional eligibility callback verifies the stored bit, binds each operation and consumes the result once', async (t) => {
  const f = await fixture(t);
  const packed = pack(f, 13n, exactQuote(0, 1, 13n));
  const input = quoteInput(f, packed, 0, 1, true);
  const first = await request(f, packed, input);
  const second = await request(f, packed, input); // Same epoch, input proof, operands, requester, ACL mode.
  const privateQuote = await request(f, packed, { ...input, publishEligibility: false });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.q.eligible, second.q.eligible);
  assert.notEqual(first.q.eligible, privateQuote.q.eligible);
  assert.equal(evaluate(packed, first).eligible, true);
  assert(await f.acl.isAllowedForDecryption(first.q.eligible));
  assert.equal(await f.acl.isAllowedForDecryption(first.q.amount), false);
  assert.equal(await f.acl.isAllowedForDecryption(privateQuote.q.eligible), false);
  const relay = f.book.connect(f.reader);
  const check = (...args) => relay.confirmEligibility.staticCall(...args);
  const accept = attest(f, first.q.eligible, true);
  await rejects(check(ZeroHash, true, accept), 'UnknownQuote');
  await rejects(check(privateQuote.id, true, accept), 'PrivateEligibility');
  await rejects(check(second.id, true, accept), invalid);
  await rejects(check(first.id, false, accept), invalid);
  await rejects(check(first.id, true, '0x'), invalid);
  await rejects(check(first.id, true, attest(f, first.q.eligible, true, 'one')), invalid);
  await rejects(check(first.id, true, attest(f, first.q.eligible, true, 'duplicate')), invalid);
  assert.equal((await f.book.quotes(first.id)).verdict, 0n);
  await (await relay.confirmEligibility(first.id, true, accept)).wait();
  assert.equal((await f.book.quotes(first.id)).verdict, 2n);
  await rejects(check(first.id, true, accept), 'AlreadyConfirmed');

  const misses = pack(f, 13n, exactQuote(0, 1, 13n) + 1n);
  const fail = await request(f, misses, quoteInput(f, misses, 0, 1, true));
  const result = evaluate(misses, fail);
  assert.equal(result.eligible, false);
  await (await relay.confirmEligibility(fail.id, false, attest(f, fail.q.eligible, result.eligible))).wait();
  assert.equal((await f.book.quotes(fail.id)).verdict, 1n);
});

test('unrefreshed feeds, an equal-rate replacement epoch and the exact expiry boundary cannot confirm an old request', async (t) => {
  const f = await fixture(t);
  const packed = pack(f, UNITS[0], 0n);
  const input = quoteInput(f, packed, 0, 1, true);
  const old = await request(f, packed, input);
  const sig = attest(f, old.q.eligible, true);
  await f.report(f.feeds[0], 11, ANSWERS[0], f.start); // Same price, new round; still invalidates the epoch.
  await rejects(f.book.confirmEligibility.staticCall(old.id, true, sig), 'EpochChanged');
  await rejects(f.book.requestQuote.staticCall(input, packed.proof), 'EpochChanged');
  const epoch = await f.publish();
  const next = await request(f, packed, { ...input, epochId: epoch.id });
  assert.notEqual(next.q.eligible, old.q.eligible);
  await rejects(f.book.confirmEligibility.staticCall(next.id, true, sig), invalid);
  await rejects(f.book.confirmEligibility.staticCall(old.id, true, sig), 'EpochChanged');
  await f.setTime(Number(epoch.validUntil));
  await rejects(f.book.confirmEligibility.staticCall(next.id, true, attest(f, next.q.eligible, true)), 'EpochExpired');
  await rejects(f.book.quoteParameters(epoch.id, 0, 1), 'EpochExpired');
  assert.equal((await f.book.quotes(next.id)).verdict, 0n);
});
