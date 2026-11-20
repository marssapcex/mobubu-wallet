import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface, getAddress, getBytes, hexlify, id } from 'ethers';
import { TronMainnet, createCustomCommon } from '@tvmjs/common';
import { createTVM } from '@tvmjs/tvm';
import { Account, createAddressFromString, createZeroAddress } from '@tvmjs/util';
import { compile } from '../scripts/compile.mjs';
import { AGE, ANSWERS, ASSETS, FEED_DECIMALS, FEE, MAX_PRICE, PRICES18, SKEW, SUN_MAX, UNITS,
  ZERO, exactQuote } from './local-evm.mjs';

const chainId = 0x48435434; // Isolated TVM identity; no node, RPC, keys or funds.
const now = 1_795_000_000n;
const caller = createAddressFromString('0x' + '77'.repeat(20));
const ensureSuccess = ({ execResult }) => {
  assert.equal(execResult.exceptionError, undefined, execResult.exceptionError?.error);
  return execResult;
};

async function fixture() {
  const artifacts = compile({ tvm: true, fixtures: true });
  const tvm = await createTVM({ common: createCustomCommon({ name: 'four-native-oracle-lab', chainId }, TronMainnet) });
  await tvm.stateManager.putAccount(caller, new Account(0n, 1_000_000n));
  const run = ({ timestamp = now, ...opts }) => tvm.runCall({ caller, gasLimit: 5_000_000n, ...opts,
    block: { header: { number: 100n, coinbase: createZeroAddress(), timestamp, difficulty: 0n,
      prevRandao: new Uint8Array(32), gasLimit: 30_000_000n } } });
  let tx = 0;
  const deploy = async ({ abi, bytecode }, args, { canRevert } = {}) => {
    const iface = new Interface(abi);
    const raw = await run({ data: getBytes(bytecode + iface.encodeDeploy(args).slice(2)),
      rootTransactionId: getBytes(id(`oracle-tvm-lab:${++tx}`)) });
    if (canRevert) return raw;
    ensureSuccess(raw);
    const to = raw.createdAddress;
    const send = (method, args = [], opts) => run({ to, data: getBytes(iface.encodeFunctionData(method, args)), ...opts });
    const view = async (method, args = [], opts) => iface.decodeFunctionResult(method,
      ensureSuccess(await send(method, args, { isStatic: true, ...opts })).returnValue)[0];
    return { iface, address: getAddress(to.toString()), send, view, raw: (data, opts) => run({ to, data, ...opts }) };
  };
  const feeds = [];
  for (let i = 0; i < ASSETS.length; ++i) {
    const feed = await deploy(artifacts.feed, [FEED_DECIMALS[i]]);
    ensureSuccess(await feed.send('report', [10, ANSWERS[i], now, now]));
    feeds.push(feed);
  }
  const policy = feeds.map((f, i) => [f.address, AGE, FEED_DECIMALS[i], 1n, MAX_PRICE]);
  return { deploy, feeds, artifacts, policy };
}

const expectRevert = (oracle, { execResult }, name) => {
  assert.equal(execResult.exceptionError?.error, 'revert');
  if (name) assert.equal(hexlify(execResult.returnValue).slice(0, 10), oracle.iface.getError(name).selector);
};

test('pinned TRON Solidity compiler and TVM execute one nonpayable epoch and all 12 quotes in native units', async () => {
  const f = await fixture();
  const args = [chainId, f.policy, SKEW, FEE, ZERO, 0];
  const oracle = await f.deploy(f.artifacts.oracle, args);
  expectRevert(oracle, await f.deploy(f.artifacts.oracle, [999, ...args.slice(1)], { canRevert: true }), 'WrongChain');
  const advance = ensureSuccess(await oracle.send('refresh'));
  assert.equal(advance.logs.length, 1);
  const refreshed = await oracle.view('activeEpoch');
  assert.equal(refreshed.validUntil, now + BigInt(AGE));
  assert.deepEqual(refreshed.rounds.map((r) => r.price18), PRICES18);
  assert.equal(ensureSuccess(await oracle.send('refresh')).logs.length, 0);

  for (let src = 0; src < 4; src++) for (let dst = 0; dst < 4; dst++) {
    if (src === dst) continue;
    const debit = src === 2 ? 9_007_199_254_740_993n : UNITS[src] + 1n;
    const expected = exactQuote(src, dst, debit);
    assert.equal(await oracle.view('quote', [refreshed.id, src, dst, debit, expected]), expected);
  }
  expectRevert(oracle, await oracle.send('quote', [refreshed.id, 2, 3, SUN_MAX + 1n, 0]), 'InvalidDebit');
  expectRevert(oracle, await oracle.raw(new Uint8Array(), { value: 1n }));
  expectRevert(oracle, await oracle.send('activeEpoch', [], { timestamp: now + BigInt(AGE) }), 'EpochExpired');

  ensureSuccess(await f.feeds[3].send('report', [11, ANSWERS[3] * 2n, now, now]));
  expectRevert(oracle, await oracle.send('quote', [refreshed.id, 2, 3, UNITS[2], 0]), 'EpochChanged');
  ensureSuccess(await oracle.send('refresh'));
  const later = await oracle.view('activeEpoch');
  assert.notEqual(later.id, refreshed.id);
  assert.equal(await oracle.view('quote', [later.id, 2, 3, UNITS[2], 0]),
    exactQuote(2, 3, UNITS[2], [...PRICES18.slice(0, 3), PRICES18[3] * 2n]));
});
