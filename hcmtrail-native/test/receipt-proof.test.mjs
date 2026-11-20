import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concat, decodeRlp, encodeRlp, getBytes, hexlify, id, toBeHex, toQuantity, ZeroAddress, ZeroHash } from 'ethers';
import { compileReceiptProof } from '../scripts/build-receipt-proof.mjs';
import { checkpointReceiptEvidence, collectReceiptEvidence, executionHeader, executionReceipt } from '../testnet/receipt-proof.mjs';
import { localEvm } from './local-evm.mjs';

const ETH = 11155111n, BNB = 97n;
const a = compileReceiptProof({ fixtures: true });
const reverted = (name) => (e) => e.data?.startsWith?.(id(`${name}()`).slice(0, 10));
const bytes = (s) => (s.length - 2) / 2;
const fields = (proof) => {
  const raw = getBytes(proof);
  const chunks = [];
  for (let p = 9; p < raw.length;) {
    const n = 256 * raw[p] + raw[p + 1];
    chunks.push(hexlify(raw.slice(p + 2, p + 2 + n)));
    p += n + 2;
  }
  return { prefix: raw.slice(0, 9), frames: chunks };
};
const reframe = ({ prefix, frames }) => concat([prefix, ...frames.flatMap((wire) => [toBeHex(bytes(wire), 2), wire])]);
const patch = (proof, offset, value) => {
  const raw = getBytes(proof);
  raw[offset] = value;
  return hexlify(raw);
};

async function setup(t, chainId) {
  const vm = await localEvm(chainId);
  t.after(vm.close);
  const rpc = (m, p) => vm.provider.send(m, p);
  const probe = await vm.deploy(a.ReceiptProofFixture);
  return { ...vm, chainId, rpc, probe, address: await vm.signer.getAddress() };
}

function send(src, data, opts = {}) {
  return src.rpc('eth_sendTransaction', [{ to: src.probe.target, from: src.address, gas: '0x30d40', data, ...opts }]);
}
const block = (f, tag) => f.rpc('eth_getBlockByNumber', [tag, false]);

async function history(src, count) {
  const snap = await src.rpc('evm_snapshot', []);
  const siblingTx = await send(src, src.probe.interface.encodeFunctionData('report', [id('discarded sibling'), id('side'), false]));
  const siblingReceipt = await src.rpc('eth_getTransactionReceipt', [siblingTx]);
  const sibling = await src.rpc('eth_getBlockByHash', [siblingReceipt.blockHash, false]);
  assert.equal(await src.rpc('evm_revert', [snap]), true);
  const order = id(`receipt experiment ${src.chainId}`), rate = id(`rate ${src.chainId}`);
  const start = BigInt(await src.rpc('eth_getTransactionCount', [src.address, 'latest']));
  await src.rpc('evm_setAutomine', [false]);
  const txs = [];
  try {
    for (let i = 0; i < count; i++) {
      const report = [0, 1, 3, 127, 128].includes(i);
      const data = report ? src.probe.interface.encodeFunctionData('report', [order, rate, i === 3]) : '0x';
      const type = i % 3;
      const fee = type === 2 ? { maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x2540be4' }
        : { gasPrice: '0x77359400', ...(type === 1 ? { accessList: [] } : {}) };
      txs.push(await send(src, data, { nonce: toQuantity(start + BigInt(i)), type: toQuantity(type), ...fee,
        ...(report ? {} : { to: src.address, gas: '0x5208' }) }));
    }
    await src.rpc('evm_mine', []);
  } finally { await src.rpc('evm_setAutomine', [true]); }
  const target = await block(src, 'latest');
  assert.equal(target.number, sibling.number);
  assert.notEqual(target.hash, sibling.hash);
  assert.deepEqual(target.transactions, txs);
  const blockReceipts = await Promise.all(txs.map((hash) => src.rpc('eth_getTransactionReceipt', [hash])));
  const rawProbe = blockReceipts[0];
  assert.equal(rawProbe.status, '0x1');
  if (count > 3) assert.equal(blockReceipts[3].status, '0x0');
  await src.rpc('evm_mine', []);
  const intermediate = await block(src, 'latest');
  await src.rpc('evm_mine', []);
  const checkpoint = await block(src, 'latest');
  return { checkpoint, headers: [checkpoint, intermediate, target], target, order, rate, blockReceipts, sibling };
}

async function verifier(dest, source, checkpoint, options = {}) {
  const genesis = await block(source, '0x0');
  return dest.deploy(a.EvmCheckpointReceiptVerifier, source.chainId, options.genesis ?? genesis.hash,
    options.height ?? BigInt(checkpoint.number), checkpoint.hash, options.emitter ?? source.probe.target,
    options.consumer ?? dest.probe.target, options.mask ?? 15);
}

async function checkDirection(src, dst, count) {
  const h = await history(src, count);
  const adapter = await verifier(dst, src, h.checkpoint);
  const query = (args, p, c = dst.probe, v = adapter) => c.check(v.target, ...args, p);
  assert.equal(await adapter.remoteChain(), src.chainId);
  assert.equal(await adapter.localChain(), dst.chainId);
  assert.equal(await adapter.checkpointHash(), h.checkpoint.hash);
  assert(a.EvmCheckpointReceiptVerifier.abi.filter((e) => e.type === 'function').every((e) => e.stateMutability === 'view'));
  const make = (txIndex, logIndex) => checkpointReceiptEvidence({ ...h, txIndex, logIndex });
  const args = (kind) => [src.chainId, src.probe.target, kind, h.order, kind === 2 || kind === 3 ? h.rate : ZeroHash];
  const samples = count > 128 ? [0, 1, 127, 128] : [0, 1];
  for (const i of samples) for (const kind of [1, 2, 3, 4]) {
    const p = make(i, kind);
    assert.equal(await query(args(kind), p), true);
  }
  const index = samples.at(-1), good = make(index, 2);
  assert.equal(await collectReceiptEvidence(src.rpc, { checkpointHash: h.checkpoint.hash, blockHash: h.target.hash,
    txIndex: index, logIndex: 2 }), good);
  const decoded = fields(good);
  const path = decoded.frames.slice(decoded.prefix[1]).map((n) => decodeRlp(n));
  assert(path.some((n) => n.length === 17));
  if (count > 128) assert(path.some((n) => n.length === 2 && getBytes(n[0])[0] < 0x20)); // extension
  assert.equal(await adapter.proves(...args(2), good), false); // EOA is not the bound consumer

  const reject = (claim, p, consumer, v) => assert.rejects(() => query(claim, p, consumer, v), reverted('UnverifiedEvent'));
  await reject([dst.chainId, ...args(2).slice(1)], good);
  await reject([src.chainId, src.address, ...args(2).slice(2)], good);
  await reject([src.chainId, src.probe.target, 2, id('different order'), h.rate], good);
  await reject([src.chainId, src.probe.target, 2, h.order, id('wrong rate')], good);
  await reject(args(3), good);
  await reject(args(2), patch(good, 6, 0xff)); // wrong transaction index
  await reject(args(2), patch(good, 8, 0)); // marker log, not SettlementMessage
  await reject(args(2), patch(good, 8, Number(BigInt(h.blockReceipts[index].logs[2].logIndex)))); // block-global index
  for (const p of [patch(good, 0, 2), patch(good, 1, 0), patch(good, 1, 34), patch(good, 2, 12), patch(good, 7, 1),
    patch(good, 9, 0xff), patch(good, bytes(good) - 1, 0xbe), good.slice(0, -2), concat([good, '0x80']),
    hexlify(new Uint8Array(65_536))]) await reject(args(2), p);
  const fork = fields(good);
  fork.frames[2] = executionHeader(h.sibling);
  await reject(args(2), reframe(fork)); // same height, wrong ancestor
  const unrelated = await dst.deploy(a.ReceiptProofFixture);
  await reject(args(2), good, unrelated);
  const restricted = await verifier(dst, src, h.checkpoint, { mask: 1 });
  assert.equal(await query(args(1), make(index, 1), dst.probe, restricted), true);
  await reject(args(2), good, dst.probe, restricted);
  const wrongHeight = await verifier(dst, src, h.checkpoint, { height: BigInt(h.checkpoint.number) + 1n });
  await reject(args(2), good, dst.probe, wrongHeight);
  const wrongEmitter = await verifier(dst, src, h.checkpoint, { emitter: src.address });
  await reject([src.chainId, src.address, ...args(2).slice(2)], good, dst.probe, wrongEmitter);
  const atBlock = await verifier(dst, src, h.target);
  assert.equal(await query(args(2), checkpointReceiptEvidence({ ...h, headers: [h.target], txIndex: index, logIndex: 2 }), dst.probe, atBlock), true);

  // Rebuilding the trie is independent of the onchain path verifier; the EDR root checks every receipt.
  const corrupted = [...h.blockReceipts];
  corrupted[0] = { ...corrupted[0], cumulativeGasUsed: '0x1' };
  assert.throws(() => checkpointReceiptEvidence({ ...h, blockReceipts: corrupted, txIndex: index, logIndex: 2 }), /receiptsRoot/);
  assert.throws(() => checkpointReceiptEvidence({ ...h, headers: [h.checkpoint, h.sibling], txIndex: index, logIndex: 2 }), /history/);
  await assert.rejects(() => collectReceiptEvidence(src.rpc, { checkpointHash: h.checkpoint.hash, blockHash: h.sibling.hash,
    txIndex: 0, logIndex: 2 }), /ancestry|header/);
  const gas = await dst.probe.check.estimateGas(adapter.target, ...args(2), good);
  console.log(`${src.chainId} → ${dst.chainId}: ${count} receipts, 3 headers, ${path.length} nodes, ${bytes(good)} B, ${gas} EDR gas`);
}

test('ETH ↔ BNB: actual legacy/typed receipts and header ancestry, no message signatures', async (t) => {
  const eth = await setup(t, ETH), bnb = await setup(t, BNB);
  await checkDirection(eth, bnb, 130);
  await checkDirection(bnb, eth, 4);
  await assert.rejects(() => eth.deploy(a.EvmCheckpointReceiptVerifier, ETH, id('genesis'), 1, id('checkpoint'),
    bnb.probe.target, eth.probe.target, 15), reverted('BadCheckpointRoute'));
  await assert.rejects(() => eth.deploy(a.EvmCheckpointReceiptVerifier, BNB, id('genesis'), 1, id('checkpoint'),
    bnb.probe.target, ZeroAddress, 15), reverted('BadCheckpointRoute'));
});

test('receipt parser enforces RLP, status, typed envelope and log shape', async (t) => {
  const src = await setup(t, ETH);
  const order = id('local parser'), data = id('price observation');
  const tx = await send(src, src.probe.interface.encodeFunctionData('report', [order, data, false]));
  const info = await src.rpc('eth_getTransactionReceipt', [tx]);
  const wire = executionReceipt({ ...info, type: '0x0' });
  const check = (value, index = 2) => src.probe.matchReceipt(value, index, src.probe.target, 2, order, data);
  assert.equal(await check(wire), true);
  for (const type of [1, 2, 3, 4]) assert.equal(await check(concat([toBeHex(type, 1), wire])), true);
  const parts = decodeRlp(wire);
  await assert.rejects(() => check(encodeRlp(['0x', ...parts.slice(1)])), reverted('BadReceipt'));
  await assert.rejects(() => check(encodeRlp(['0x0001', ...parts.slice(1)])), reverted('InvalidRlp'));
  await assert.rejects(() => check(concat(['0x05', wire])), reverted('BadReceipt'));
  await assert.rejects(() => check(concat([wire, '0x80'])), reverted('InvalidRlp'));
  assert.equal(await check(wire, 5), false);
});

test('32 ancestors accepted, later events cannot advance a sealed checkpoint', async (t) => {
  const src = await setup(t, BNB), dst = await setup(t, ETH);
  const order = id('bounded historical proof'), rate = id('bounded rate');
  const data = src.probe.interface.encodeFunctionData('report', [order, rate, false]);
  const hash = await send(src, data);
  const receipt = await src.rpc('eth_getTransactionReceipt', [hash]);
  const target = await block(src, 'latest');
  const headers = [target];
  for (let i = 0; i < 32; i++) {
    await src.rpc('evm_mine', []);
    headers.unshift(await block(src, 'latest'));
  }
  const adapter = await verifier(dst, src, headers[0]);
  const historical = { headers, blockReceipts: [receipt], txIndex: 0, logIndex: 2 };
  const proof = checkpointReceiptEvidence(historical);
  const args = [adapter.target, src.chainId, src.probe.target, 2, order, rate];
  assert.equal(await dst.probe.check(...args, proof), true);
  const later = await send(src, data);
  const laterReceipt = await src.rpc('eth_getTransactionReceipt', [later]);
  const laterBlock = await block(src, 'latest');
  assert.throws(() => checkpointReceiptEvidence({ ...historical, headers: [laterBlock, ...headers] }), /history length/);
  const after = checkpointReceiptEvidence({ headers: [laterBlock], blockReceipts: [laterReceipt], txIndex: 0, logIndex: 2 });
  await assert.rejects(() => dst.probe.check(...args, after), reverted('UnverifiedEvent'));
  assert.equal(await adapter.checkpointHash(), headers[0].hash);
  assert.equal(await dst.probe.check(...args, proof), true);
  const gas = await dst.probe.check.estimateGas(...args, proof);
  console.log(`Bounded ancestry: 33 headers, ${bytes(proof)} B, ${gas} EDR gas`);
});
