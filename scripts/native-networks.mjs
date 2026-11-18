import { NATIVE_ASSET_IDS, nativeAsset, nativeNetwork } from "../fhe-swap/src/network-catalog.mjs";
import { probeNativeNetwork } from "../packages/oracle/src/chainlink.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.table(NATIVE_ASSET_IDS.map((id) => ({ id, chain: nativeNetwork(nativeAsset(id).network).name, chainRef: nativeAsset(id).chainRef })));
  } else if (args.length === 2 && args[0] === "--probe") {
    const net = await probeNativeNetwork(args[1], process.env.MOBUBU_NETWORK_RPC_URL);
    console.log(`${net.name}: RPC identity matches ${net.chainRef}. No finality, custody or settlement check.`);
  } else {
    throw new Error("usage: npm run networks -- [--probe <network>]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
