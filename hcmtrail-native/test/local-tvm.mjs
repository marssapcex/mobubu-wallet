import assert from 'node:assert/strict';
import { Interface, getAddress, getBytes, hexlify, id } from 'ethers';
import { TronMainnet, createCustomCommon } from '@tvmjs/common';
import { createTVM } from '@tvmjs/tvm';
import { Account, createAddressFromString, createZeroAddress } from '@tvmjs/util';

export const TRON_ID = 0x2b6653dcn;
export const TVM_GAS = 30_000_000n;
export const TVM_NOW = 1_795_000_000n;
export const TVM_DEPOSITOR = '0x' + '77'.repeat(20);
export const TVM_RELAYER = '0x' + '66'.repeat(20);
const address = (hex) => createAddressFromString(hex);

export const ensureSuccess = ({ execResult }) => {
  assert.equal(execResult.exceptionError, undefined,
    `${execResult.exceptionError?.error ?? ''} ${hexlify(execResult.returnValue)}`);
  return execResult;
};

export async function localTvm({ chainId = TRON_ID, now = TVM_NOW, funded = [TVM_DEPOSITOR, TVM_RELAYER] } = {}) {
  const tvm = await createTVM({ common: createCustomCommon({ name: 'hcmtrail-local-vault', chainId: Number(chainId) }, TronMainnet) });
  for (const a of funded) {
    await tvm.stateManager.putAccount(address(a), new Account(0n, 100_000_000n));
  }
  const run = ({ from = TVM_DEPOSITOR, timestamp = now, ...opts }) => tvm.runCall({
    caller: address(from), gasLimit: TVM_GAS, ...opts,
    block: { header: { number: 100n, coinbase: createZeroAddress(), timestamp, difficulty: 0n,
      prevRandao: new Uint8Array(32), gasLimit: TVM_GAS } },
  });
  let tx = 0;
  const deployRaw = ({ abi, bytecode }, args = [], opts) => run({
    data: getBytes(bytecode + new Interface(abi).encodeDeploy(args).slice(2)),
    rootTransactionId: getBytes(id(`hcmtrail-vault-tvm:${++tx}`)), ...opts,
  });
  const attach = (abi, at) => {
    const iface = new Interface(abi);
    const to = address(at);
    const send = (method, args = [], opts) => run({ to, data: getBytes(iface.encodeFunctionData(method, args)), ...opts });
    const view = async (method, args = []) => iface.decodeFunctionResult(method,
      ensureSuccess(await send(method, args, { isStatic: true })).returnValue)[0];
    return { iface, target: getAddress(at), send, view, raw: (data, opts) => run({ to, data, ...opts }) };
  };
  return {
    async deploy({ abi, bytecode }, ...args) {
      const raw = await deployRaw({ abi, bytecode }, args);
      const deployment = ensureSuccess(raw);
      return { ...attach(abi, raw.createdAddress.toString()), deployment };
    },
    attach, deployRaw, run,
    code: async (at) => hexlify(await tvm.stateManager.getCode(address(at))),
    async simulate(opts) {
      await tvm.stateManager.checkpoint();
      try { return await run(opts); } finally { await tvm.stateManager.revert(); }
    },
    async chargeFixtureFee(at, amount) {
      const who = address(at);
      const account = await tvm.stateManager.getAccount(who);
      assert(account && amount >= 0n && account.balance >= amount, 'TVM fixture account cannot cover the modeled fee.');
      account.balance -= amount;
      await tvm.stateManager.putAccount(who, account);
    },
    balance: async (at) => (await tvm.stateManager.getAccount(address(at)))?.balance ?? 0n,
  };
}
