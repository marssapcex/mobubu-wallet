import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, id } from "ethers";
import { BITCOIN_GENESIS, NATIVE_ASSET_IDS, NATIVE_NETWORKS, nativeAsset, parseNativeAssetArg } from "../fhe-swap/src/network-catalog.mjs";
import { chainlinkReader, probeNativeNetwork } from "../packages/oracle/src/chainlink.mjs";
import { FEED_POLICY } from "../packages/oracle/src/feed-policy.mjs";
import { oracleRateResolver, exactOutput } from "../packages/pool/src/withdrawal-quote.mjs";
import { CrossChainOracle } from "../packages/oracle/src/market-oracle.mjs";
import { fixtureObservations } from "../scripts/note-fixtures.mjs";

const T = 20_000;
const BTC = "BTC@bitcoin", ETH = "ETH@ethereum", BNB = "BNB@bsc";
const ONE = 10n ** 18n;
const usd = 10n ** 8n;
const qty = (n) => `0x${n.toString(16)}`;
const EVM_IDS = { ethereum: 1, bsc: 56 };
const rpcUrls = { ethereum: "https://eth.example.test", bsc: "https://bsc.example.test" };

const check = (oracle, now = T) => oracle.checkQuote(BTC, ETH, 100_000_000n, 20n * ONE, now);

test("the mainnet catalog exposes only Bitcoin, Ethereum and BNB Smart Chain", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(NATIVE_NETWORKS).filter(([, v]) => v.family === "evm")
    .map(([key, value]) => [key, value.chainId])), EVM_IDS);
  assert.equal(NATIVE_ASSET_IDS.length, 3);
  assert.equal(new Set(NATIVE_ASSET_IDS.map((asset) => nativeAsset(asset).chainRef)).size, 3);
  assert.equal(NATIVE_ASSET_IDS.filter((asset) => nativeAsset(asset).symbol === "ETH").length, 1);
  assert.equal(nativeAsset(BTC).decimals, 8);
  assert.equal(nativeAsset("BNB@bsc").decimals, 18);
  assert.equal(nativeAsset(BNB).chainRef, "eip155:56");
  assert.equal(parseNativeAssetArg("ETH"), ETH);
  for (const name of ["ETH@base", "ETH@arbitrum-one", "WETH@base", "BNB@base", "ETH@robinhood-testnet", "ETH@4663", "constructor"]) {
    assert.throws(() => parseNativeAssetArg(name), /unsupported native asset/);
  }
});

test("read-only probes verify the actual RPC identity for the three enabled networks", async () => {
  for (const [key, meta] of Object.entries(NATIVE_NETWORKS)) {
    const rpc = `https://${key}.example.test/`;
    async function fetcher(url, init) {
      assert.equal(url, rpc);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      const { id, method, params } = JSON.parse(init.body);
      const btc = key === "bitcoin";
      assert.equal(method, btc ? "getblockhash" : "eth_chainId");
      assert.deepEqual(params, btc ? [0] : []);
      return Response.json({ jsonrpc: "2.0", id, result: btc ? BITCOIN_GENESIS : qty(EVM_IDS[key]) });
    }
    assert.equal(await probeNativeNetwork(key, rpc, { fetcher }), meta);
  }
  const chainResponse = (result) => async (_url, request) => Response.json({ jsonrpc: "2.0", id: JSON.parse(request.body).id, result });
  await assert.rejects(probeNativeNetwork("base", rpcUrls.ethereum, { fetcher: chainResponse("0x1") }), /unsupported network/);
  await assert.rejects(probeNativeNetwork("bsc", rpcUrls.ethereum, { fetcher: chainResponse(qty(1)) }), /RPC chain ID mismatch/);
  await assert.rejects(probeNativeNetwork("bitcoin", rpcUrls.ethereum, { fetcher: chainResponse("0".repeat(64)) }), /genesis mismatch/);
  await assert.rejects(probeNativeNetwork("bsc", "http://bad.example.test"), /configure an HTTPS RPC/);
});

test("two-source snapshots use exact BTC/ETH units, bounded quote deviation, and expire at the earliest deadline", async () => {
  const oracle = new CrossChainOracle({ read: () => fixtureObservations(T).reverse(), now: () => T });
  assert.throws(() => check(oracle), /snapshot unavailable/);
  const snapshot = await oracle.refresh();
  assert.deepEqual(snapshot.pricesUsd18, { BTC: 60_000n * ONE, ETH: 3_000n * ONE, BNB: 250n * ONE });
  assert.equal(snapshot.validUntil, T + 180);
  assert.equal(check(oracle), snapshot);
  assert.ok(Object.isFrozen(snapshot.observations[0]));
  assert.equal(oracle.checkQuote(ETH, BNB, ONE, 12n * ONE, T), snapshot);
  assert.throws(() => oracle.checkQuote(ETH, BNB, ONE, 1176n * ONE / 100n - 1n, T), /deviates/);
  assert.throws(() => oracle.checkQuote(ETH, BNB, ONE, 1224n * ONE / 100n + 1n, T), /deviates/);
  assert.throws(() => check(oracle, T + 180), /expired/);
  assert.throws(() => check(oracle, T - 1), /expired/);
});

test("withdrawal rates expire at their reference snapshot and preserve native base units", async () => {
  let now = T;
  const oracle = new CrossChainOracle({ read: () => fixtureObservations(now), now: () => now });
  const getRate = oracleRateResolver(oracle);
  const route = { source: `0x${"bc".repeat(32)}`, destination: `0x${"ac".repeat(32)}`, nonce: `0x${"ae".repeat(32)}` };
  assert.throws(() => getRate({ ...route, from: ETH, to: BNB }), /unavailable/);
  const snap = await oracle.refresh();
  for (const from of NATIVE_ASSET_IDS) for (const to of NATIVE_ASSET_IDS) {
    if (from === to) continue;
    const rate = getRate({ ...route, from, to });
    const debit = 10n ** BigInt(nativeAsset(from).decimals);
    const market = snap.pricesUsd18[nativeAsset(from).symbol] * 10n ** BigInt(nativeAsset(to).decimals);
    const price = snap.pricesUsd18[nativeAsset(to).symbol];
    const out = exactOutput({ from, to, rate }, debit);
    assert.ok(out <= market / price);
    assert.ok((out + 1n) * 1_000_000n * price >= 999_999n * market);
    assert.equal(rate.validUntil, snap.validUntil);
    assert.equal(rate.rateRef, `0x${snap.id}`);
  }
  assert.throws(() => getRate({ ...route, from: ETH, to: ETH }), /no quote/);
  now = snap.validUntil;
  assert.throws(() => getRate({ ...route, from: ETH, to: BNB }), /expired/);
});

test("snapshot rejects missing sources, duplicate feeds, stale/future/invalid rounds and price disagreement", async () => {
  const cases = [
    [(rows) => { rows.pop(); }, /both source networks/],
    [(rows) => { rows[5] = rows[4]; }, /duplicate/],
    [(rows) => { rows[0].blockHash = `0x${"aa".repeat(32)}`; }, /same block/],
    [(rows) => { rows[0].updatedAt -= 5_400; }, /stale oracle price/],
    [(rows) => { rows[0].updatedAt++; }, /invalid oracle round/],
    [(rows) => { rows[0].updatedAt = 0; }, /invalid oracle round/],
    [(rows) => { rows[0].roundId = 0n; }, /invalid oracle round/],
    [(rows) => { rows[0].answer = -1n; }, /invalid oracle round/],
    [(rows) => { rows[0].decimals = 18; }, /invalid oracle round/],
    [(rows) => { rows[0].blockTime++; }, /invalid oracle block/],
    [(rows) => { rows[0].blockTime -= 1_800; }, /stale oracle block/],
  ];
  for (const [modify, expected] of cases) {
    const rows = fixtureObservations(T);
    const oracle = new CrossChainOracle({ read: () => rows, now: () => T });
    await oracle.refresh();
    modify(rows);
    await assert.rejects(oracle.refresh(), expected);
    assert.throws(() => check(oracle), /snapshot unavailable/);
  }
  let now = T;
  let rows = fixtureObservations(now);
  const oracle = new CrossChainOracle({ read: () => rows, now: () => now });
  await oracle.refresh();
  rows[5].roundId++;
  await assert.rejects(oracle.refresh(), /round went backwards or changed/);
  rows = fixtureObservations(++now);
  rows[5].answer *= 2n;
  await assert.rejects(oracle.refresh(), /oracle sources disagree/);
  assert.throws(() => check(oracle, now), /snapshot unavailable/);
});

test("oracle pauses during refresh, refuses concurrent refresh, and does not clear rollback watermarks on errors", async () => {
  let now = T, wait = null, rows = fixtureObservations(now);
  const oracle = new CrossChainOracle({ read: () => wait ?? rows, now: () => now });
  await oracle.refresh();
  let release;
  wait = new Promise((resolve) => { release = resolve; });
  const reading = oracle.refresh();
  assert.throws(() => check(oracle), /snapshot unavailable/);
  await assert.rejects(oracle.refresh(), /already in progress/);
  release(rows);
  await reading;
  wait = null;
  now++;
  rows = fixtureObservations(now);
  await oracle.refresh();
  rows = fixtureObservations(T);
  await assert.rejects(oracle.refresh(), /went backwards/);
  assert.throws(() => check(oracle, now), /snapshot unavailable/);
  await assert.rejects(oracle.refresh(), /went backwards/);
});

const coder = AbiCoder.defaultAbiCoder();
const DECIMALS = id("decimals()").slice(0, 10);
const ROUND = id("latestRoundData()").slice(0, 10);
const values = { BTC: 60_000n, ETH: 3_000n, BNB: 250n };

function rpcFixture(override = () => undefined) {
  const calls = [];
  async function fetcher(url, init) {
    const chain = new URL(url).hostname.startsWith("eth.") ? "ethereum" : "bsc";
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const call = JSON.parse(init.body);
    calls.push({ ...call, chain });
    const { id, method, params } = call;
    const blockHash = `0x${(chain === "ethereum" ? "ab" : "cd").repeat(32)}`;
    const reply = (result) => Response.json({ jsonrpc: "2.0", id, result });
    const replaced = override({ chain, method, params, reply });
    if (replaced) return replaced;
    if (method === "eth_chainId") return reply(qty(EVM_IDS[chain]));
    if (method === "eth_getBlockByNumber") {
      assert.deepEqual(params, ["finalized", false]);
      return reply({ number: "0x1000", hash: blockHash, timestamp: qty(T - 1) });
    }
    assert.equal(method, "eth_call");
    const [{ to, data }, block] = params;
    assert.deepEqual(block, { blockHash, requireCanonical: true });
    const symbol = Object.keys(values).find((s) => FEED_POLICY[chain][s].proxy === to);
    assert.ok(symbol);
    if (data === DECIMALS) return reply(coder.encode(["uint8"], [8]));
    assert.equal(data, ROUND);
    return reply(coder.encode(["uint80", "int256", "uint256", "uint256", "uint80"], [11, values[symbol] * usd, T - 40, T - 10, 11]));
  }
  return { calls, fetcher };
}

test("the Chainlink reader calls only pinned proxies on canonical finalized block hashes", async () => {
  const { calls, fetcher } = rpcFixture();
  const oracle = new CrossChainOracle({ read: chainlinkReader(rpcUrls, { fetcher }), now: () => T });
  const result = await oracle.refresh();
  assert.equal(result.observations.length, 6);
  assert.equal(result.pricesUsd18.BNB, 250n * ONE);
  assert.equal(calls.filter((call) => call.method === "eth_call").length, 12);
  assert.ok(result.observations.every((row) => row.block === 0x1000n && row.roundId === 11n));
});

test("RPC failures and chain/decimal mismatches never become an accepted fallback price", async () => {
  const faults = [
    [(c) => c.chain === "bsc" && c.method === "eth_chainId" && c.reply("0x1"), /chain ID mismatch/],
    [(c) => c.method === "eth_getBlockByNumber" && c.reply(null), /finalized block unavailable/],
    [(c) => c.method === "eth_call" && c.params[0].data === DECIMALS && c.reply(coder.encode(["uint8"], [18])), /invalid Chainlink metadata/],
    [(c) => c.method === "eth_call" && c.reply("0xdead"), /invalid Chainlink/],
    [(c) => c.method === "eth_call" && new Response("x".repeat(2 * 1024 * 1024 + 1)), /RPC read failed/],
  ];
  for (const [fault, expected] of faults) {
    const { fetcher } = rpcFixture(fault);
    const oracle = new CrossChainOracle({ read: chainlinkReader(rpcUrls, { fetcher }), now: () => T });
    await assert.rejects(oracle.refresh(), expected);
    assert.throws(() => check(oracle), /snapshot unavailable/);
  }
  const nope = async () => { throw new Error("https://example.test/?token=do-not-print"); };
  const read = chainlinkReader(rpcUrls, { fetcher: nope });
  await assert.rejects(read(), (error) => /RPC read failed/.test(error.message) && !error.message.includes("do-not-print"));
});
