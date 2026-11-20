import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Transaction as BitcoinTx, networks, payments, address as btcAddress } from 'bitcoinjs-lib';
import * as secp from 'tiny-secp256k1';
import { Wallet, hexlify, keccak256, parseEther, toBeHex } from 'ethers';
import { makeTfhe } from '../fhe-swap/dist/src/fhe/tfhe.js';
import { createVaultKey } from '../packages/client/src/index.mjs';
import { makePolicy, bitcoinScript, makeBitcoinRail, makeBitcoinCosigner, makeEvmRail, openJournal,
  openSignerJournal, makeSettlement, makeQuoteDesk, encryptQuoteRequest, openQuoteAndSign, newNonce } from '../packages/swap/src/index.mjs';
import { PAY, REFUND, COLLECT, LOT, RATE_SHIFT, encode, pqSign, settlementMessage, verifySwap } from '../packages/swap/src/protocol.mjs';
import { compileContracts } from '../scripts/compile-contracts.mjs';
import { openLocalEvm } from './support/local-evm.mjs';
import { openRegtest } from './support/bitcoin-regtest.mjs';

const Q = 1n << RATE_SHIFT;
const rates = { 'BTC/ETH': 16n * Q, 'BTC/BNB': 128n * Q, 'ETH/BTC': Q / 16n,
  'BNB/BTC': Q / 128n, 'ETH/BNB': 8n * Q + Q / 2n, 'BNB/ETH': Q / 8n };
const sizes = { BTC: 1_000_000n, ETH: parseEther('0.016'), BNB: parseEther('0.128') };
const contractPath = 'contracts/NativeSwapRail.sol';
const testContract = {'RejectEther.sol': 'pragma solidity 0.8.24; contract RejectEther {receive() external payable {revert();}}'};
const publicKeys = [31, 41, 51].map((i) => new Uint8Array(32).fill(i));
const btcRecipient = (secret) => payments.p2wpkh({ pubkey: secp.pointFromScalar(new Uint8Array(32).fill(secret), true), network: networks.regtest }).address;

let btc, eth, bnb, dir, policy, compiled, client, evaluator, quoter, user, gasWallet, now, desk, readers, rails, journal, engine, cosigners, configs;
let loseAck = false;
const closers = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mobubu-swap-test-'));
  chmodSync(dir, 0o700);
  compiled = compileContracts(testContract);
  btc = await openRegtest(process.env.BITCOIND);
  eth = await openLocalEvm(31337n);
  bnb = await openLocalEvm(31338n);
  gasWallet = new Wallet(toBeHex(2n, 32));
  quoter = createVaultKey();
  user = createVaultKey();
  now = Math.floor(Date.now() / 1000);
  const EVM = {};
  for (const [name, evm] of [['ETH', eth], ['BNB', bnb]]) {
    const treasury = createVaultKey();
    const deployment = await evm.deploy(compiled[contractPath].NativeSwapRail, treasury.publicKey);
    const provider = evm.provider;
    await (await deployment.provideLiquidity({ value: parseEther('20') })).wait();
    EVM[name] = { deployment, treasury, provider, payer: await provider.getSigner(0), recipient: await provider.getSigner(2),
      refund: await provider.getSigner(3), rpc: provider.send.bind(provider) };
  }
  configs = EVM;
  const pin = async ({ deployment, treasury, provider }) => ({
    chainId: (await provider.getNetwork()).chainId, genesis: (await provider.getBlock(0)).hash,
    rail: deployment.target, codeHash: keccak256(await provider.getCode(deployment.target)), treasury: treasury.publicKey, depth: 2,
  });
  policy = makePolicy({ quoter: quoter.publicKey, BTC: { network: 'regtest', genesis: `0x${await btc.rpc('getblockhash', [0])}`,
    keys: publicKeys.map((k) => hexlify(secp.pointFromScalar(k, true))), depth: 2, fee: 2_000n },
    ETH: await pin(EVM.ETH), BNB: await pin(EVM.BNB) });
  readers = { BTC: makeBitcoinRail({ policy, rpc: btc.rpc }) };
  rails = { BTC: readers.BTC };
  for (const name of ['ETH','BNB']) {
    const c = EVM[name];
    readers[name] = makeEvmRail({ policy, chain: name, rpc: c.rpc });
    rails[name] = makeEvmRail({ policy, chain: name, gasKey: gasWallet.privateKey, treasurySecret: c.treasury.secretKey,
      maxGasPrice: 100_000_000_000n, rpc: async (method, params) => {
        const result = await c.rpc(method, params);
        if (method === 'eth_sendRawTransaction' && loseAck) { loseAck = false; throw new Error('simulated loss of acknowledgement after native tx accepted'); }
        return result;
      } });
  }
  reopen();
  cosigners = publicKeys.slice(0, 2).map((secret, i) => {
    const key = hexlify(secp.pointFromScalar(secret, true));
    const log = openSignerJournal(join(dir, `cosigner-${i}.sqlite`), policy.id, key);
    closers.push(log.close);
    return makeBitcoinCosigner({ policy, rails: readers, journal: log, secret, now: () => now });
  });
  const initial = await btc.fund(bitcoinScript(policy).address, 10_000_000n);
  await btc.mine(2);
  assert.equal((await engine.addBitcoinReserve(initial)).sats, 10_000_000n);
  ({ crypto: client } = await makeTfhe({ role: 'client', workerPath: process.env.TFHE_WORKER }));
  ({ crypto: evaluator } = await makeTfhe({ role: 'evaluator', cloudKeyPath: client.getCloudPath(), workerPath: process.env.TFHE_WORKER }));
  desk = makeQuoteDesk({ policy, rates, secret: quoter.secretKey, now: () => now });
});
after(async () => {
  evaluator?.close(); client?.close();
  journal?.close(); closers.forEach((close) => close());
  eth?.close(); bnb?.close(); await btc?.close();
  if (dir) rmSync(dir, { force: true, recursive: true });
});

function reopen() {
  journal?.close();
  journal = openJournal(join(dir, 'coordinator.sqlite'), policy.id);
  engine = makeSettlement({ policy, rails, journal, now: () => now });
}
async function signedTrade(from, to, opts = {}) {
  const amountIn = opts.amount ?? sizes[from];
  const minOut = opts.minimum ?? (((amountIn / LOT[from] * rates[`${from}/${to}`]) >> RATE_SHIFT) - 1n) * LOT[to];
  const request = await encryptQuoteRequest({ policy, client, route: { from, to, key: user.publicKey, nonce: newNonce() }, amountIn, minOut });
  const packet = await desk.evaluate(request, evaluator);
  return openQuoteAndSign({ policy, client, request, packet, userSecret: user.secretKey,
    payer: configs[from]?.payer.address, recipient: opts.recipient ?? configs[to]?.recipient.address ?? btcRecipient(58),
    refund: configs[from]?.refund.address ?? btcRecipient(59), now: () => now });
}
async function evmMine(chain) { await configs[chain].provider.send('evm_mine', []); }
async function fund(quote, signed, variation = 0n) {
  const { from } = signed.quote;
  if (from === 'BTC') return btc.fund(quote.funding.address, quote.funding.sats + variation);
  const receipt = await (await configs[from].payer.sendTransaction({ ...quote.funding, gasLimit: 3_200_000n })).wait();
  assert.equal(receipt.status, 1);
  return { txid: receipt.hash, index: receipt.logs[0].index };
}
async function confirm(chain) { if (chain === 'BTC') await btc.mine(2); else await evmMine(chain); }
async function drive(id, { testApprovals = false } = {}) {
  const receipts = [];
  for (let step = 0; step < 19; ++step) {
    let result = await engine.advance(id);
    if (result.status === 'btc_approval_required') {
      const req = JSON.parse(encode(engine.approvalRequest(id))); // Operator file boundary, not shared objects.
      if (testApprovals) {
        const forged = structuredClone(req);
        forged.plan.outputs[0].value = String(BigInt(forged.plan.outputs[0].value) + 1n);
        await assert.rejects(cosigners[0].approve(forged), /signer policy/);
      }
      const partials = await Promise.all(cosigners.map((signer) => signer.approve(req)));
      if (testApprovals) await assert.rejects(engine.advance(id, { partials: [partials[0], partials[0]] }), /duplicate/);
      result = await engine.advance(id, { partials });
    }
    if (result.status === 'broadcast') {
      const { plan } = engine.status(id);
      receipts.push({ chain: plan.chain, kind: plan.kind, txid: result.txid });
      await confirm(plan.chain);
    }
    if (result.status === 'paid' || result.status === 'refunded') return { ...result, receipts };
    assert.ok(['decide','signing','outbox','broadcast','confirming'].includes(result.status), JSON.stringify(result));
  }
  assert.fail(`settlement did not finish: ${engine.status(id).phase}`);
}

for (const [from, to] of Object.keys(rates).map((pair) => pair.split('/'))) test(`${from} → ${to}: FHE quote, PQ order and final native payout`, async (t) => {
  const signed = await signedTrade(from, to);
  assert.throws(() => engine.register({ ...signed, signature: '0x' }), /signature/);
  const quote = engine.register(signed);
  const outBefore = to === 'BTC' ? undefined : await configs[to].provider.getBalance(signed.recipient);
  const credit = await fund(quote, signed);
  assert.equal((await engine.attach(quote.id, credit)).status, 'funding_not_final');
  await confirm(from);
  assert.equal((await engine.attach(quote.id, credit)).status, 'decide');
  await assert.rejects(engine.attach(quote.id, credit), /already/);
  const result = await drive(quote.id, { testApprovals: true });
  assert.equal(result.status, 'paid');
  assert.equal(result.receipts.length, 2);
  const paid = result.receipts.find((r) => r.kind === PAY);
  assert.ok(paid);
  if (to === 'BTC') {
    const native = BitcoinTx.fromHex(await btc.rpc('getrawtransaction', [paid.txid]));
    assert.equal(native.ins[0].witness.length, 4); // NULLDUMMY + 2 ECDSA signatures + witnessScript, accepted by Core.
    assert.equal(hexlify(native.outs[0].script), hexlify(btcAddress.toOutputScript(signed.recipient, networks.regtest)));
    assert.equal(native.outs[0].value, signed.amountOut);
  } else {
    assert.equal(await configs[to].provider.getBalance(signed.recipient), outBefore + signed.amountOut);
    assert.equal(await configs[to].deployment.payoutState(quote.id), 1n);
  }
  if (from !== 'BTC') assert.equal((await configs[from].deployment.credits(quote.id)).state, 3n);
  else assert.equal(await btc.rpc('gettxout', [credit.txid, credit.index]), null);
  assert.equal((await engine.advance(quote.id)).status, 'paid');
  if ((from === 'BTC' && to === 'ETH') || (from === 'ETH' && to === 'BTC')) {
    const stale = openJournal(join(dir, `stale-${from}.sqlite`), policy.id);
    try {
      const other = makeSettlement({ policy, rails, journal: stale, now: () => now });
      other.register(signed);
      await assert.rejects(other.attach(quote.id, credit), /no longer unspent or escrowed/);
    } finally { stale.close(); }
  }
  const gas = to === 'BTC' ? '' : ` gas=${(await configs[to].provider.getTransactionReceipt(paid.txid)).gasUsed}`;
  t.diagnostic(`funding=${credit.txid} payout=${paid.txid} source=${result.txid}${gas}`);
});

test('encrypted minimum above output prevents client authorization', async () => {
  await assert.rejects(signedTrade('ETH','BNB', { minimum: parseEther('1') }), /encrypted output below minimum/);
});

test('recipient rejection on BNB makes BTC refund safe, with signed fee policy', async () => {
  const failing = await bnb.deploy(compiled['RejectEther.sol'].RejectEther);
  const signed = await signedTrade('BTC','BNB', { recipient: failing.target });
  const quote = engine.register(signed), credit = await fund(quote, signed);
  await btc.mine(2);
  await engine.attach(quote.id, credit);
  const result = await drive(quote.id);
  assert.equal(result.status, 'refunded');
  assert.equal(await configs.BNB.deployment.payoutState(quote.id), 2n);
  assert.equal(await bnb.provider.getBalance(failing.target), 0n);
  const raw = BitcoinTx.fromHex(await btc.rpc('getrawtransaction', [result.txid]));
  assert.equal(raw.outs.length, 1);
  assert.equal(raw.outs[0].value, signed.amountIn - policy.rails.BTC.fee);
  assert.equal(hexlify(raw.outs[0].script), hexlify(btcAddress.toOutputScript(signed.refund, networks.regtest)));
});

test('confirmed underpayment never pays destination, refunds observed BTC minus the pinned fee', async () => {
  const signed = await signedTrade('BTC','ETH');
  const quote = engine.register(signed), credit = await fund(quote, signed, -150_000n);
  await btc.mine(2);
  await engine.attach(quote.id, credit);
  const before = await eth.provider.getBalance(signed.recipient);
  const result = await drive(quote.id);
  assert.equal(result.status, 'refunded');
  assert.equal(await eth.provider.getBalance(signed.recipient), before);
  const tx = BitcoinTx.fromHex(await btc.rpc('getrawtransaction', [result.txid]));
  assert.equal(tx.outs[0].value, signed.amountIn - 150_000n - policy.rails.BTC.fee);
});

test('expired order never chooses payout, including after restart', async () => {
  const signed = await signedTrade('ETH','BNB');
  const quote = engine.register(signed), credit = await fund(quote, signed);
  await evmMine('ETH');
  await engine.attach(quote.id, credit);
  const before = await eth.provider.getBalance(signed.refund), clock = now;
  now = quote.payUntil + 1;
  try {
    reopen();
    const result = await drive(quote.id);
    assert.equal(result.status, 'refunded');
    assert.deepEqual(result.receipts.map((r) => r.kind), [REFUND]);
    assert.equal(await eth.provider.getBalance(signed.refund), before + signed.amountIn);
  } finally { now = clock; }
});

test('lost broadcast response and restart reconcile the same signed bytes, never issue a refund', async () => {
  const signed = await signedTrade('BNB','ETH');
  const quote = engine.register(signed), credit = await fund(quote, signed);
  await evmMine('BNB');
  await engine.attach(quote.id, credit);
  assert.equal((await engine.advance(quote.id)).status, 'signing');
  assert.equal((await engine.advance(quote.id)).status, 'outbox');
  const prior = engine.status(quote.id).payload;
  const outBefore = await eth.provider.getBalance(signed.recipient);
  loseAck = true;
  await assert.rejects(engine.advance(quote.id), /loss of acknowledgement/);
  reopen();
  assert.deepEqual(engine.status(quote.id).payload, prior);
  await evmMine('ETH');
  const result = await drive(quote.id);
  assert.equal(result.status, 'paid');
  assert.deepEqual(result.receipts.map((r) => r.kind), [COLLECT]);
  assert.equal(await eth.provider.getBalance(signed.recipient), outBefore + signed.amountOut);
});

test('no confirmed BTC inventory returns exact ETH instead of preparing a BTC signature', async () => {
  const signed = await signedTrade('ETH','BTC');
  const log = openJournal(join(dir, 'no-btc-reserve.sqlite'), policy.id);
  const previous = engine;
  engine = makeSettlement({ policy, rails, journal: log, now: () => now });
  try {
    const q = engine.register(signed), credit = await fund(q, signed);
    await evmMine('ETH');
    await engine.attach(q.id, credit);
    const before = await eth.provider.getBalance(signed.refund);
    const result = await drive(q.id);
    assert.equal(result.status, 'refunded');
    assert.deepEqual(result.receipts.map((r) => r.kind), [REFUND]);
    assert.equal(await eth.provider.getBalance(signed.refund), before + signed.amountIn);
  } finally { engine = previous; log.close(); }
});

test('source BTC reorg after plan selection stops signing and payout', async () => {
  const signed = await signedTrade('BTC','ETH');
  const quote = engine.register(signed), credit = await fund(quote, signed);
  const blocks = await btc.mine(2);
  await engine.attach(quote.id, credit);
  assert.equal((await engine.advance(quote.id)).status, 'signing');
  await btc.rpc('invalidateblock', [blocks[0]]);
  assert.equal((await engine.advance(quote.id)).status, 'funding_not_final');
  assert.equal(engine.status(quote.id).payload, undefined);
  await btc.rpc('reconsiderblock', [blocks[0]]);
  assert.equal((await drive(quote.id)).status, 'paid');
});

test('EVM cannot pay different user terms, and a delayed signed payout expires on-chain', async (t) => {
  const signed = await signedTrade('ETH','BNB');
  const quote = engine.register(signed), credit = await fund(quote, signed);
  await evmMine('ETH');
  await engine.attach(quote.id, credit);
  assert.equal((await engine.advance(quote.id)).status, 'signing');
  assert.equal((await engine.advance(quote.id)).status, 'outbox');
  const order = verifySwap(policy, signed);
  const config = configs.BNB;
  const submitter = await bnb.provider.getSigner(1);
  const wrongRecipient = config.refund.address;
  const authorization = pqSign(config.treasury.secretKey, policy.rails.BNB.treasury,
    settlementMessage(policy.rails.BNB, PAY, order.id, wrongRecipient, order.wire.amountOut, submitter.address));
  // The destination requires the user order even from a properly authorized treasury submitter.
  await assert.rejects(config.deployment.connect(submitter).pay.staticCall(order.wire, wrongRecipient, order.signature, authorization), /revert/);
  const outBefore = await bnb.provider.getBalance(signed.recipient);
  const refundBefore = await eth.provider.getBalance(signed.refund);
  await bnb.provider.send('evm_setNextBlockTimestamp', [quote.payUntil + 1]);
  const result = await drive(quote.id);
  assert.equal(result.status, 'refunded');
  assert.deepEqual(result.receipts.map((r) => r.kind), [PAY, REFUND]);
  assert.equal(await config.deployment.payoutState(quote.id), 2n);
  assert.equal(await bnb.provider.getBalance(signed.recipient), outBefore);
  assert.equal(await eth.provider.getBalance(signed.refund), refundBefore + signed.amountIn);
  t.diagnostic(`expired_payout=${result.receipts[0].txid} refund=${result.txid}`);
});
