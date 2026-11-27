// Pinned NotBefore A profile used only by the ETH vault lab.
import { STARK_IMAGE, STARK_PARAMS } from '../testnet/networks.mjs';

export const ETH_POOL_LEGACY = Object.freeze({
  id: 'NotBefore-A-format7', status: 'local-devnet-only', image: STARK_IMAGE, params: STARK_PARAMS,
  extensionDegree: 2, digestBits: 256, queries: 19, publishedClassicalRoundBits: 80.1,
});
