import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJournal, openSignerJournal } from '../packages/swap/src/journal.mjs';
import { clearQuote, fundingLots, LOT, MAX_RATE, RATE_SHIFT } from '../packages/swap/src/protocol.mjs';

const Q = 1n << RATE_SHIFT;

test('quote arithmetic floors lot output, refuses dust, overflow and minOut violations', () => {
  const q = { from: 'ETH', to: 'BNB', rate: Q + Q / 2n };
  assert.equal(clearQuote(q, 5n * LOT.ETH, 7n * LOT.BNB), 7n * LOT.BNB);
  assert.throws(() => clearQuote(q, 5n * LOT.ETH, 8n * LOT.BNB), /below minimum/);
  assert.throws(() => clearQuote(q, 5n * LOT.ETH + 1n, 1n * LOT.BNB), /whole lot/);
  assert.throws(() => clearQuote({ ...q, from: 'BTC', rate: MAX_RATE }, LOT.BTC, LOT.BNB), /service minimum/);
  const policy = { rails: { BTC: { fee: 2_000n } } };
  assert.throws(() => fundingLots(policy, 2_900n, 'BTC'), /cannot cover refund/);
  assert.equal(fundingLots(policy, 3_000n, 'BTC'), 30n);
});

test('SQLite CAS, one funding claim, permanent nonce/UTXO reservation and restart safety', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mobubu-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'engine.sqlite');
  const a = openJournal(path, 'deployment');
  const b = openJournal(path, 'deployment');
  t.after(() => { a.close(); b.close(); });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  a.register('a','n1', { id: 'a' });
  assert.throws(() => b.register('b','n1', { id: 'b' }), /nonce/);
  b.register('b','n2', { id: 'b' });
  assert.equal(a.update('a', 0, { phase: 'decide' }, { fundingKey: 'unique-output' }), true);
  assert.throws(() => b.update('b', 0, { phase: 'decide' }, { fundingKey: 'unique-output' }), /already used/);
  assert.equal(a.update('a', 1, { phase: 'signing' }, { resource: 'unique-nonce' }), true);
  assert.equal(b.update('a', 1, { phase: 'outbox' }), false);
  assert.equal(b.update('b', 0, { phase: 'signing' }, { resource: 'unique-nonce' }), false);
  assert.equal(b.get('b').state.phase, 'funding');
  assert.equal(b.claimed('unique-nonce'), true);
  const bytes = { phase: 'outbox', payload: { raw: 'exact-signed-bytes', txid: 'expected-hash' } };
  assert.equal(a.update('a', 2, bytes), true);
  const reopened = openJournal(path, 'deployment');
  try { assert.deepEqual(reopened.get('a').state, bytes); } finally { reopened.close(); }
  assert.throws(() => openJournal(path, 'wrong-deployment'), /another role/);
});

test('cosigner survives restart and will not approve another spend of the same input', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mobubu-cosigner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'signer.sqlite');
  const a = openSignerJournal(path, 'deployment', 'key');
  a.approve('key', 'order', 'tx:0', 'plan');
  a.close();
  const b = openSignerJournal(path, 'deployment', 'key');
  try {
    b.approve('key', 'order', 'tx:0', 'plan');
    assert.throws(() => b.approve('key', 'order', 'tx:1', 'another-plan'), /different spend/);
    assert.throws(() => b.approve('key', 'another-order', 'tx:0', 'new-plan'), /reserved/);
    assert.throws(() => b.approve('other-key', 'order', 'tx:0', 'plan'), /wrong signer/);
  } finally { b.close(); }
});
