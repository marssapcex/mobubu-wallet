import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVaultKey } from '../packages/client/src/index.mjs';
import { makeTfhe } from '../fhe-swap/dist/src/fhe/tfhe.js';
import { hexlify } from 'ethers';
import * as secp from 'tiny-secp256k1';
import { openRegtest } from './support/bitcoin-regtest.mjs';
import { makeBitcoinPoolIntake } from '../packages/pool/src/bitcoin.mjs';
import { createNote, emptyNodes, merkleRoot, parseAmount } from '../packages/pool/src/notes.mjs';
import { encryptWithdrawal, makeWithdrawalQuoteDesk, openWithdrawalQuote } from '../packages/pool/src/withdrawal-quote.mjs';
import { prepareQuotedExit } from '../packages/pool/src/spend.mjs';
import { makePolicy, newNonce } from '../packages/swap/src/protocol.mjs';

const fixed = (b, length = 32) => '0x' + b.repeat(length);
test('Bitcoin Core observes exact sats for a finalized P2WSH note intake, no price or secret supplied', async () => {
  const core = await openRegtest(process.env.BITCOIND);
  try {
    const config = { genesis: fixed('12'), rail: fixed('ab',20), codeHash: fixed('23'), treasury: fixed('34'), depth: 2 };
    const policy = makePolicy({ quoter: fixed('67'), BTC: { network: 'regtest', depth: 2, fee: 2_000n,
      genesis: '0x' + await core.rpc('getblockhash', [0]), keys: [27,31,35].map((i) => hexlify(secp.pointFromScalar(new Uint8Array(32).fill(i), true))) },
      ETH: { ...config, chainId: 31_337 }, BNB: { ...config, chainId: 31_338 } });
    const btc = await makeBitcoinPoolIntake({ policy, rpc: core.rpc });
    const satoshis = parseAmount('0.01234567', 'BTC');
    const note = await createNote({ asset: 'BTC', domain: btc.domain, value: satoshis });
    const deposit = await core.fund(await btc.funding(note.key), satoshis);
    assert.equal(await btc.observe(note.key, deposit), null);
    await core.mine(2);
    const finalized = await btc.observe(note.key, deposit);
    assert.equal(finalized.value, satoshis);
    assert.equal(finalized.leaf, note.leaf);
    await assert.rejects(btc.observe(fixed('99'), deposit), /script/);
    await core.rpc('invalidateblock', [finalized.anchor]);
    assert.equal(await btc.observe(note.key, deposit), null);
  } finally { await core.close(); }
});

test('real CGGI withdrawal quote computes exact native amounts above 64 bits and checks minOut', async (t) => {
  const { crypto: client } = await makeTfhe({ role: 'client', workerPath: process.env.TFHE_WORKER });
  t.after(() => client.close());
  const { crypto: cloud } = await makeTfhe({ role: 'evaluator', cloudKeyPath: client.getCloudPath(), workerPath: process.env.TFHE_WORKER });
  t.after(() => cloud.close());
  const { publicKey, secretKey } = createVaultKey();
  t.after(() => secretKey.fill(0));
  const amount = parseAmount('100.000000000000000001', 'ETH'), exact = amount * 3n / 2n;
  const now = () => 1_794_960_001;
  const desk = makeWithdrawalQuoteDesk({ key: publicKey, secret: secretKey, resolveRate: () => ({ numerator: 3n, denominator: 2n, rateRef: fixed('d0'), validUntil: now() + 120 }), now });
  const withdrawal = { from: 'ETH', to: 'BNB', source: fixed('01'), destination: fixed('02'), nonce: newNonce() };
  const call = async (minimum) => {
    const request = await encryptWithdrawal({ client, withdrawal, amount, minimum });
    const reply = await desk.evaluate(request, cloud);
    return { client, request, reply, deskKey: publicKey, now };
  };
  const pack = await call(exact);
  const quote = await openWithdrawalQuote(pack);
  assert.equal(quote.debit, amount);
  assert.equal(quote.out, exact);
  assert.equal(quote.expires, now() + 120);
  assert.equal(quote.rateRef, fixed('d0'));
  await assert.rejects(openWithdrawalQuote({ ...pack, reply: { ...pack.reply, terms: { ...pack.reply.terms, rateRef: fixed('d1') } } }), /invalid withdrawal quote transcript/);
  await assert.rejects(openWithdrawalQuote({ ...pack, now: () => pack.reply.terms.expires }), /expired/);
  const { source, destination } = withdrawal;
  const note = await createNote({ asset: 'ETH', domain: source, value: amount + 13n });
  const siblings = (await emptyNodes()).slice(0, 20), anchor = { index: 0, count: 1, siblings,
    root: await merkleRoot(note.leaf, 0, siblings, 1) };
  const mix = { ...pack, note, anchor, policy: { rails: { BNB: { rail: fixed('07',20) } } }, targetDomain: destination,
    recipient: fixed('09',20), submitter: fixed('0a',20), deadline: now() + 100 };
  const exit = await prepareQuotedExit(mix);
  assert.equal(exit.terms.amountOut, exact);
  assert.equal(exit.changeNote.value, '13');
  assert.equal(exit.terms.quote, quote.id);
  assert.equal(exit.terms.destination, destination);
  assert.ok(!Object.keys(exit).includes('witness') && !Object.keys(exit).includes('changeNote'));
  await assert.rejects(prepareQuotedExit({ ...mix, targetDomain: source }), /selected pools/);
  const short = await createNote({ asset: 'ETH', domain: source, value: amount - 1n });
  await assert.rejects(prepareQuotedExit({ ...mix, note: short }), /exceeds this note/);
  await assert.rejects(openWithdrawalQuote({ ...pack, reply: { ...pack.reply, terms: { ...pack.reply.terms, destination: fixed('03') } } }), /wrong/);
  await assert.rejects(openWithdrawalQuote(await call(exact + 1n)), /encrypted minimum/);
  // Exercise >128 evaluation without decryption or truncation of higher bits.
  const wide = await cloud.mulConst(pack.request.amount, (1n << 63n), 160);
  const hi = await client.decrypt(await cloud.shr(wide, 96));
  assert.equal(hi, (amount << 63n) >> 96n);
});
