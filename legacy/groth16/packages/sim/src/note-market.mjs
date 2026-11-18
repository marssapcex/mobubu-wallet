import { createHash, randomBytes } from "node:crypto";
import { createVaultTree } from "../../client/src/zk-tree.mjs";
import { SCALAR_FIELD, nonzero } from "../../client/src/zk-format.mjs";
import { valueAmount, valueNoteLeaf, valueStatement } from "../../client/src/zk-value-note.mjs";
import { CrossChainOracle } from "../../../../../packages/oracle/src/market-oracle.mjs";
import { NATIVE_ASSET_IDS, nativeAsset } from "../../../../../fhe-swap/src/network-catalog.mjs";

const ROOT_HISTORY = 32;
const QUOTE_TTL = 300;
const BPS = 10_000n;

function digest(fields) { return createHash("sha256").update(JSON.stringify(fields)).digest("hex"); }
function ceilDiv(n, d) { return (n + d - 1n) / d; }
function cpOut(x, y, input) { return (y * input) / (x + input); }
function cpInput(x, y, output) {
  if (output >= y) throw new Error("insufficient pool liquidity");
  return ceilDiv(x * output, y - output);
}

/** Cross-network spending uses two distinct native inventories, even for ETH→ETH.
 * Exact-out rounds the debit up, exact-in rounds the payout down, and the fee
 * rounds up in both modes. Same-network spending is at par. */
function route(source, target, mode, requested, feeBps) {
  if (source === target) return { amountIn: requested, amountOut: requested, grossHub: 0n, feeHub: 0n };
  let amountIn, amountOut, grossHub, feeHub;
  if (mode === "input") {
    amountIn = requested;
    grossHub = cpOut(source.assetReserve, source.hubReserve, amountIn);
    feeHub = ceilDiv(grossHub * feeBps, BPS);
    amountOut = cpOut(target.hubReserve, target.assetReserve, grossHub - feeHub);
    if (amountOut === 0n) throw new Error("amount too small for one destination base unit");
  } else {
    amountOut = requested;
    const hubNeeded = cpInput(target.hubReserve, target.assetReserve, amountOut);
    grossHub = ceilDiv(hubNeeded * BPS, BPS - feeBps);
    feeHub = ceilDiv(grossHub * feeBps, BPS);
    amountIn = cpInput(source.assetReserve, source.hubReserve, grossHub);
  }
  return { amountIn: valueAmount(amountIn, "source debit"), amountOut: valueAmount(amountOut, "payout"), grossHub, feeHub };
}

function appendNote(state, commitment) {
  const leafIndex = state.tree.append(commitment);
  const root = state.tree.root;
  state.roots.push(root);
  if (state.roots.length > ROOT_HISTORY) state.roots.shift();
  return Object.freeze({ commitment, leafIndex, root });
}

function receivingKey(state, value) {
  const key = nonzero(value, SCALAR_FIELD, "receiving note key");
  if (state.receivingKeys.has(key)) throw new Error("receiving note key already used");
  return key;
}

function recipient(state, destination) {
  if (destination?.kind === "note") {
    return Object.freeze({ kind: "note", noteKey: receivingKey(state, destination.noteKey) });
  }
  if (typeof destination !== "string" || !destination || destination.length > 256 || /\s|[\x00-\x1f\x7f]/u.test(destination)) {
    throw new Error("invalid mock destination");
  }
  return destination;
}

/** In-process simulation ONLY. The fixture supplies receipts and the local
 * Groth16 verifier. An oracle guards prices but cannot authorize a debit.
 * No RPC deposit validation, signing, durable ledger, or chain payout. */
export class MockNoteMarket {
  #assets = new Map();
  #credited = new Set();
  #payouts = new Map();
  #revision = 0n;
  #collectedHubFee = 0n;
  #fee;
  #verify;
  #now;
  #oracle;

  constructor({ liquidity, oracle, verifySpend, feeBps = 30, now = () => Math.floor(Date.now() / 1000) }) {
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= Number(BPS)) throw new RangeError("invalid feeBps");
    if (typeof verifySpend !== "function" || typeof now !== "function") throw new TypeError("local verifier and clock required");
    if (!(oracle instanceof CrossChainOracle)) throw new TypeError("cross-chain oracle required");
    this.#fee = BigInt(feeBps);
    this.#verify = verifySpend;
    this.#now = now;
    this.#oracle = oracle;
    const session = randomBytes(32).toString("hex");
    for (const id of NATIVE_ASSET_IDS) {
      const pool = liquidity?.[id];
      if (!pool) throw new Error(`missing simulated liquidity for ${id}`);
      const asset = nativeAsset(id);
      const tree = createVaultTree();
      const domain = BigInt(`0x${digest(["mobubu-mock-note-v3-network", session, asset.chainRef, id])}`) % SCALAR_FIELD;
      this.#assets.set(id, {
        asset, domain, tree, roots: [tree.root], spent: new Set(), receivingKeys: new Set(), noteBalance: 0n,
        assetReserve: valueAmount(pool.assetReserve, `${id} reserve`),
        hubReserve: valueAmount(pool.hubReserve, `${id} hub reserve`),
      });
    }
  }

  #account(id) { return this.#assets.get(nativeAsset(id).id); }

  position(id) {
    const { domain, tree, noteBalance, assetReserve, hubReserve } = this.#account(id);
    return Object.freeze({ domain, noteBalance, assetReserve, hubReserve, root: tree.root, leaves: tree.size });
  }

  get collectedHubFee() { return this.#collectedHubFee; }
  getPayout(id) { return this.#payouts.get(id); }
  witnessPath(id, leafIndex) { return this.#account(id).tree.path(leafIndex); }

  /** Fixture only. A canonical network and normalized txid protect mock credit
   * against reuse. Real adapters need per-output or per-log economic IDs. */
  creditConfirmed({ asset, txid, received, confirmations, noteKey }) {
    const state = this.#account(asset);
    if (!Number.isSafeInteger(confirmations) || confirmations < 2) throw new Error("mock deposit not confirmed");
    if (typeof txid !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(txid)) throw new Error("invalid mock txid");
    const claim = `${state.asset.chainRef}:${txid.toLowerCase().replace(/^0x/, "")}`;
    if (this.#credited.has(claim)) throw new Error("mock deposit already credited");
    const amount = valueAmount(received, "received amount");
    const key = receivingKey(state, noteKey);
    const inserted = appendNote(state, valueNoteLeaf(key, amount));
    state.noteBalance += amount;
    state.receivingKeys.add(key);
    this.#credited.add(claim);
    return inserted;
  }

  #seconds() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - QUOTE_TTL) throw new Error("invalid mock clock");
    return now;
  }

  #price(from, to, mode, amount, now, validUntil) {
    if (mode !== "input" && mode !== "output") throw new Error("quote mode must be input or output");
    const source = this.#account(from), target = this.#account(to);
    const terms = route(source, target, mode, valueAmount(amount), this.#fee);
    const snapshot = source === target ? null : this.#oracle.checkQuote(from, to, terms.amountIn, terms.amountOut, now);
    const deadline = Math.min(now + QUOTE_TTL, snapshot?.validUntil ?? Infinity);
    if (validUntil !== undefined && validUntil > deadline) throw new Error("quote outlives the oracle or quote deadline");
    return Object.freeze({ from, to, mode, ...terms, oracleId: snapshot?.id ?? null,
      revision: source === target ? 0n : this.#revision, validUntil: validUntil ?? deadline });
  }

  quote(from, to, mode, amount) { return this.#price(from, to, mode, amount, this.#seconds()); }

  #checkQuote(quote) {
    const now = this.#seconds();
    if (!quote || !Number.isSafeInteger(quote.validUntil) || quote.validUntil <= now) throw new Error("expired or invalid quote deadline");
    if (quote.revision !== (quote.from === quote.to ? 0n : this.#revision)) throw new Error("quote is stale; requote");
    const current = this.#price(quote.from, quote.to, quote.mode, quote.mode === "input" ? quote.amountIn : quote.amountOut, now, quote.validUntil);
    if (quote.oracleId !== current.oracleId) throw new Error("oracle snapshot changed; requote");
    if (Object.keys(current).some((key) => current[key] !== quote[key])) throw new Error("quote terms do not match pool");
    return current;
  }

  preparePayout(quote, destination) {
    const terms = this.#checkQuote(quote);
    const source = this.#account(terms.from), target = this.#account(terms.to);
    const receiver = recipient(target, destination);
    const binding = digest([
      "mobubu-mock-payout-v3-network", source.domain.toString(), target.asset.chainRef,
      terms.from, terms.to, terms.mode, typeof receiver === "string" ? ["mock-payout", receiver] : ["note", receiver.noteKey.toString()],
      terms.amountIn.toString(), terms.amountOut.toString(), terms.grossHub.toString(), terms.feeHub.toString(),
      terms.oracleId, terms.revision.toString(), terms.validUntil,
    ]);
    return Object.freeze({ quote: terms, destination: receiver, payoutBinding: BigInt(`0x${binding.slice(0, 62)}`) });
  }

  #checkSpend(state, root, nullifierHash, amount) {
    if (state.spent.has(nullifierHash)) throw new Error("note already spent");
    if (!state.roots.includes(root)) throw new Error("unknown note root");
    if (state.noteBalance < amount) throw new Error("insufficient note liability");
  }

  async withdraw({ quote, destination, root, nullifierHash, changeCommitment, proof }) {
    const payout = this.preparePayout(quote, destination);
    const terms = payout.quote;
    const source = this.#account(terms.from), target = this.#account(terms.to);
    const signals = Object.freeze(valueStatement({
      root, nullifierHash, changeCommitment, amount: terms.amountIn,
      domain: source.domain, payoutBinding: payout.payoutBinding,
    }));
    const [knownRoot, spentId, , , change] = signals;
    this.#checkSpend(source, knownRoot, spentId, terms.amountIn);
    if (!Array.isArray(proof) || proof.length !== 3 || (await this.#verify(structuredClone(proof), signals)) !== true) {
      throw new Error("invalid note spend proof");
    }
    // Check again after the verifier awaited. No mutation (including a change
    // leaf) before both output slots, the oracle, and nullifier are revalidated.
    this.#checkSpend(source, knownRoot, spentId, terms.amountIn);
    this.#checkQuote(terms);
    const key = typeof payout.destination === "string" ? null : receivingKey(target, payout.destination.noteKey);
    const nextLeaf = key === null ? null : valueNoteLeaf(key, terms.amountOut);
    const sourceLeaves = change === 0n ? [] : [change];
    if (nextLeaf !== null && source === target) sourceLeaves.push(nextLeaf);
    source.tree.assertCanAppend(sourceLeaves);
    if (nextLeaf !== null && source !== target) target.tree.assertCanAppend([nextLeaf]);

    const payoutId = digest(["mobubu-mock-payout-record-v3", source.domain.toString(), spentId.toString()]);
    const inserted = change === 0n ? null : appendNote(source, change);
    const receivedNote = nextLeaf === null ? null : appendNote(target, nextLeaf);
    source.spent.add(spentId);
    source.noteBalance -= terms.amountIn;
    if (receivedNote) {
      target.receivingKeys.add(key);
      target.noteBalance += terms.amountOut;
    }
    if (source !== target) {
      source.assetReserve += terms.amountIn;
      source.hubReserve -= terms.grossHub;
      target.hubReserve += terms.grossHub - terms.feeHub;
      target.assetReserve -= terms.amountOut;
      this.#collectedHubFee += terms.feeHub;
      this.#revision++;
    }
    const record = Object.freeze({ payoutId, chain: target.asset.network, chainRef: target.asset.chainRef,
      kind: receivedNote ? "note-transfer" : "mock-payout",
      destination: receivedNote ? null : payout.destination, receivedNote,
      from: terms.from, to: terms.to, amountIn: terms.amountIn, amountOut: terms.amountOut,
      feeHub: terms.feeHub, oracleId: terms.oracleId, change: inserted });
    this.#payouts.set(payoutId, record);
    return record;
  }
}
