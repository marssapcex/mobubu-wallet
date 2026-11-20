import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { AbiCoder, computeAddress, id, Interface, toBeHex, TypedDataEncoder, Wallet, ZeroHash } from 'ethers';
import { assertRuntime, callSpec, createSpec, Transactions, view } from '../testnet/deployment.mjs';
import { Store } from '../testnet/store.mjs';
import { DEMO_SENDER } from './testnet-fixture.mjs';

const encode = AbiCoder.defaultAbiCoder();
const selector = (name) => id(name.includes('(') ? name : `${name}()`).slice(0, 10);
export const reverts = (name) => (e) => e.revert === selector(name) || e.data?.startsWith?.(selector(name));
const key2 = toBeHex(2n, 32);
export const localPayee = computeAddress(toBeHex(3n, 32));
export const witnesses = [11n, 22n, 33n].map((x) => new Wallet(toBeHex(x, 32)))
  .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())); // test keys only
const signatures = ['tuple(uint64 blockNumber,bytes32 blockHash,bytes32 transactionHash,uint32 logIndex)', 'tuple(bytes32 r,bytes32 s,uint8 v)[2]'];
const typed = { FinalizedWithdrawalLog: [
  ['remoteChain', 'uint256'], ['emitter', 'address'], ['kind', 'uint8'], ['order', 'bytes32'], ['data', 'bytes32'],
  ['blockNumber', 'uint64'], ['blockHash', 'bytes32'], ['transactionHash', 'bytes32'], ['logIndex', 'uint32'], ['consumer', 'address'],
].map(([name, type]) => ({ name, type })) };

export async function on(f, a, name, args = []) {
  const spec = createSpec(a[name], name, args);
  const receipt = await f.txs.submit(`deploy-cross-${name}`, spec);
  assertRuntime(await f.chain.code(receipt.contractAddress), a[name], name);
  assert.equal(await f.chain.creationData(receipt.hash), spec.data);
  const at = receipt.contractAddress, abi = new Interface(a[name].abi);
  return { at, abi, receipt, spec: (method, args, value) => callSpec(abi, at, method, args, value),
    read: (method, args) => view(f.chain, abi, at, method, args) };
}

export function signer(f, name) {
  const chain = f.signerChain(key2);
  const dir = f.store.path(name);
  mkdirSync(dir, { mode: 0o700 });
  return new Transactions(chain, new Store(dir), { seconds: 0, pollMs: 1 });
}

export async function certificate(from, contract, tx, to, adapter, consumer, kind, order, data = ZeroHash) {
  const confirmed = await from.chain.receipt(tx.hash);
  assert(confirmed?.ok && confirmed.blockHash === tx.blockHash);
  const matches = confirmed.logs.filter((log) => log.address === contract.at && log.topics[0] === contract.abi.getEvent('SettlementMessage').topicHash)
    .filter((log) => {
      const e = contract.abi.parseLog(log).args;
      return e[0] === BigInt(kind) && e[1] === order && e[2] === data;
    });
  assert.equal(matches.length, 1);
  const at = { blockNumber: confirmed.blockNumber, blockHash: confirmed.blockHash, transactionHash: confirmed.hash, logIndex: matches[0].index };
  const domain = { name: 'Hcmtrail Withdrawal Finality', version: '1', chainId: to.chain.network.chainId, verifyingContract: adapter.at };
  const message = { remoteChain: from.chain.network.chainId, emitter: contract.at, kind, order, data, ...at, consumer: consumer.at };
  assert.equal(await adapter.read('digest', [message.remoteChain, message.emitter, kind, order, data, at, message.consumer]),
    TypedDataEncoder.hash(domain, typed, message));
  const sigs = await Promise.all(witnesses.slice(0, 2).map((w) => w.signTypedData(domain, typed, message)));
  const split = sigs.map((wire) => ({ r: wire.slice(0, 66), s: `0x${wire.slice(66, 130)}`, v: Number.parseInt(wire.slice(130), 16) }));
  return { good: encode.encode(signatures, [at, split]), duplicate: encode.encode(signatures, [at, [split[0], split[0]]]),
    wrongConsumer: encode.encode(signatures, [at, await Promise.all(witnesses.slice(0, 2).map(async (w) => {
      const r = await w.signTypedData(domain, typed, { ...message, consumer: DEMO_SENDER });
      return { r: r.slice(0, 66), s: `0x${r.slice(66, 130)}`, v: Number.parseInt(r.slice(130), 16) };
    }))]) };
}

export const feeCost = (receipt) => receipt.feeSun ?? receipt.gasUsed * receipt.effectiveGasPrice;
