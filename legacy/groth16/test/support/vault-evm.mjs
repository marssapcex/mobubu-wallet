import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  ContractDecoder, EdrContext, L1_CHAIN_TYPE, L1Hardfork, MineOrdering,
  l1GenesisState, l1HardforkToString, l1ProviderFactory,
} from "@nomicfoundation/edr";
import { BrowserProvider, ContractFactory, computeAddress, getBytes, parseEther, toBeHex } from "ethers";
import { compileSources, readContractSources } from "../../../../scripts/compile-contracts.mjs";

const require = createRequire(import.meta.url);
const CHAIN_ID = 31_337n;
const BLOCK_GAS = 30_000_000n;
const HARDFORK = L1Hardfork.Shanghai;
let context;

async function localProvider(chainId = CHAIN_ID) {
  context ??= (async () => {
    const ctx = new EdrContext();
    await ctx.registerProviderFactory(L1_CHAIN_TYPE, l1ProviderFactory());
    return ctx;
  })();
  // Public fixture keys are funded only in this in-process EVM. No HTTP service or fork.
  const ownedAccounts = [1n, 2n, 3n].map((value) => toBeHex(value, 32));
  const funded = ownedAccounts.map((key) => ({ address: getBytes(computeAddress(key)), balance: parseEther("10000") }));
  let edr = await (await context).createProvider(L1_CHAIN_TYPE, {
    allowBlocksWithSameTimestamp: true, allowUnlimitedContractSize: false,
    bailOnCallFailure: true, bailOnTransactionFailure: false,
    chainId, networkId: chainId, coinbase: new Uint8Array(20),
    hardfork: l1HardforkToString(HARDFORK),
    initialBaseFeePerGas: 1_000_000_000n, minGasPrice: 0n,
    genesisState: [...l1GenesisState(HARDFORK), ...funded],
    mining: { autoMine: true, blockGasLimit: BLOCK_GAS, memPool: { order: MineOrdering.Fifo } },
    network: { genesisBlockGasLimit: BLOCK_GAS },
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
      // EDR wraps revert bytes alongside trace fields; ethers expects the hex data.
      throw Object.assign(new Error(message), { code, data: data?.data ?? data });
    }
    return response.result;
  } }, undefined, { cacheTimeout: -1 });
  return { provider, close() { provider.destroy(); edr = undefined; } };
}

async function openFixture(verifierPath, variant, { chainId = CHAIN_ID } = {}) {
  const compiled = compileSources({
    ...readContractSources(new URL("../../contracts/", import.meta.url)),
    "Groth16Verifier.sol": readFileSync(verifierPath, "utf8"),
    "PoseidonT3.sol": readFileSync(require.resolve("poseidon-solidity/PoseidonT3.sol"), "utf8"),
    "TestPoseidon2.sol": `
      pragma solidity ^0.8.24;
      interface IPoseidonT3 {
          function hash(uint256[2] calldata inputs) external view returns (uint256);
      }
      contract TestPoseidon2 {
          IPoseidonT3 private immutable implementation;
          constructor(IPoseidonT3 impl) { implementation = impl; }
          function poseidon(uint256[2] calldata inputs) external view returns (uint256) {
              return implementation.hash(inputs);
          }
      }`,
    "PayoutReceiver.sol": `
      pragma solidity ^0.8.24;
      contract PayoutReceiver {
          bool private accepted;
          function acceptNative() external { accepted = true; }
          receive() external payable { require(accepted); }
      }`,
  });
  const { provider, close } = await localProvider(chainId);
  try {
    const deployer = await provider.getSigner(0);
    const deploy = async (file, name, ...args) => {
      const { abi, evm } = compiled[file][name];
      const contract = await new ContractFactory(abi, `0x${evm.bytecode.object}`, deployer).deploy(...args);
      await contract.waitForDeployment();
      return contract;
    };
    const library = await deploy("PoseidonT3.sol", "PoseidonT3");
    const hasher = await deploy("TestPoseidon2.sol", "TestPoseidon2", library.target);
    const verifier = await deploy("Groth16Verifier.sol", "Groth16Verifier");
    const payoutReceiver = await deploy("PayoutReceiver.sol", "PayoutReceiver");
    return {
      provider, verifier, payoutReceiver,
      deployVault: variant === "notes"
        ? () => deploy("contracts/ValueNoteVault.sol", "ValueNoteVault", hasher.target, verifier.target)
        : (denomination) => deploy("contracts/AnonymousVault.sol", "AnonymousVault", denomination, hasher.target, verifier.target),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export const openVaultEvm = (verifierPath) => openFixture(verifierPath, "fixed");
export const openValueNoteEvm = (verifierPath, options) => openFixture(verifierPath, "notes", options);
