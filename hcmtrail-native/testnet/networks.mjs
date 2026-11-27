// Logical lanes in the shared manifest. All RPCs are in-process lab VMs.
export const ETHEREUM = 1n;
export const ARBITRUM = 42161n;
export const BASE = 8453n;
export const ETH_LABS = Object.freeze([
  Object.freeze({ slug: 'ethereum', label: 'Ethereum', labId: '31337', lane: ETHEREUM }),
  Object.freeze({ slug: 'arbitrum', label: 'Arbitrum One', labId: '31338', lane: ARBITRUM }),
  Object.freeze({ slug: 'base', label: 'Base', labId: '31339', lane: BASE }),
]);
export const SEPOLIA_CHAIN_ID = 11155111n; // Used only to test rejection of public networks.
export const TX_GAS_CAP = 1n << 24n;
export const GOLDILOCKS = 0xffffffff00000001n;
export const STARK_NOTE_LIMIT = GOLDILOCKS - 2n;
export const STARK_IMAGE = '0x4364151e9f54797f3bbf9c8d28465f5a7dcf8ca1aafa9c9b48eb43cedf4e2429';
export const STARK_PARAMS = '0xccba76ed5748b5ee54dfd62935fd1d10998b5c0f84e35a9dc899905cfb1eadb5';
