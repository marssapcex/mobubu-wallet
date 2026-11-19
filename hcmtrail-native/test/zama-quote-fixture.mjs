import assert from 'node:assert/strict';
import { AbiCoder, Contract, TypedDataEncoder, Wallet, concat, id, keccak256, toBeHex } from 'ethers';
import { compileFhe } from '../scripts/build-fhe.mjs';
import { LOCAL_ID, setup } from './local-evm.mjs';

const hosts = {
  acl: '0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D',
  executor: '0xe3a9105a3a932253A70F126eb1E3b589C643dD24',
  kms: '0x901F8942346f7AB3a01F6D7613119Bca447Bb030',
};
const coder = AbiCoder.defaultAbiCoder();
const key = (n) => new Wallet(toBeHex(n, 32)).signingKey; // Fixture secrets. Never used outside EDR.
const [inputSigner, kms1, kms2] = [3, 4, 5].map(key);
export const MASK128 = (1n << 128n) - 1n;
export const KIND = { bool: 0, uint128: 6, uint256: 8 };
export const OP = { constant: 0, mul: 1, div: 2, le: 3, gt: 4, ge: 5, eq: 6, and: 7, select: 8 };

let compiled, serial = 0;
export function artifacts() { return compiled ??= compileFhe({ fixtures: true }); }

export async function fixture(t) {
  const f = await setup();
  t.after(() => f.close());
  const arts = artifacts();
  const host = {};
  for (const [name, at] of Object.entries(hosts)) {
    await f.provider.send('hardhat_setCode', [at, arts[name].runtimeTemplate]);
    host[name] = new Contract(at, arts[name].abi, f.signer);
  }
  const book = await f.deploy(arts.quote, f.oracle.target);
  const reader = await f.provider.getSigner(1);
  const publish = async () => {
    await (await f.oracle.refresh()).wait();
    return f.oracle.activeEpoch();
  };
  return { ...f, ...host, book, reader, publish, epoch: await publish() };
}

function inputHandle(kind) {
  return id(`hcmtrail.test.fhe-handle:${++serial}`).slice(0, -4) + toBeHex(kind, 1).slice(2) + '00';
}

export function pack(f, debit, minOut, { user = f.signer.address, book = f.book, kinds = [KIND.uint128, KIND.uint128] } = {}) {
  assert(0n <= debit && debit <= MASK128 && 0n <= minOut && minOut <= MASK128);
  const handles = kinds.map(inputHandle);
  const digest = keccak256(coder.encode(['bytes32', 'uint256', 'address', 'address', 'bytes32', 'bytes32'],
    [id('hcmtrail.test.fhe-input.v1'), LOCAL_ID, book.target, user, ...handles]));
  const proof = coder.encode(['bytes32', 'bytes32', 'bytes'], [...handles, inputSigner.sign(digest).serialized]);
  return { handles, proof, values: new Map([[handles[0], debit], [handles[1], minOut]]) };
}

export const quoteInput = (f, pack, src, dst, publishEligibility = false, epochId = f.epoch.id) =>
  ({ epochId, src, dst, debit: pack.handles[0], minOut: pack.handles[1], publishEligibility });

export async function request(f, packed, input, book = f.book) {
  const receipt = await (await book.requestQuote(input, packed.proof)).wait();
  const last = receipt.logs.at(-1);
  assert.equal(last.address, book.target);
  const event = book.interface.parseLog(last);
  assert.equal(event.name, 'QuoteRequested');
  const q = await book.quotes(event.args.id);
  const operations = receipt.logs.filter((log) => log.address === f.executor.target).map((log) =>
    f.executor.interface.parseLog(log).args);
  return { id: event.args.id, q, operations, receipt };
}

// Cleartext semantics of the emitted trace, just for deterministic EVM tests. Modular widths matter.
export function evaluate(packed, quote) {
  const values = new Map(packed.values);
  const get = (handle) => {
    assert(values.has(handle), `undefined ciphertext operand ${handle}`);
    return values.get(handle);
  };
  for (const { out, op, kind, a, b, scalar, control } of quote.operations) {
    let value;
    if (Number(op) === OP.constant) {
      value = BigInt(a);
    } else {
      const l = get(a), r = scalar === '0x01' ? BigInt(b) : get(b);
      switch (Number(op)) {
        case OP.mul: value = l * r; break;
        case OP.div: value = l / r; break;
        case OP.le: value = BigInt(l <= r); break;
        case OP.gt: value = BigInt(l > r); break;
        case OP.ge: value = BigInt(l >= r); break;
        case OP.eq: value = BigInt(l === r); break;
        case OP.and: value = l & r; break;
        case OP.select: value = get(control) ? l : r; break;
        default: assert.fail(`invalid operation ${op}`);
      }
    }
    values.set(out, kind === BigInt(KIND.uint128) ? value & MASK128 : value);
  }
  return { amount: get(quote.q.amount), eligible: get(quote.q.eligible) === 1n };
}

export function attest(f, handle, eligible, mode = 'quorum') {
  const domain = { name: 'FixtureKMS', version: '1', chainId: LOCAL_ID, verifyingContract: f.kms.target };
  const types = { PublicDecryptVerification: [
    { name: 'ctHandles', type: 'bytes32[]' }, { name: 'decryptedResult', type: 'bytes' }, { name: 'extraData', type: 'bytes' },
  ] };
  const digest = TypedDataEncoder.hash(domain, types, { ctHandles: [handle],
    decryptedResult: coder.encode(['bool'], [eligible]), extraData: '0x' });
  const first = kms1.sign(digest).serialized;
  if (mode === 'one') return concat(['0x01', first]);
  return concat(['0x02', first, (mode === 'duplicate' ? kms1 : kms2).sign(digest).serialized]);
}

export const rejects = (promise, name) => assert.rejects(promise, (e) =>
  e.revert?.name === name || e.data === id(`${name}()`).slice(0, 10));