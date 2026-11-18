import { assertAsset, chainOf, type Asset, type Chain } from "../assets.js";
import type { ChainAdapter, ThresholdSigner } from "../chains/types.js";
import type { FheEvaluator } from "../fhe/types.js";
import { intentId } from "./intent.js";
import { EncryptedMatcher, expectedNetOutThor } from "./matcher.js";
import { enforcePrivacy } from "./privacy.js";
import type { PoolBook } from "./pool.js";
import type {
  EncryptedSwapIntent,
  InboundObservation,
  OutboundInstruction,
  PoolQuote,
  SwapRecord,
} from "./types.js";
import { fromThorUnits, toThorUnits } from "./units.js";

/**
 * Opens the encrypted intent after inbound deposit.
 *
 * Production warning: this must be threshold FHE decryption or a client-side
 * opening proof verified by the vault set. A single plaintext oracle defeats
 * the privacy model. The demo opener is intentionally local and untrusted for
 * production use.
 */
export interface IntentOpener {
  open(intent: EncryptedSwapIntent): Promise<{
    amountThor: bigint;
    minOutThor: bigint;
  }>;
}

export interface EngineConfig {
  evaluator: FheEvaluator;
  pools: PoolBook;
  adapters: Partial<Record<Chain, ChainAdapter>>;
  signer: ThresholdSigner;
  opener: IntentOpener;
  /** Reject transparent->transparent pairs when true. */
  requireShieldedLeg?: boolean;
  /** Reject mixed pairs too; only XMR<->ZEC passes when true. */
  requireBothShielded?: boolean;
  /** Unix seconds. */
  now?: () => number;
}

/**
 * Reference cross-chain swap engine.
 *
 * Flow:
 * 1. Client encrypts amount/minOut under the FHE public key.
 * 2. Matcher computes an encrypted quote without seeing amount/minOut.
 * 3. Client decrypts quote, checks minOut locally, then deposits inbound.
 * 4. Vault observes/confirms inbound and opens the intent via `IntentOpener`.
 * 5. Vault signs/broadcasts outbound or refunds.
 *
 * Timestamps in SwapRecord are Unix seconds. InboundObservation.observedAt may
 * use the adapter's own clock convention; the engine does not rely on it.
 *
 * Only BTC, ETH, XMR, ZEC, DAI are routable. DAI uses the Ethereum adapter.
 */
export class SwapEngine {
  private records = new Map<string, SwapRecord>();
  private intents = new Map<string, EncryptedSwapIntent>();
  private busy = new Set<string>();
  private matcher: EncryptedMatcher;
  private now: () => number;

  constructor(private readonly cfg: EngineConfig) {
    this.matcher = new EncryptedMatcher(cfg.evaluator);
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get(id: string): SwapRecord | undefined {
    return this.records.get(id);
  }

  list(): SwapRecord[] {
    return [...this.records.values()];
  }

  submitIntent(intent: EncryptedSwapIntent): SwapRecord {
    const { header } = intent;
    const from = assertAsset(header.pair.from);
    const to = assertAsset(header.pair.to);
    if (from === to) throw new Error("self-swap is not supported");
    if (!header.destination || !header.refundAddress) {
      throw new Error("destination and refundAddress are required");
    }
    if (!Number.isSafeInteger(header.deadline) || header.deadline <= 0) {
      throw new Error("deadline must be a positive unix timestamp in seconds");
    }
    const expectedId = intentId(
      {
        pair: header.pair,
        destination: header.destination,
        refundAddress: header.refundAddress,
        deadline: header.deadline,
        memoHash: header.memoHash,
      },
      intent.payload.values.ciphertext,
    );
    if (header.id !== expectedId) {
      throw new Error("intent id does not bind header to encrypted payload");
    }
    if (this.records.has(header.id)) {
      throw new Error("intent already exists");
    }
    if (header.deadline <= this.now()) {
      throw new Error("intent deadline already passed");
    }

    const privacy = enforcePrivacy(
      header.pair,
      this.cfg.requireShieldedLeg ?? false,
    );
    if (this.cfg.requireBothShielded && privacy.level !== "shielded") {
      throw new Error(
        `Privacy policy rejected ${from}->${to}: both legs must be shielded (XMR/ZEC).`,
      );
    }

    this.adapterFor(from);
    this.adapterFor(to);
    const pool = this.cfg.pools.get(header.pair);
    const quote = this.matcher.quote(intent, pool.quote());

    const record: SwapRecord = {
      header,
      state: "created",
      quote,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.records.set(header.id, record);
    this.intents.set(header.id, intent);
    return record;
  }

  /** Backwards-compatible alias; payload is now always stored. */
  submitIntentWithPayload(intent: EncryptedSwapIntent): SwapRecord {
    return this.submitIntent(intent);
  }

  async observeInbound(intentId: string): Promise<SwapRecord> {
    const record = this.mustGet(intentId);
    if (record.state !== "created" && record.state !== "inbound_observed") {
      return record;
    }

    const asset = record.header.pair.from;
    const adapter = this.adapterFor(asset);
    const obs = await adapter.scanInbound(intentId, asset);
    if (!obs) return record;
    this.assertInbound(obs, intentId, adapter.chain, asset);

    record.inbound = { ...obs };
    record.state = "inbound_observed";
    record.updatedAt = this.now();

    const required = adapter.requiredConfirmations(asset);
    if (!Number.isInteger(required) || required < 1) {
      throw new Error(`invalid confirmation requirement for ${asset}`);
    }
    const confirmations = await adapter.getConfirmations(obs.txHash);
    if (!Number.isInteger(confirmations) || confirmations < 0) {
      throw new Error(`invalid confirmation count for ${obs.txHash}`);
    }
    record.inbound.confirmations = confirmations;
    if (confirmations >= required) {
      record.state = "inbound_confirmed";
      record.updatedAt = this.now();
    }
    return record;
  }

  async settle(intentId: string): Promise<SwapRecord> {
    return this.withLock(intentId, () => this.settleUnlocked(intentId));
  }

  async refund(intentId: string, reason: string): Promise<SwapRecord> {
    return this.withLock(intentId, async () => {
      const record = this.mustGet(intentId);
      return this.refundRecord(record, reason);
    });
  }

  private async settleUnlocked(intentId: string): Promise<SwapRecord> {
    const record = this.mustGet(intentId);
    if (record.state === "completed" || record.state === "refunded") {
      return record;
    }
    if (record.state === "outbound_signed" || record.state === "outbound_broadcast") {
      throw new Error("outbound already signed; manual recovery required");
    }

    if (record.state !== "inbound_confirmed") {
      await this.observeInbound(intentId);
    }
    if (record.state !== "inbound_confirmed" || !record.inbound) {
      throw new Error("inbound not confirmed");
    }
    const quote = record.quote;
    if (!quote) throw new Error("missing encrypted quote");

    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("missing original encrypted intent");

    if (this.now() > record.header.deadline) {
      return this.refundRecord(record, "deadline passed");
    }

    const opened = await this.cfg.opener.open(intent);
    if (
      opened.amountThor <= 0n ||
      opened.minOutThor < 0n ||
      opened.amountThor >= this.cfg.evaluator.plainModulus ||
      opened.minOutThor >= this.cfg.evaluator.plainModulus
    ) {
      throw new Error("opener returned invalid amount/minOut");
    }
    if (opened.amountThor > quote.maxInputThor) {
      return this.refundRecord(record, "intent amount exceeds quoted maxInputThor");
    }

    const observedThor = toThorUnits(
      record.header.pair.from,
      record.inbound.amountBaseUnits,
    );
    if (observedThor < opened.amountThor) {
      return this.refundRecord(
        record,
        "inbound amount below encrypted intent amount",
      );
    }
    if (observedThor > opened.amountThor) {
      return this.refundRecord(
        record,
        "inbound amount above encrypted intent amount",
      );
    }

    // Settle against the public terms captured at submit time, not a mutable
    // pool object that may have changed after the client saw the quote.
    const quotedPool: PoolQuote = {
      pair: record.header.pair,
      priceScaled: quote.priceScaled,
      feeBps: quote.feeBps,
      maxInputThor: quote.maxInputThor,
    };
    const netOutThor = expectedNetOutThor(opened.amountThor, quotedPool);
    if (netOutThor < opened.minOutThor) {
      return this.refundRecord(record, "minOut not met");
    }
    if (netOutThor <= 0n) {
      return this.refundRecord(record, "net output is zero");
    }

    const outbound: OutboundInstruction = {
      intentId,
      chain: chainOf(record.header.pair.to),
      asset: record.header.pair.to,
      to: record.header.destination,
      amountBaseUnits: fromThorUnits(record.header.pair.to, netOutThor),
      memoHash: record.header.memoHash,
    };
    record.outbound = outbound;

    const adapter = this.adapterFor(record.header.pair.to);
    const unsigned = await adapter.buildOutbound(outbound);
    const signed = await this.cfg.signer.sign(
      adapter.chain,
      record.header.pair.to,
      unsigned,
    );
    record.signed = {
      intentId,
      chain: adapter.chain,
      rawTx: signed.rawTx,
      txHash: signed.txHash,
    };
    record.state = "outbound_signed";
    record.updatedAt = this.now();

    const broadcastHash = await adapter.broadcast(signed.rawTx);
    record.signed.txHash = broadcastHash;
    record.state = "outbound_broadcast";
    record.updatedAt = this.now();

    // Reference engine marks completed once broadcast is accepted.
    // Production must wait outbound confirmations and handle reorgs.
    record.state = "completed";
    record.updatedAt = this.now();
    return record;
  }

  private async refundRecord(
    record: SwapRecord,
    reason: string,
  ): Promise<SwapRecord> {
    if (record.state === "refunded" || record.state === "completed") {
      return record;
    }
    if (record.state === "outbound_signed" || record.state === "outbound_broadcast") {
      throw new Error("cannot refund after outbound has been signed");
    }
    if (!record.inbound) {
      record.state = "failed";
      record.error = reason;
      record.updatedAt = this.now();
      return record;
    }

    const adapter = this.adapterFor(record.header.pair.from);
    const refund: OutboundInstruction = {
      intentId: record.header.id,
      chain: adapter.chain,
      asset: record.header.pair.from,
      to: record.header.refundAddress,
      amountBaseUnits: record.inbound.amountBaseUnits,
      memoHash: record.header.memoHash,
    };
    const unsigned = await adapter.buildOutbound(refund);
    const signed = await this.cfg.signer.sign(
      adapter.chain,
      record.header.pair.from,
      unsigned,
    );
    await adapter.broadcast(signed.rawTx);
    record.state = "refunded";
    record.error = reason;
    record.updatedAt = this.now();
    return record;
  }

  private assertInbound(
    obs: InboundObservation,
    intentId: string,
    chain: Chain,
    asset: Asset,
  ): void {
    if (obs.intentId !== intentId) throw new Error("inbound intent id mismatch");
    if (obs.chain !== chain) throw new Error("inbound chain mismatch");
    if (obs.asset !== asset) throw new Error("inbound asset mismatch");
    if (!obs.txHash) throw new Error("inbound txHash missing");
    if (obs.amountBaseUnits < 0n) throw new Error("inbound amount negative");
  }

  private async withLock(
    id: string,
    fn: () => Promise<SwapRecord>,
  ): Promise<SwapRecord> {
    if (this.busy.has(id)) {
      throw new Error(`intent ${id} operation already in progress`);
    }
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }

  private adapterFor(asset: Asset): ChainAdapter {
    const chain = chainOf(asset);
    const adapter = this.cfg.adapters[chain];
    if (!adapter) throw new Error(`no adapter for chain ${chain}`);
    if (adapter.chain !== chain || !adapter.assets.includes(asset)) {
      throw new Error(`adapter ${adapter.chain} cannot settle ${asset}`);
    }
    return adapter;
  }

  private mustGet(id: string): SwapRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown intent ${id}`);
    return record;
  }
}
