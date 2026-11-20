import { ASSET_META } from "../../../fhe-swap/src/asset-catalog.mjs";

const usdFeed = (proxy, maxAgeSeconds) => Object.freeze({ proxy, decimals: 8, maxAgeSeconds });

// Standard Chainlink USD proxies. See docs/SWAP-10-MANG.md for sources.
// Ages are Mobubu's research limits, not the feeds' guaranteed update cadence.
export const FEED_POLICY = Object.freeze({
  ethereum: Object.freeze({
    BTC: usdFeed("0xf4030086522a5beea4988f8ca5b36dbc97bee88c", 5_400),
    ETH: usdFeed("0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", 5_400),
    BNB: usdFeed("0x14e613ac84a31f709eadbdf89c6cc390fdc9540a", 7_200),
  }),
  bsc: Object.freeze({
    BTC: usdFeed("0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf", 1_800),
    ETH: usdFeed("0x9ef1b8c0e4f7dc8bf5719ea496883dc6401d5b2e", 1_800),
    BNB: usdFeed("0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee", 1_800),
  }),
});
export const PRICE_SYMBOLS = Object.freeze(Object.keys(ASSET_META));
export const ORACLE_NETWORKS = Object.freeze(Object.keys(FEED_POLICY));
export const MAX_ANCHOR_AGE = Object.freeze({ ethereum: 1_800, bsc: 180 });
export const SNAPSHOT_TTL = 300;
export const MAX_SOURCE_SPREAD_BPS = 150n;
export const MAX_QUOTE_DEVIATION_BPS = 200n;
