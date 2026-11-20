import { createHash } from "node:crypto";
import { nativeAsset } from "../../../fhe-swap/src/network-catalog.mjs";
import {
  FEED_POLICY, MAX_ANCHOR_AGE, MAX_QUOTE_DEVIATION_BPS, MAX_SOURCE_SPREAD_BPS,
  ORACLE_NETWORKS, PRICE_SYMBOLS, SNAPSHOT_TTL,
} from "./feed-policy.mjs";

const BPS = 10_000n;
const UINT80 = 1n << 80n;
const INT256 = 1n << 255n;
const hash = /^0x[0-9a-f]{64}$/;
const unixSeconds = () => Math.floor(Date.now() / 1_000);
const timestamp = (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER - 86_400;
const distance = (a, b) => (a > b ? a - b : b - a);

function normalize(row, now) {
  const { network, symbol, block, blockHash, blockTime, roundId, answer, decimals, updatedAt } = row ?? {};
  if (typeof network !== "string" || !Object.hasOwn(FEED_POLICY, network) ||
      typeof symbol !== "string" || !Object.hasOwn(FEED_POLICY[network], symbol)) {
    throw new Error("unexpected oracle feed");
  }
  const feed = FEED_POLICY[network][symbol];
  if (typeof block !== "bigint" || block <= 0n || block >= (1n << 64n) ||
      typeof blockHash !== "string" || !hash.test(blockHash) || !timestamp(blockTime) || blockTime > now) {
    throw new Error("invalid oracle block anchor");
  }
  if (now - blockTime >= MAX_ANCHOR_AGE[network]) throw new Error("stale oracle block anchor");
  if (decimals !== feed.decimals || typeof answer !== "bigint" || answer <= 0n || answer >= INT256 ||
      typeof roundId !== "bigint" || roundId <= 0n || roundId >= UINT80 || !timestamp(updatedAt) || updatedAt > blockTime) {
    throw new Error("invalid oracle round");
  }
  const validUntil = Math.min(blockTime + MAX_ANCHOR_AGE[network], updatedAt + feed.maxAgeSeconds);
  if (validUntil <= now) throw new Error("stale oracle price");
  return Object.freeze({ network, symbol, proxy: feed.proxy, block, blockHash, blockTime, roundId, answer, decimals, updatedAt, validUntil });
}

function makeSnapshot(observations, now, previous) {
  if (!timestamp(now)) throw new Error("invalid oracle clock");
  if (!Array.isArray(observations) || observations.length !== ORACLE_NETWORKS.length * PRICE_SYMBOLS.length) {
    throw new Error("oracle requires both source networks for every symbol");
  }
  const rows = new Map(), anchors = new Map();
  for (const observation of observations) {
    const row = normalize(observation, now);
    const key = `${row.network}/${row.symbol}`;
    if (rows.has(key)) throw new Error("duplicate oracle feed");
    const anchor = anchors.get(row.network);
    if (anchor && (anchor.block !== row.block || anchor.blockHash !== row.blockHash || anchor.blockTime !== row.blockTime)) {
      throw new Error("oracle feeds not read at the same block");
    }
    anchors.set(row.network, row);
    rows.set(key, row);
  }
  for (const old of previous?.observations ?? []) {
    const row = rows.get(`${old.network}/${old.symbol}`);
    const roundChanged = row.roundId !== old.roundId || row.answer !== old.answer || row.updatedAt !== old.updatedAt;
    if (row.block < old.block || row.blockTime < old.blockTime ||
        (row.block === old.block && (row.blockHash !== old.blockHash || row.blockTime !== old.blockTime || roundChanged)) ||
        row.roundId < old.roundId || row.updatedAt < old.updatedAt || (row.roundId === old.roundId && roundChanged)) {
      throw new Error("oracle anchor or round went backwards or changed");
    }
  }
  const pricesUsd18 = {};
  for (const symbol of PRICE_SYMBOLS) {
    const [a, b] = ORACLE_NETWORKS.map((network) => {
      const row = rows.get(`${network}/${symbol}`);
      return row.answer * 10n ** BigInt(18 - row.decimals);
    });
    const lower = a < b ? a : b;
    if (distance(a, b) * BPS > lower * MAX_SOURCE_SPREAD_BPS) throw new Error(`oracle sources disagree for ${symbol}`);
    pricesUsd18[symbol] = (a + b) / 2n;
  }
  const ordered = [...rows.values()].sort((a, b) => {
    const x = `${a.network}/${a.symbol}`, y = `${b.network}/${b.symbol}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const validUntil = Math.min(now + SNAPSHOT_TTL, ...ordered.map((row) => row.validUntil));
  const id = createHash("sha256").update(JSON.stringify(["mobubu-usd-oracle-v1", now, validUntil, ordered],
    (_key, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
  return Object.freeze({ id, asOf: now, validUntil, pricesUsd18: Object.freeze(pricesUsd18), observations: Object.freeze(ordered) });
}

/** Trusted operator-controlled reader. No quote or trade data is sent to an RPC.
 * A refresh in progress or a failed refresh pauses FX; no fallback to fixtures.
 * In-process only: watermarks and the active snapshot are not durable. */
export class CrossChainOracle {
  #read;
  #now;
  #last = null;
  #active = null;
  #refreshing = false;

  constructor({ read, now = unixSeconds }) {
    if (typeof read !== "function" || typeof now !== "function") throw new TypeError("oracle reader and clock required");
    this.#read = read;
    this.#now = now;
  }

  async refresh() {
    if (this.#refreshing) throw new Error("oracle refresh already in progress");
    this.#refreshing = true;
    this.#active = null;
    try {
      const rows = await this.#read();
      const now = this.#now();
      if (this.#last && now < this.#last.asOf) throw new Error("oracle clock went backwards");
      this.#active = this.#last = makeSnapshot(rows, now, this.#last);
      return this.#active;
    } finally {
      this.#refreshing = false;
    }
  }

  snapshot(now = this.#now()) {
    const active = this.#active;
    if (!active || !timestamp(now) || now < active.asOf || now >= active.validUntil) {
      throw new Error("oracle snapshot unavailable or expired");
    }
    return active;
  }

  checkQuote(from, to, amountIn, amountOut, now = this.#now()) {
    const a = nativeAsset(from), b = nativeAsset(to);
    const snapshot = this.snapshot(now);
    if (typeof amountIn !== "bigint" || amountIn <= 0n || typeof amountOut !== "bigint" || amountOut <= 0n) {
      throw new Error("invalid oracle quote amounts");
    }
    // Compare value in base units without division; this does not authorize a payout.
    const inputValue = amountIn * snapshot.pricesUsd18[a.symbol] * 10n ** BigInt(b.decimals);
    const outputValue = amountOut * snapshot.pricesUsd18[b.symbol] * 10n ** BigInt(a.decimals);
    if (distance(inputValue, outputValue) * BPS > inputValue * MAX_QUOTE_DEVIATION_BPS) {
      throw new Error("pool quote deviates from oracle reference");
    }
    return snapshot;
  }
}
