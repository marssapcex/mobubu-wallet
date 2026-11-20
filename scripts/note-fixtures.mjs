import { createHash } from "node:crypto";
import { parseUnits } from "ethers";
import { NATIVE_ASSET_IDS, nativeAsset } from "../legacy/groth16/src/network-catalog.mjs";
import { ORACLE_NETWORKS, PRICE_SYMBOLS } from "../packages/oracle/src/feed-policy.mjs";
import { CrossChainOracle } from "../packages/oracle/src/market-oracle.mjs";

// Sample reserve and price ratios agree at initialization. NOT market data.
const reserves = Object.freeze({ BTC: "100", ETH: "2000", BNB: "24000" });
const usd = Object.freeze({ BTC: 60_000n, ETH: 3_000n, BNB: 250n });

export const demoLiquidity = () => Object.fromEntries(NATIVE_ASSET_IDS.map((id) => {
  const { symbol, decimals } = nativeAsset(id);
  return [id, { assetReserve: parseUnits(reserves[symbol], decimals), hubReserve: 10n ** 24n }];
}));

export function fixtureObservations(now) {
  return ORACLE_NETWORKS.flatMap((network) => {
    const blockHash = `0x${createHash("sha256").update(`fixture/${network}/${now}`).digest("hex")}`;
    return PRICE_SYMBOLS.map((symbol) => ({
      network, symbol, block: BigInt(now), blockHash, blockTime: now,
      roundId: BigInt(now), decimals: 8, answer: usd[symbol] * 10n ** 8n, updatedAt: now,
    }));
  });
}

export const demoOracle = (now) => new CrossChainOracle({ now, read: () => fixtureObservations(now()) });
