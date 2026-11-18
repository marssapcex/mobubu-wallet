import { ASSET_META } from "./asset-catalog.mjs";

export const BITCOIN_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

const evm = (name, chainId, symbol) => Object.freeze({
  name, family: "evm", chainId, chainRef: `eip155:${chainId}`, symbol,
});

// Mainnet identities, not a list of enabled custody/settlement adapters.
export const NATIVE_NETWORKS = Object.freeze({
  bitcoin: Object.freeze({ name: "Bitcoin", family: "bitcoin", chainId: null,
    chainRef: `bip122:${BITCOIN_GENESIS.slice(0, 32)}`, symbol: "BTC" }),
  ethereum: evm("Ethereum Mainnet", 1, "ETH"),
  "arbitrum-one": evm("Arbitrum One", 42161, "ETH"),
  optimism: evm("OP Mainnet", 10, "ETH"),
  base: evm("Base", 8453, "ETH"),
  "zksync-era": evm("ZKsync Era", 324, "ETH"),
  linea: evm("Linea", 59144, "ETH"),
  scroll: evm("Scroll", 534352, "ETH"),
  robinhood: evm("Robinhood Chain", 4663, "ETH"),
  bsc: evm("BNB Smart Chain", 56, "BNB"),
});

export const NATIVE_ASSETS = Object.freeze(Object.fromEntries(
  Object.entries(NATIVE_NETWORKS).map(([network, { chainRef, symbol }]) => {
    const id = `${symbol}@${network}`;
    return [id, Object.freeze({ id, network, chainRef, symbol, decimals: ASSET_META[symbol].decimals })];
  }),
));
export const NATIVE_ASSET_IDS = Object.freeze(Object.keys(NATIVE_ASSETS));

export function nativeNetwork(network) {
  if (typeof network !== "string" || !Object.hasOwn(NATIVE_NETWORKS, network)) throw new Error("unsupported network");
  return NATIVE_NETWORKS[network];
}

export function nativeAsset(id) {
  if (typeof id !== "string" || !Object.hasOwn(NATIVE_ASSETS, id)) throw new Error("unsupported native asset ID");
  return NATIVE_ASSETS[id];
}

// CLI convenience only. The market and proofs require a fully specified ID.
export function parseNativeAssetArg(arg) {
  if (typeof arg === "string" && Object.hasOwn(ASSET_META, arg)) return `${arg}@${ASSET_META[arg].chain}`;
  return nativeAsset(arg).id;
}
