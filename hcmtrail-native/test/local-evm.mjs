import { ContractDecoder, EdrContext, L1_CHAIN_TYPE, L1Hardfork, MineOrdering,
  l1GenesisState, l1HardforkToString, l1ProviderFactory } from '@nomicfoundation/edr';
import { BrowserProvider, ContractFactory, computeAddress, getBytes, parseEther, toBeHex } from 'ethers';
import { compile } from '../scripts/compile.mjs';

export const LOCAL_ID = 31337n;
export const FEED_DECIMALS = Object.freeze([8, 6, 18, 10]);
export const ANSWERS = Object.freeze([3000_00000000n, 625_000000n, 321234560000000000n, 671234567890n]);
export const PRICES18 = Object.freeze(ANSWERS.map((answer, i) => answer * 10n ** BigInt(18 - FEED_DECIMALS[i])));
export const ASSETS = Object.freeze(['ETH', 'BNB', 'TRX', 'HYPE']);
export const UNITS = Object.freeze([10n ** 18n, 10n ** 18n, 10n ** 6n, 10n ** 18n]);
export const EVM_MAX = 2n ** 96n - 1n;
export const SUN_MAX = 2n ** 63n - 1n;
export const FEE = 30n;
export const ZERO = '0x' + '00'.repeat(20);
export const NO_EPOCH = '0x' + '00'.repeat(32);
export const MAX_PRICE = 10n ** 24n;
export const AGE = 1800;
export const SKEW = 300;
export const GRACE = 60;
export const GAS = 30_000_000n;

let context, compiled;

export async function localEvm(chainId = LOCAL_ID) {
  const vm = L1Hardfork.Cancun;
  context ??= (async () => {
    const ctx = new EdrContext();
    await ctx.registerProviderFactory(L1_CHAIN_TYPE, l1ProviderFactory());
    return ctx;
  })();
  const keys = [1n, 2n].map((n) => toBeHex(n, 32)); // Public fixture keys, never sent to an RPC.
  const accounts = keys.map((key) => ({ address: getBytes(computeAddress(key)), balance: parseEther('100') }));
  let edr = await (await context).createProvider(L1_CHAIN_TYPE, {
    allowBlocksWithSameTimestamp: false, allowUnlimitedContractSize: false,
    bailOnCallFailure: true, bailOnTransactionFailure: false,
    chainId, networkId: chainId, coinbase: new Uint8Array(20),
    hardfork: l1HardforkToString(vm), initialBaseFeePerGas: 1_000_000_000n, minGasPrice: 0n,
    genesisState: [...l1GenesisState(vm), ...accounts],
    mining: { autoMine: true, blockGasLimit: GAS, memPool: { order: MineOrdering.Fifo } },
    network: { genesisBlockGasLimit: GAS, genesisBlockTime: 1_795_000_000n },
    ownedAccounts: keys, observability: {}, precompileOverrides: [],
  }, { enable: false, decodeConsoleLogInputsCallback: () => [], printLineCallback: () => {} },
  { subscriptionCallback: () => {} }, new ContractDecoder());
  let id = 0;
  const provider = new BrowserProvider({ async request({ method, params }) {
    if (!edr) throw new Error('fixture is closed');
    const { data } = await edr.handleRequest(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }));
    const response = typeof data === 'string' ? JSON.parse(data) : data;
    if (response.error) {
      const { code, message, data } = response.error;
      throw Object.assign(new Error(message), { code, data: data?.data ?? data });
    }
    return response.result;
  } }, undefined, { cacheTimeout: -1 });
  const signer = await provider.getSigner(0);
  return {
    provider, signer,
    async deploy(artifact, ...args) {
      const instance = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
      await instance.waitForDeployment();
      return instance;
    },
    close() { provider.destroy(); edr = undefined; },
  };
}

export async function setup({ sequencer = false, age = AGE, skew = SKEW, chainId = LOCAL_ID } = {}) {
  compiled ??= compile({ fixtures: true });
  const vm = await localEvm(chainId);
  try {
    const feeds = [];
    for (const decimals of FEED_DECIMALS) feeds.push(await vm.deploy(compiled.feed, decimals));
    const policy = feeds.map((feed, i) => [feed.target, age, FEED_DECIMALS[i], 1n, MAX_PRICE]);
    const seq = sequencer ? await vm.deploy(compiled.feed, 0) : null;
    const args = [chainId, policy, skew, FEE, seq?.target ?? ZERO, seq ? GRACE : 0];
    const oracle = await vm.deploy(compiled.oracle, ...args);
    const timestamp = async () => (await vm.provider.getBlock('latest')).timestamp;
    const setTime = async (now) => {
      await vm.provider.send('evm_setNextBlockTimestamp', [now]);
      await vm.provider.send('evm_mine', []);
    };
    const report = (feed, round, answer, updatedAt, startedAt = updatedAt) =>
      feed.report(round, answer, startedAt, updatedAt).then((tx) => tx.wait());
    const start = await timestamp();
    if (seq) await report(seq, 1, 0n, start - GRACE - 30);
    for (let i = 0; i < 4; i++) await report(feeds[i], 10, ANSWERS[i], start);
    return { ...vm, oracle, feeds, seq, policy, args, start, timestamp, setTime, report, artifact: compiled.oracle };
  } catch (error) { vm.close(); throw error; }
}

export function exactQuote(src, dst, debit, prices = PRICES18, fee = FEE) {
  return debit * prices[src] * UNITS[dst] * (10_000n - fee) / (prices[dst] * UNITS[src] * 10_000n);
}
