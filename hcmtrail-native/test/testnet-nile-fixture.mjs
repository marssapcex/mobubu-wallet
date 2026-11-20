import assert from 'node:assert/strict';
import { getAddress, getBytes, hexlify, id, recoverAddress, toBeHex, toQuantity } from 'ethers';
import { createAddressFromString } from '@tvmjs/util';
import { utils } from 'tronweb';
import { localTvm, TVM_GAS, TVM_NOW } from './local-tvm.mjs';
import { DEMO_KEY, DEMO_RECIPIENT, DEMO_SENDER } from './testnet-fixture.mjs';
import { TESTNETS } from '../testnet/networks.mjs';
import { NileChain } from '../testnet/rpc.mjs';

const str = (bytes) => hexlify(bytes).slice(2);
const toTron = (at) => `41${at.slice(2).toLowerCase()}`;
const fromTron = (at) => getAddress(`0x${at.slice(2).toLowerCase()}`);
const q = toQuantity;

// Isolated in-process transport. Verifies TRON protobuf/TAPOS construction and runs the bytecode;
// cannot model public nodes' fee resource accounting, CPU deadlines, or confirmation delays.
export async function nileFixture({ chainId = TESTNETS.TRX.chainId, modelFees = false } = {}) {
  const net = TESTNETS.TRX;
  const vm = await localTvm({ chainId, funded: [DEMO_SENDER, DEMO_RECIPIENT] });
  let head = 100n;
  let time = TVM_NOW;
  const times = new Map([[head, time]]);
  function nextBlock(timestamp = time + 3n) {
    assert(timestamp > time);
    time = timestamp;
    times.set(++head, time);
    return block(head);
  }
  const sunPerUnit = modelFees ? 1 : 100;
  const flags = { holdSolid: false, foreignTapos: false, noEnergy: false };
  const txs = new Map();
  const rows = [];
  const block = (number) => ({ number: q(number), hash: toBeHex(number, 8) + id(`nile-fixture:${number}`).slice(18),
    timestamp: q(times.get(number) ?? (TVM_NOW + (number - 100n) * 3n)), gasLimit: q(TVM_GAS) });
  const solid = () => flags.holdSolid ? head - 1n : head;
  let pending = Promise.resolve();
  function simulate(args) {
    // TVM checkpoints cannot overlap. Real nodes isolate these RPCs independently.
    const run = pending.then(() => vm.simulate(args));
    pending = run.catch(() => {});
    return run;
  }
  const native = async (method, args) => {
    if (method.endsWith('/getnowblock')) {
      const b = block(method.startsWith('walletsolidity') ? solid() : head);
      return { blockID: flags.foreignTapos ? id('wrong chain').slice(2) : b.hash.slice(2), block_header: { raw_data: {
        number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp) * 1_000n),
      } } };
    }
    if (method === 'wallet/getchainparameters') return { chainParameter: [{ key: 'getEnergyFee', value: sunPerUnit }] };
    if (method === 'wallet/getaccountresource') return { EnergyLimit: modelFees ? 0 : 30_000_000, EnergyUsed: 0 };
    if (method.endsWith('/triggerconstantcontract')) {
      const value = BigInt(args.call_value);
      const opts = { from: fromTron(args.owner_address), timestamp: BigInt(block(method.startsWith('walletsolidity') ? solid() : head).timestamp) };
      const { execResult: r } = await simulate(args.contract_address
        ? { ...opts, to: createAddressFromString(fromTron(args.contract_address)), value,
          data: getBytes(id(args.function_selector).slice(0, 10) + args.parameter) }
        : { ...opts, rootTransactionId: getBytes(id('constant-create')), value, data: getBytes(`0x${args.data}`) });
      return { result: { result: !r.exceptionError }, constant_result: [str(r.returnValue)], energy_used: flags.noEnergy ? 0 : Number(r.executionGasUsed) };
    }
    if (method === 'wallet/broadcasttransaction') {
      const tx = args;
      assert(utils.transaction.txCheck(tx));
      const txId = `0x${tx.txID}`;
      if (txs.has(txId)) return { result: false, code: 'DUP_TRANSACTION_ERROR' };
      const p = tx.raw_data.contract[0].parameter.value;
      const owner = fromTron(p.owner_address);
      assert.equal(recoverAddress(txId, `0x${tx.signature[0]}`), owner);
      assert.equal(tx.raw_data.ref_block_bytes, q(head).slice(2).slice(-4).padStart(4, '0'));
      assert.equal(tx.raw_data.ref_block_hash, block(head).hash.slice(18, 34));
      assert(tx.raw_data.fee_limit > 0 && tx.raw_data.expiration > tx.raw_data.timestamp);
      const b = nextBlock();
      const to = p.contract_address ? fromTron(p.contract_address) : null;
      const opts = { from: owner, rootTransactionId: getBytes(txId), timestamp: BigInt(b.timestamp) };
      const result = to ? await vm.run({ ...opts, to: createAddressFromString(to), value: BigInt(p.call_value ?? 0), data: getBytes(`0x${p.data}`) })
        : await vm.deployRaw({ abi: [], bytecode: `0x${p.new_contract.bytecode}` }, [], opts);
      const r = result.execResult;
      // An opt-in, synthetic one-sun/VM-unit fee. It checks separation of signer funds
      // from native value, not Java-Tron billing, Bandwidth or real Energy pricing.
      const fee = modelFees ? r.executionGasUsed * BigInt(sunPerUnit) : 0n;
      if (modelFees) {
        assert(fee <= BigInt(tx.raw_data.fee_limit));
        await vm.chargeFixtureFee(owner, fee);
      }
      const created = !to && result.createdAddress ? getAddress(result.createdAddress.toString()) : to;
      if (!to && created) assert.equal(toTron(created), tx.contract_address.toLowerCase());
      const contractRet = r.exceptionError ? 'REVERT' : 'SUCCESS';
      tx.ret = [{ contractRet }];
      const logs = (r.logs ?? []).map(([at, topics, data], i) => ({ address: getAddress(hexlify(at)), topics: topics.map(hexlify), data: hexlify(data),
        blockNumber: b.number, blockHash: b.hash, transactionHash: txId, logIndex: q(i) }));
      rows.push(...logs);
      txs.set(txId, { tx, info: { id: tx.txID, blockNumber: Number(head), contract_address: created ? toTron(created) : undefined,
        result: r.exceptionError ? 'FAILED' : undefined, fee: Number(fee),
        receipt: { result: contractRet, energy_usage_total: Number(r.executionGasUsed), net_usage: tx.raw_data_hex.length / 2 },
        log: logs.map((l) => ({ address: l.address.slice(2).toLowerCase(), topics: l.topics.map((t) => t.slice(2)), data: l.data.slice(2) })),
      } });
      return { result: true, txid: tx.txID };
    }
    if (method === 'walletsolidity/gettransactioninfobyid' || method === 'walletsolidity/gettransactionbyid') {
      const row = txs.get(`0x${args.value}`);
      if (!row || BigInt(row.info.blockNumber) > solid()) return {};
      return method.includes('info') ? row.info : row.tx;
    }
    throw new Error(`Unexpected native fixture method ${method}`);
  };
  const rpc = async (method, params = []) => {
    if (method === 'eth_chainId') return q(chainId);
    if (method === 'eth_getBlockByNumber') return block(params[0] === 'latest' ? head : BigInt(params[0]));
    if (method === 'eth_getCode') return vm.code(params[0]);
    if (method === 'eth_getBalance') return q(await vm.balance(params[0]));
    if (method === 'eth_getLogs') {
      const { address, topics, fromBlock, toBlock } = params[0];
      return rows.filter((l) => l.address === address && BigInt(l.blockNumber) >= BigInt(fromBlock) && BigInt(l.blockNumber) <= BigInt(toBlock) &&
        topics.every((t, i) => t == null || (Array.isArray(t) ? t.includes(l.topics[i]) : t === l.topics[i])));
    }
    throw new Error(`Unexpected JSON-RPC fixture method ${method}`);
  };
  const chain = new NileChain(net, rpc, native, { key: DEMO_KEY, feeLimit: 7_500_000_000n });
  assert.equal(chain.sender, DEMO_SENDER);
  const signerChain = (key) => new NileChain(net, rpc, native, { key, feeLimit: 7_500_000_000n });
  return { chain, vm, native, rpc, flags, signerChain, setTime: (time) => nextBlock(time), close: () => {} };
}
