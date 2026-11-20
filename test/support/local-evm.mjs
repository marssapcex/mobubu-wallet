import {
  ContractDecoder, EdrContext, L1_CHAIN_TYPE, L1Hardfork, MineOrdering,
  l1GenesisState, l1HardforkToString, l1ProviderFactory,
} from "@nomicfoundation/edr";
import { BrowserProvider, ContractFactory, computeAddress, getBytes, parseEther, toBeHex } from "ethers";

export const LOCAL_CHAIN_ID = 31_337n;
export const TX_GAS_CAP = 16_777_216n;
const BLOCK_GAS = 30_000_000n;
const FORK = L1Hardfork.Osaka;
let context;

export async function openLocalEvm(chainId = LOCAL_CHAIN_ID) {
  context ??= (async () => {
    const ctx = new EdrContext();
    await ctx.registerProviderFactory(L1_CHAIN_TYPE, l1ProviderFactory());
    return ctx;
  })();
  // Public test keys, only funded in this isolated EVM. No HTTP RPC or fork.
  const ownedAccounts = [1n, 2n, 3n, 4n].map((n) => toBeHex(n, 32));
  const funded = ownedAccounts.map((key) => ({ address: getBytes(computeAddress(key)), balance: parseEther("10000") }));
  let edr = await (await context).createProvider(L1_CHAIN_TYPE, {
    allowBlocksWithSameTimestamp: false, allowUnlimitedContractSize: false,
    bailOnCallFailure: true, bailOnTransactionFailure: false,
    chainId, networkId: chainId, coinbase: new Uint8Array(20),
    hardfork: l1HardforkToString(FORK), initialBaseFeePerGas: 1_000_000_000n, minGasPrice: 0n,
    genesisState: [...l1GenesisState(FORK), ...funded],
    mining: { autoMine: true, blockGasLimit: BLOCK_GAS, memPool: { order: MineOrdering.Fifo } },
    network: { genesisBlockGasLimit: BLOCK_GAS, genesisBlockTime: 1_794_960_000n },
    ownedAccounts, observability: {}, precompileOverrides: [],
  }, { enable: false, decodeConsoleLogInputsCallback: () => [], printLineCallback: () => {} },
  { subscriptionCallback: () => {} }, new ContractDecoder());
  let id = 0;
  const provider = new BrowserProvider({ async request({ method, params }) {
    if (!edr) throw new Error("local EVM is closed");
    const { data } = await edr.handleRequest(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }));
    const response = typeof data === "string" ? JSON.parse(data) : data;
    if (response.error) {
      const { code, message, data } = response.error;
      throw Object.assign(new Error(message), { code, data: data?.data ?? data });
    }
    return response.result;
  } }, undefined, { cacheTimeout: -1 });
  return {
    provider,
    async deploy({ abi, evm }, ...args) {
      const contract = await new ContractFactory(abi, `0x${evm.bytecode.object}`, await provider.getSigner(0)).deploy(...args);
      await contract.waitForDeployment();
      return contract;
    },
    close() { provider.destroy(); edr = undefined; },
  };
}
