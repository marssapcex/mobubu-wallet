import { ContractDecoder, EdrContext, L1_CHAIN_TYPE, L1Hardfork, MineOrdering,
  l1GenesisState, l1HardforkToString, l1ProviderFactory } from '@nomicfoundation/edr';
import { BrowserProvider, ContractFactory, computeAddress, getBytes, parseEther, toBeHex } from 'ethers';

export const LOCAL_ID = 31337n;
const GAS = 30_000_000n;
let context;

export async function localEvm(chainId = LOCAL_ID, { genesisBlockTime = 1_795_000_000n, balance = parseEther('100'),
  keys = [1n, 2n].map((n) => toBeHex(n, 32)), hardfork = L1Hardfork.Cancun } = {}) {
  const vm = hardfork;
  context ??= (async () => {
    const ctx = new EdrContext();
    await ctx.registerProviderFactory(L1_CHAIN_TYPE, l1ProviderFactory());
    return ctx;
  })();
  // Accounts exist only in the in-process devnet, never on a public RPC.
  const accounts = keys.map((key) => ({ address: getBytes(computeAddress(key)), balance }));
  let edr = await (await context).createProvider(L1_CHAIN_TYPE, {
    allowBlocksWithSameTimestamp: false, allowUnlimitedContractSize: false,
    bailOnCallFailure: true, bailOnTransactionFailure: false,
    chainId, networkId: chainId, coinbase: new Uint8Array(20),
    hardfork: l1HardforkToString(vm), initialBaseFeePerGas: 1_000_000_000n, minGasPrice: 0n,
    genesisState: [...l1GenesisState(vm), ...accounts],
    mining: { autoMine: true, blockGasLimit: GAS, memPool: { order: MineOrdering.Fifo } },
    network: { genesisBlockGasLimit: GAS, genesisBlockTime },
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
