import { Interface } from "ethers";
import { BITCOIN_GENESIS, nativeNetwork } from "../../../fhe-swap/src/network-catalog.mjs";
import { FEED_POLICY, ORACLE_NETWORKS, PRICE_SYMBOLS } from "./feed-policy.mjs";

const FEED_ABI = new Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error("RPC response unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("RPC response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Internal transport for trusted deployment config only. Never put a caller's
// URL here in a public API. No signer, forwarded method, or transaction write.
function createReader(network, rpcUrl, fetcher) {
  let url;
  try {
    url = new URL(rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new Error(`${network}: configure an HTTPS RPC endpoint`);
  }
  let sequence = 0;
  return async (method, params = []) => {
    const id = ++sequence;
    try {
      const response = await fetcher(url.href, {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
        signal: AbortSignal.timeout(8_000), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const message = await boundedJson(response);
      if (message?.jsonrpc !== "2.0" || message.id !== id || Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) {
        throw new Error("invalid JSON-RPC result");
      }
      return message.result;
    } catch {
      // Providers sometimes echo credentials in errors. Do not surface URLs or responses.
      throw new Error(`${network}: ${method} RPC read failed`);
    }
  };
}

function quantity(value) {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("invalid RPC quantity");
  return BigInt(value);
}

async function checkEvmIdentity(rpc, network, meta) {
  if (quantity(await rpc("eth_chainId")) !== BigInt(meta.chainId)) throw new Error(`${network}: RPC chain ID mismatch`);
}

/** Read-only identity check, not proof of safety, syncing, or deposit finality.
 * Bitcoin requires an operator-owned JSON-RPC 2.0 HTTPS endpoint. */
export async function probeNativeNetwork(network, rpcUrl, { fetcher = fetch } = {}) {
  const meta = nativeNetwork(network);
  const rpc = createReader(network, rpcUrl, fetcher);
  if (meta.family === "bitcoin") {
    if (await rpc("getblockhash", [0]) !== BITCOIN_GENESIS) throw new Error("bitcoin: RPC genesis mismatch");
  } else {
    await checkEvmIdentity(rpc, network, meta);
  }
  return meta;
}

function decode(name, data, bytes) {
  if (typeof data !== "string" || data.length !== 2 + 2 * bytes || !/^0x[0-9a-fA-F]+$/.test(data)) {
    throw new Error(`invalid Chainlink ${name} response`);
  }
  const result = FEED_ABI.decodeFunctionResult(name, data);
  if (FEED_ABI.encodeFunctionResult(name, result) !== data.toLowerCase()) throw new Error(`noncanonical Chainlink ${name} response`);
  return result;
}

async function readOnNetwork(network, rpc, symbols) {
  await checkEvmIdentity(rpc, network, nativeNetwork(network));
  const block = await rpc("eth_getBlockByNumber", ["finalized", false]);
  if (typeof block?.hash !== "string" || !HASH.test(block.hash)) throw new Error(`${network}: finalized block unavailable`);
  const anchor = { network, block: quantity(block.number), blockTime: Number(quantity(block.timestamp)), blockHash: block.hash.toLowerCase() };
  const at = { blockHash: anchor.blockHash, requireCanonical: true };
  const rows = await Promise.all(symbols.map(async (symbol) => {
    const { proxy, decimals } = FEED_POLICY[network][symbol];
    const call = (name) => rpc("eth_call", [{ to: proxy, data: FEED_ABI.encodeFunctionData(name) }, at]);
    const [precision, round] = await Promise.all([call("decimals"), call("latestRoundData")]);
    const [observedDecimals] = decode("decimals", precision, 32);
    const [roundId, answer, startedAt, updatedAt] = decode("latestRoundData", round, 160);
    if (observedDecimals !== BigInt(decimals) || updatedAt === 0n || startedAt > updatedAt || updatedAt > BigInt(anchor.blockTime)) {
      throw new Error(`${network}/${symbol}: invalid Chainlink metadata`);
    }
    return { ...anchor, symbol, decimals, roundId, answer, updatedAt: Number(updatedAt) };
  }));
  // A backend or load balancer switching networks cannot silently mix results.
  await checkEvmIdentity(rpc, network, nativeNetwork(network));
  return rows;
}

/** Returns only observations. They do not become prices until CrossChainOracle
 * validates freshness, the two-source agreement, and monotonicity. */
export function chainlinkReader(rpcUrls, { fetcher = fetch } = {}) {
  const readers = ORACLE_NETWORKS.map((network) => [network, createReader(network, rpcUrls?.[network], fetcher)]);
  return async () => (await Promise.all(readers.map(([network, rpc]) => readOnNetwork(network, rpc, PRICE_SYMBOLS)))).flat();
}
