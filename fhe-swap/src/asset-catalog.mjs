/** Native symbol metadata and default networks. Use network-catalog.mjs for network-scoped note IDs. */
export const ASSET_META = Object.freeze({
  BTC: Object.freeze({ asset: "BTC", chain: "bitcoin", decimals: 8, name: "Bitcoin" }),
  ETH: Object.freeze({ asset: "ETH", chain: "ethereum", decimals: 18, name: "Ether" }),
  BNB: Object.freeze({ asset: "BNB", chain: "bsc", decimals: 18, name: "BNB" }),
});
