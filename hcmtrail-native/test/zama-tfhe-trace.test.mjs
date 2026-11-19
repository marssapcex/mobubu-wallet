import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { KIND, OP, attest, fixture, pack, quoteInput, request } from './zama-quote-fixture.mjs';

const hex = (n) => `0x${n.toString(16)}`;
const width = { [KIND.bool]: 1, [KIND.uint128]: 128, [KIND.uint256]: 256 };

// EVM sends only handles; the evaluator receives emitted operations, never a handcrafted quote formula.
function replay(binary, packed, result) {
  const positions = new Map(packed.handles.map((h, i) => [h, i]));
  const index = (handle) => {
    assert(positions.has(handle), `unavailable ciphertext ${handle}`);
    return positions.get(handle);
  };
  const rows = result.operations.map(({ out, op, kind, a, b, control, scalar }, i) => {
    const isConstant = Number(op) === OP.constant;
    const scalarOperand = scalar === '0x01';
    const row = [op, width[Number(kind)], isConstant ? a : index(a), scalarOperand ? b : index(b),
      Number(op) === OP.select ? index(control) : 0, scalarOperand ? 1 : 0].join(' ');
    positions.set(out, i + packed.handles.length);
    return row;
  });
  const header = [...packed.values.values()].map(hex).concat(rows.length).join(' ');
  const input = `${header}\n${rows.join('\n')}\n${index(result.q.amount)} ${index(result.q.eligible)}\n`;
  const [amount, eligible] = execFileSync(binary, { input, encoding: 'utf8', timeout: 300_000 }).trim().split(' ');
  assert(eligible === '0x0' || eligible === '0x1', 'Expected a decrypted bit');
  return { amount: BigInt(amount), eligible: eligible === '0x1' };
}

test('bootstrapped TFHE follows the Solidity trace and the EVM accepts only the attested bit', async (t) => {
  const binary = process.env.TFHE_TRACE_EVALUATOR;
  assert(binary, 'Use npm run test:fhe:trace to build the pinned CGGI evaluator.');
  const f = await fixture(t);
  // Exact 5/3 after the fixed fee. A non-power-of-two denominator exercises encrypted division.
  await f.report(f.feeds[0], 11, 50_00000000n, f.start);
  await f.report(f.feeds[1], 11, 29_910000n, f.start);
  f.epoch = await f.publish();
  const params = await f.book.quoteParameters(f.epoch.id, 0, 1);
  assert.deepEqual([params.numerator, params.denominator], [5n, 3n]);
  const debit = 1_000_000_000_000_000_007n;
  const amount = await f.oracle.quote(f.epoch.id, 0, 1, debit, 0n);
  for (const eligible of [true, false]) {
    const packed = pack(f, debit, eligible ? amount : amount + 1n);
    const result = await request(f, packed, quoteInput(f, packed, 0, 1, true));
    const decrypted = replay(binary, packed, result);
    assert.deepEqual(decrypted, { amount: eligible ? amount : 0n, eligible });
    const proof = attest(f, result.q.eligible, decrypted.eligible);
    await (await f.book.connect(f.reader).confirmEligibility(result.id, decrypted.eligible, proof)).wait();
    assert.equal((await f.book.quotes(result.id)).verdict, eligible ? 2n : 1n);
    assert.equal(await f.acl.isAllowedForDecryption(result.q.amount), false);
    t.diagnostic(`128-bit TFHE trace: ${result.operations.length} operations, ${result.receipt.gasUsed} gas (fixture), verdict ${eligible}`);
  }
});
