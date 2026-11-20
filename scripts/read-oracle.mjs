import { formatUnits } from "ethers";
import { chainlinkReader } from "../packages/oracle/src/chainlink.mjs";
import { CrossChainOracle } from "../packages/oracle/src/market-oracle.mjs";

try {
  const oracle = new CrossChainOracle({ read: chainlinkReader({
    ethereum: process.env.MOBUBU_ETHEREUM_RPC_URL,
    bsc: process.env.MOBUBU_BSC_RPC_URL,
  }) });
  const snapshot = await oracle.refresh();
  console.log("Chainlink on Ethereum + BSC — USD reference only; no settlement");
  console.table(Object.fromEntries(Object.entries(snapshot.pricesUsd18).map(([symbol, price]) => [symbol, { USD: formatUnits(price, 18) }])));
  for (const row of snapshot.observations) {
    console.log(`${row.network}/${row.symbol} block=${row.block} round=${row.roundId} updatedAt=${new Date(row.updatedAt * 1_000).toISOString()}`);
  }
  console.log("Snapshot:", snapshot.id, "valid until", new Date(snapshot.validUntil * 1_000).toISOString());
} catch (error) {
  console.error("Oracle unavailable:", error.message);
  process.exitCode = 1;
}
