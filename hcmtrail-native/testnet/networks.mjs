export const TESTNETS = Object.freeze(Object.fromEntries(Object.entries({
  ETH: { chainId: 11155111n, assetId: 0n, label: 'Ethereum Sepolia', decimals: 18, name: 'SepoliaVault' },
  BNB: { chainId: 97n, assetId: 1n, label: 'BSC Testnet', decimals: 18, name: 'BscTestnetVault' },
  TRX: { chainId: 0xcd8690dcn, assetId: 2n, label: 'TRON Nile', decimals: 6, name: 'NileVault', tvm: true },
  HYPE: { chainId: 998n, assetId: 3n, label: 'HyperEVM Testnet', decimals: 18, name: 'HyperEvmTestnetVault', bigBlocks: true },
}).map(([asset, info]) => [asset, Object.freeze({ asset, ...info })])));

export const TX_GAS_CAP = 1n << 24n;
export const GOLDILOCKS = 0xffffffff00000001n;
export const CUSTODY_CAP_EVM = GOLDILOCKS - 2n;
export const CUSTODY_CAP_TVM = (1n << 63n) - 1n;
export const TRON_FEE_CAP = 15_000_000_000n; // Network ceiling in sun, not a default spend budget.
export const STARK_IMAGE = '0x4364151e9f54797f3bbf9c8d28465f5a7dcf8ca1aafa9c9b48eb43cedf4e2429';
export const STARK_PARAMS = '0xccba76ed5748b5ee54dfd62935fd1d10998b5c0f84e35a9dc899905cfb1eadb5';
