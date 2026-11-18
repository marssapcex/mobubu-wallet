import { randomBytes } from "node:crypto";
import { assertAsset, chainOf, type Asset, type Chain } from "../assets.js";
import type {
  ChainAdapter, InboundObservation, OutboundInstruction, SignedOutbound, ThresholdSigner,
} from "../chains/types.js";
import type { ArbBot } from "./arb.js";
import { HubPoolBook, HubRouter, type ArbAction } from "./hub.js";
import { PrivateOrderFlow } from "./orderflow.js";
import { TokenTreasury } from "./token.js";
import {
  type SealedOrder,
  type ThresholdShare,
  normalizeSealedOrder,
  ThresholdOrderOpener,
} from "../privacy/threshold.js";
import { fromThorUnits, toThorUnitsExact } from "./units.js";

export interface StreamingSchedule {
  /** Seconds between subswaps. */
  intervalSeconds: number;
  /** Number of subswaps. */
  quantity: number;
}

/**
 * Plaintext order opened only inside the vault committee.
 * Bigints are encoded as decimal strings for JSON sealing.
 */
export interface StreamingOrderPlain {
  from: Asset;
  to: Asset;
  amountThor: string;
  minOutThor: string;
  destination: string;
  refundAddress: string;
  /** Unix seconds. */
  deadline: number;
  streaming: StreamingSchedule;
  memoHash?: string;
}

export type StreamingSwapState =
  | "sealed"
  | "inbound_observed"
  | "inbound_confirmed"
  | "streaming"
  | "awaiting_outbound"
  | "outbound_signed"
  | "outbound_broadcast"
  | "completed"
  | "partially_completed"
  | "refunded"
  | "needs_review";

export type FundingStatus = "missing" | "unconfirmed" | "changed" | "confirmed";

export interface SubswapRecord {
  index: number;
  scheduledAt: number;
  executedAt: number;
  amountInThor: bigint;
  minOutThor: bigint;
  intermediateNyxThor: bigint;
  feeNyxThor: bigint;
  netOutThor: bigint;
  arbActions: ArbAction[];
  arbFailures: number;
}

export interface StreamingSwapRecord {
  orderId: string;
  sealed: SealedOrder;
  /** Random mock deposit reference. Not derived from the plaintext order. */
  depositTag: string;
  state: StreamingSwapState;
  /** Vault-only plaintext after threshold opening. Never expose publicly. */
  opened?: StreamingOrderPlain;
  inbound?: InboundObservation;
  /** Latest local observation, separate from the state of the pinned credit. */
  fundingStatus?: FundingStatus;
  subswaps: SubswapRecord[];
  chunks?: bigint[];
  chunkMinOuts?: bigint[];
  completedSubswaps: number;
  amountThor?: bigint;
  remainingInThor?: bigint;
  totalNetOutThor: bigint;
  totalFeeNyxThor: bigint;
  nextSubswapAt?: number;
  openableAt: number;
  streamCompletedAt?: number;
  outboundReadyAt?: number;
  outbound?: OutboundInstruction;
  signed?: SignedOutbound;
  outboundBroadcastHash?: string;
  refundOutbound?: OutboundInstruction;
  refundSigned?: SignedOutbound;
  refundBroadcastHash?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StreamingEngineConfig {
  orderFlow: PrivateOrderFlow;
  opener: ThresholdOrderOpener;
  pools: HubPoolBook;
  feeBps: number;
  treasury?: TokenTreasury;
  adapters: Readonly<Partial<Record<Chain, ChainAdapter>>>;
  signer: ThresholdSigner;
  arbBots?: readonly ArbBot[];
  maxSubswaps?: number;
  /** Optional outbound delay to reduce timing linkability. */
  outboundDelaySeconds?: number;
  /** Optional epoch batching for threshold opening. 0 = open immediately. */
  epochSeconds?: number;
  now?: () => number;
}

function parseBigint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= (1n << 256n)) {
    throw new Error(`${field} must be a canonical uint256 decimal string`);
  }
  return BigInt(value);
}

function safeConfirmations(n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error("invalid chain confirmation count");
  return Math.max(0, n); // BTC conflicts may be reported as negative.
}

function positiveConfirmations(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("confirmation requirement must be positive");
  return n;
}

function txIdentity(chain: Chain, txHash: string): string {
  if (typeof txHash !== "string" || !txHash || txHash.length > 128 || /\s/.test(txHash)) {
    throw new Error("invalid transaction identity");
  }
  const normalized = txHash.toLowerCase().replace(/^0x/, "");
  if (!normalized) throw new Error("invalid transaction identity");
  return `${chain}:${normalized}`;
}

export function parseStreamingOrder(raw: unknown): StreamingOrderPlain {
  if (!raw || typeof raw !== "object") throw new Error("invalid order");
  const o = raw as Record<string, unknown>;
  const from = assertAsset(o.from);
  const to = assertAsset(o.to);
  if (from === to) throw new Error("self-swap is not supported");
  if (typeof o.destination !== "string" || !o.destination.trim() || o.destination.length > 256) {
    throw new Error("destination required");
  }
  if (typeof o.refundAddress !== "string" || !o.refundAddress.trim() || o.refundAddress.length > 256) {
    throw new Error("refundAddress required");
  }
  if (!Number.isSafeInteger(o.deadline) || (o.deadline as number) <= 0 || o.deadline === Number.MAX_SAFE_INTEGER) {
    throw new Error("deadline must be unix seconds");
  }
  const streaming = o.streaming as Record<string, unknown> | undefined;
  if (!streaming || typeof streaming !== "object") throw new Error("streaming schedule required");
  const intervalSeconds = streaming.intervalSeconds;
  const quantity = streaming.quantity;
  if (!Number.isSafeInteger(intervalSeconds) || (intervalSeconds as number) < 1 || (intervalSeconds as number) > 86_400) {
    throw new Error("streaming.intervalSeconds must be in 1..86400");
  }
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1) {
    throw new Error("streaming.quantity must be >= 1");
  }
  return {
    from,
    to,
    amountThor: parseBigint(o.amountThor, "amountThor").toString(),
    minOutThor: parseBigint(o.minOutThor, "minOutThor").toString(),
    destination: o.destination,
    refundAddress: o.refundAddress,
    deadline: o.deadline as number,
    streaming: {
      intervalSeconds: intervalSeconds as number,
      quantity: quantity as number,
    },
    memoHash: typeof o.memoHash === "string" ? o.memoHash : undefined,
  };
}

/**
 * Streaming hub swap engine.
 *
 * Private orderflow:
 *   sealed blob -> random L1 deposit tag -> epoch-batched threshold opening ->
 *   vault-only plaintext.
 *
 * Execution:
 *   inbound native asset confirmed -> split into subswaps -> each subswap routes
 *   A -> NYX -> B through hub pools -> permissionless arb bots rebalance between
 *   subswaps -> final outbound signed by threshold signer.
 *
 * Settlement semantics follow streaming swaps: executed subswaps are final.
 * If a later subswap cannot meet its proportional price limit, the engine stops,
 * sends the accumulated output, and refunds the unexecuted input. It does NOT
 * roll back pool state or arbitrage trades.
 *
 * Proposition (streaming split):
 *   amountThor = sum(chunks[i]), chunks differ by at most 1 thor unit.
 *
 * Proposition (proportional subswap limit):
 *   chunkMinOuts[i] = ceil(minOutThor * chunks[i] / amountThor)
 *   sum(chunkMinOuts) >= minOutThor
 *
 * Proposition (hub route):
 *   each subswap executes A -> NYX -> B and pays fee in NYX on the intermediate
 *   NYX amount. See HubRouter.quote/execute.
 */
export class StreamingHubEngine {
  private records = new Map<string, StreamingSwapRecord>();
  // Conservative reference policy: one order per source-chain transaction.
  // Production requires durable claims by chain + output/log index + block identity.
  private claimedInbounds = new Map<string, string>();
  private busy = new Set<string>();
  private router: HubRouter;
  private now: () => number;
  private maxSubswaps: number;
  private outboundDelaySeconds: number;
  private epochSeconds: number;

  private readonly cfg: Readonly<StreamingEngineConfig>;

  constructor(cfg: StreamingEngineConfig) {
    // The pool book and mock adapters are intentionally stateful. Do not let
    // edits to the caller's config replace the registered watcher/signer,
    // treasury, opener or rebalance policy partway through an order.
    this.cfg = {
      ...cfg,
      adapters: { ...cfg.adapters },
      arbBots: [...(cfg.arbBots ?? [])],
    };
    // Fees are collected only at final settlement, and only for executed
    // subswaps. Failed/unexecuted input is refunded without protocol fees.
    this.router = new HubRouter(cfg.pools, cfg.feeBps);
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.maxSubswaps = cfg.maxSubswaps ?? 1440;
    this.outboundDelaySeconds = cfg.outboundDelaySeconds ?? 0;
    this.epochSeconds = cfg.epochSeconds ?? 0;
    if (!Number.isSafeInteger(this.maxSubswaps) || this.maxSubswaps < 1) {
      throw new Error("maxSubswaps must be >= 1");
    }
    if (!Number.isSafeInteger(this.outboundDelaySeconds) || this.outboundDelaySeconds < 0) {
      throw new Error("outboundDelaySeconds must be >= 0");
    }
    if (!Number.isSafeInteger(this.epochSeconds) || this.epochSeconds < 0) {
      throw new Error("epochSeconds must be >= 0");
    }
  }

  submitSealed(sealed: SealedOrder): string {
    const envelope = normalizeSealedOrder(sealed);
    this.cfg.opener.requireCommittee(envelope.committeeId);
    const orderId = this.cfg.orderFlow.submit(envelope);
    const now = this.now();
    const openableAt =
      this.epochSeconds === 0
        ? now
        : Math.floor(now / this.epochSeconds) * this.epochSeconds + this.epochSeconds;
    this.records.set(orderId, {
      orderId,
      sealed: envelope,
      depositTag: randomBytes(16).toString("hex"),
      state: "sealed",
      subswaps: [],
      completedSubswaps: 0,
      totalNetOutThor: 0n,
      totalFeeNyxThor: 0n,
      openableAt,
      createdAt: now,
      updatedAt: now,
    });
    return orderId;
  }

  submitShare(orderId: string, share: ThresholdShare): void {
    const record = this.mustGet(orderId);
    if (record.opened || this.isTerminal(record.state)) throw new Error("order no longer accepts shares");
    this.cfg.opener.submitShare(orderId, share);
  }

  get(orderId: string): StreamingSwapRecord | undefined {
    const record = this.records.get(orderId);
    return record ? structuredClone(record) : undefined;
  }

  /**
   * Random reference for matching simulated inbounds. It is neither a chain
   * address nor derived from the order id/plaintext.
   */
  depositTag(orderId: string): string {
    return this.mustGet(orderId).depositTag;
  }

  /** Public-safe view: no opened plaintext, no destination, no amounts. */
  publicView(orderId: string): { orderId: string; state: StreamingSwapState } | undefined {
    const r = this.records.get(orderId);
    if (!r) return undefined;
    return { orderId: r.orderId, state: r.state };
  }

  async observeInbound(orderId: string): Promise<StreamingSwapRecord> {
    return this.withLock(orderId, () => this.scanInbound(this.mustGet(orderId)));
  }

  private async scanInbound(record: StreamingSwapRecord): Promise<StreamingSwapRecord> {
    if (record.state !== "sealed" && record.state !== "inbound_observed") return record;
    for (const adapter of this.adapters()) {
      for (const asset of adapter.assets) {
        const found = await adapter.scanInbound(record.depositTag, asset);
        if (!found) continue;
        const obs = { ...found };
        if (obs.depositTag !== record.depositTag) throw new Error("inbound deposit tag mismatch");
        if (obs.chain !== adapter.chain || obs.asset !== asset || chainOf(asset) !== adapter.chain) {
          throw new Error("inbound chain/asset mismatch");
        }
        if (typeof obs.amountBaseUnits !== "bigint" || obs.amountBaseUnits <= 0n) {
          return this.needsReview(record, "non-positive inbound amount");
        }
        const inboundId = txIdentity(obs.chain, obs.txHash);
        const required = positiveConfirmations(adapter.requiredConfirmations(asset));
        const confirmations = safeConfirmations(await adapter.getConfirmations(obs.txHash));
        record.inbound = { ...obs, confirmations };
        record.state = "inbound_observed";
        record.fundingStatus = confirmations >= required ? "confirmed" : "unconfirmed";
        record.updatedAt = this.now();
        if (confirmations >= required) {
          const claimed = this.claimedInbounds.get(inboundId);
          if (claimed !== undefined && claimed !== record.orderId) {
            return this.needsReview(record, "inbound transaction already credited");
          }
          this.claimedInbounds.set(inboundId, record.orderId);
          record.state = "inbound_confirmed";
        }
        return record;
      }
    }
    // A transaction can disappear before finality. Do not retain a refundable
    // observation after the watcher no longer sees it.
    record.inbound = undefined;
    record.fundingStatus = "missing";
    record.state = "sealed";
    return record;
  }

  async start(orderId: string): Promise<StreamingSwapRecord> {
    return this.withLock(orderId, () => this.openConfirmed(this.mustGet(orderId)));
  }

  private async openConfirmed(record: StreamingSwapRecord): Promise<StreamingSwapRecord> {
    const { orderId } = record;
    if (record.state !== "inbound_confirmed" || !record.inbound) {
      throw new Error("inbound not confirmed");
    }
    if (this.now() < record.openableAt) {
      throw new Error("order epoch not openable yet");
    }
    if (!this.cfg.opener.canOpen(orderId)) {
      throw new Error("not enough threshold shares");
    }

    // Once credited, the original observation stays pinned even if funding is
    // no longer current. Do not resume scanning for a substitute deposit.
    if (!(await this.fundingIsCurrent(record))) return record;

    let plain: StreamingOrderPlain;
    try {
      plain = parseStreamingOrder(this.cfg.opener.open(orderId, record.sealed));
    } catch {
      return this.needsReview(record, "could not open a valid order / refund destination");
    }
    record.opened = plain;
    // Do not issue a refund in the asset declared by the order if the inbound
    // is a different asset. Ownership/destination on that chain is not known.
    if (record.inbound.asset !== plain.from) {
      return this.needsReview(record, "inbound asset does not match sealed order");
    }
    const amountThor = BigInt(plain.amountThor);
    const minOutThor = BigInt(plain.minOutThor);
    if (amountThor === 0n) return this.refundRecord(record, "amount must be positive");
    if (plain.streaming.quantity > this.maxSubswaps) {
      return this.refundRecord(record, "streaming quantity exceeds maxSubswaps");
    }
    if (BigInt(plain.streaming.quantity) > amountThor) {
      return this.refundRecord(record, "streaming quantity exceeds amount");
    }
    if (this.now() > plain.deadline) {
      return this.refundRecord(record, "deadline passed");
    }

    let observedThor: bigint;
    try {
      observedThor = toThorUnitsExact(plain.from, record.inbound.amountBaseUnits);
    } catch {
      return this.refundRecord(record, "inbound amount has sub-thor dust");
    }
    if (observedThor !== amountThor) {
      return this.refundRecord(record, "inbound amount does not match sealed order");
    }
    try {
      this.adapterFor(plain.to);
      this.cfg.pools.get(plain.from);
      this.cfg.pools.get(plain.to);
    } catch {
      return this.refundRecord(record, "route not available");
    }

    const n = BigInt(plain.streaming.quantity);
    const base = amountThor / n;
    const rem = amountThor % n;
    record.chunks = Array.from({ length: plain.streaming.quantity }, (_, i) =>
      base + (BigInt(i) < rem ? 1n : 0n),
    );
    record.chunkMinOuts = record.chunks.map(
      (c) => (minOutThor * c + amountThor - 1n) / amountThor,
    );
    if (record.chunks.some((c) => c <= 0n)) {
      return this.refundRecord(record, "invalid subswap chunk");
    }
    record.amountThor = amountThor;
    record.remainingInThor = amountThor;
    record.nextSubswapAt = this.now();
    record.state = "streaming";
    record.updatedAt = this.now();
    return record;
  }

  async tick(orderId: string): Promise<StreamingSwapRecord> {
    return this.withLock(orderId, async () => {
      let record = this.mustGet(orderId);
      if (this.isTerminal(record.state)) return record;
      if (record.state === "sealed" || record.state === "inbound_observed") {
        record = await this.scanInbound(record);
      }
      if (record.state === "inbound_confirmed") {
        if (this.now() < record.openableAt) return record;
        if (!this.cfg.opener.canOpen(orderId)) return record;
        record = await this.openConfirmed(record);
      }
      if (record.state === "streaming") {
        record = await this.executeDueSubswaps(record);
      }
      if (this.isSettling(record) && this.now() >= record.outboundReadyAt!) {
        record = await this.finalize(record);
      }
      return record;
    });
  }

  /**
   * Drive the state machine. If `advanceTime` is supplied, the engine may jump
   * the injected clock to the next scheduled event. Useful for demos/tests.
   */
  async run(
    orderId: string,
    opts?: { advanceTime?: (seconds: number) => void; maxSteps?: number },
  ): Promise<StreamingSwapRecord> {
    const maxSteps = opts?.maxSteps ?? 10_000;
    let record = this.mustGet(orderId);
    for (let step = 0; step < maxSteps; step++) {
      record = await this.tick(orderId);
      if (this.isTerminal(record.state)) return record;
      const now = this.now();
      let next: number | undefined;
      if (record.state === "inbound_confirmed") next = record.openableAt;
      if (record.state === "streaming") next = Math.min(record.nextSubswapAt!, record.opened!.deadline + 1);
      if (this.isSettling(record)) next = record.outboundReadyAt;
      if (next !== undefined && next > now && opts?.advanceTime) {
        opts.advanceTime(next - now);
        continue;
      }
      if (next !== undefined && next > now) return record;
      // No scheduled future event and not terminal; avoid a busy loop.
      return record;
    }
    throw new Error("streaming run exceeded maxSteps");
  }

  /** Internal cancel/refund. Callers must authenticate cancellations externally. */
  async refund(orderId: string, reason: string): Promise<StreamingSwapRecord> {
    return this.withLock(orderId, async () => {
      const record = this.mustGet(orderId);
      if (this.isTerminal(record.state)) return record;
      if (!this.isSettling(record)) {
        if (record.state !== "streaming" || !record.opened || !record.inbound) {
          throw new Error("cannot refund before a confirmed, opened inbound");
        }
        this.stopStream(record, reason);
      }
      return this.now() >= record.outboundReadyAt! ? this.finalize(record) : record;
    });
  }

  private async executeDueSubswaps(record: StreamingSwapRecord): Promise<StreamingSwapRecord> {
    const plain = record.opened;
    const chunks = record.chunks;
    const chunkMinOuts = record.chunkMinOuts;
    if (!plain || !chunks || !chunkMinOuts || record.remainingInThor === undefined || record.nextSubswapAt === undefined) {
      throw new Error("stream not started");
    }
    if (this.now() > plain.deadline) return this.stopStream(record, "deadline passed during streaming");
    if (this.now() < record.nextSubswapAt) return record;
    // A reorg or watcher loss pauses further execution. Already committed
    // chunks are not rolled back; the reference engine has no reorg ledger.
    if (!(await this.fundingIsCurrent(record))) return record;
    const now = this.now();
    if (now > plain.deadline) return this.stopStream(record, "deadline passed during streaming");
    const index = record.completedSubswaps;
    const amountInThor = chunks[index];
    const minOutThor = chunkMinOuts[index];

    // The quote and execution are synchronous; no external await can change
    // reserves between the limit check and the committed trade.
    let quote;
    try {
      const candidate = this.router.quote(plain.from, plain.to, amountInThor);
      if (candidate.netOutThor < minOutThor) return this.stopStream(record, "subswap minOut not met");
      quote = this.router.execute(plain.from, plain.to, amountInThor);
    } catch (err) {
      return this.stopStream(record, `subswap rejected: ${err instanceof Error ? err.message : String(err)}`);
    }

    const fill: SubswapRecord = {
      index, scheduledAt: record.nextSubswapAt, executedAt: now, amountInThor, minOutThor,
      intermediateNyxThor: quote.intermediateNyxThor, feeNyxThor: quote.feeNyxThor,
      netOutThor: quote.netOutThor, arbActions: [], arbFailures: 0,
    };
    record.subswaps.push(fill);
    record.totalNetOutThor += quote.netOutThor;
    record.totalFeeNyxThor += quote.feeNyxThor;
    record.remainingInThor -= amountInThor;
    record.completedSubswaps += 1;
    record.updatedAt = now;

    // An optional bot failing after the trade must not make the already
    // committed chunk eligible for execution again.
    for (const bot of this.cfg.arbBots ?? []) {
      for (const asset of [plain.from, plain.to]) {
        try {
          const action = bot.rebalance(this.cfg.pools.get(asset));
          if (action) fill.arbActions.push(action);
        } catch {
          fill.arbFailures++;
        }
      }
    }
    if (record.completedSubswaps === chunks.length) return this.stopStream(record);
    // Do not process a burst of overdue chunks against the same market state.
    record.nextSubswapAt = now + plain.streaming.intervalSeconds;
    return record;
  }

  /** Build both legs once. After this point, retries may not reprice or resize. */
  private stopStream(record: StreamingSwapRecord, reason?: string): StreamingSwapRecord {
    const { opened, inbound, remainingInThor, totalNetOutThor } = record;
    if (!opened || !inbound || inbound.asset !== opened.from) throw new Error("missing settlement context");
    const now = this.now();
    const instruction = (asset: Asset, to: string, amountBaseUnits: bigint): OutboundInstruction => ({
      orderId: record.orderId, chain: chainOf(asset), asset, to, amountBaseUnits, memoHash: opened.memoHash,
    });
    if (totalNetOutThor > 0n) {
      record.outbound = instruction(opened.to, opened.destination, fromThorUnits(opened.to, totalNetOutThor));
    }
    const refund = remainingInThor === undefined ? inbound.amountBaseUnits : fromThorUnits(opened.from, remainingInThor);
    if (refund > 0n) record.refundOutbound = instruction(opened.from, opened.refundAddress, refund);
    record.error = reason;
    record.streamCompletedAt = now;
    record.outboundReadyAt = now + this.outboundDelaySeconds;
    record.state = "awaiting_outbound";
    record.updatedAt = now;
    return record;
  }

  private async finalize(record: StreamingSwapRecord): Promise<StreamingSwapRecord> {
    const paid = await this.settleLeg(record, "payout");
    const refunded = await this.settleLeg(record, "refund");
    // Track any already signed transactions, but do not finalize accounting if
    // the source funding is no longer confirmed. There is no reorg ledger.
    if (!paid || !refunded || !(await this.fundingIsCurrent(record))) return record;

    this.cfg.treasury?.collectFeeNyx(record.totalFeeNyxThor);
    record.state = record.outbound
      ? record.refundOutbound ? "partially_completed" : "completed"
      : "refunded";
    record.updatedAt = this.now();
    return record;
  }

  private async settleLeg(record: StreamingSwapRecord, leg: "payout" | "refund"): Promise<boolean> {
    const [planField, signedField, broadcastField] = leg === "payout"
      ? ["outbound", "signed", "outboundBroadcastHash"] as const
      : ["refundOutbound", "refundSigned", "refundBroadcastHash"] as const;
    const instruction = record[planField];
    if (!instruction) return true;
    const adapter = this.adapterFor(instruction.asset);
    const required = positiveConfirmations(adapter.requiredOutboundConfirmations?.(instruction.asset)
      ?? adapter.requiredConfirmations(instruction.asset));
    let signed = record[signedField];
    if (!signed) {
      if (!(await this.fundingIsCurrent(record))) return false;
      const unsigned = await adapter.buildOutbound({ ...instruction });
      // Check before signing each new leg, not just before the first broadcast.
      // A reply/confirmation for the payout can take time while funding changes.
      if (!(await this.fundingIsCurrent(record))) return false;
      const result = await this.cfg.signer.sign(adapter.chain, instruction.asset, unsigned);
      if (typeof result.rawTx !== "string" || !result.rawTx) throw new Error("signer returned an invalid transaction");
      txIdentity(adapter.chain, result.txHash);
      signed = record[signedField] = { ...result, chain: adapter.chain, orderId: record.orderId };
      record.state = "outbound_signed";
      record.updatedAt = this.now();
    }
    let txHash = record[broadcastField];
    if (!txHash) {
      // A signer may have returned after the observation was lost. Retain the
      // bytes but do not publish them while the funding snapshot is uncertain.
      if (!(await this.fundingIsCurrent(record))) return false;
      // An RPC may accept the bytes then lose its response. Keep the signed
      // bytes over failure and rebroadcast those exact bytes on the next tick.
      txHash = await adapter.broadcast(signed.rawTx);
      if (txIdentity(adapter.chain, txHash) !== txIdentity(adapter.chain, signed.txHash)) {
        throw new Error(`${leg} broadcast returned a different transaction ID`);
      }
      record[broadcastField] = txHash;
      record.state = "outbound_broadcast";
      record.updatedAt = this.now();
    }
    return safeConfirmations(await adapter.getConfirmations(txHash)) >= required;
  }

  private refundRecord(record: StreamingSwapRecord, reason: string): StreamingSwapRecord {
    if (record.state !== "inbound_confirmed" || record.completedSubswaps !== 0) {
      throw new Error("full refund requires an unused confirmed inbound");
    }
    return this.stopStream(record, reason);
  }

  private async fundingIsCurrent(record: StreamingSwapRecord): Promise<boolean> {
    const credit = record.inbound;
    if (!credit) return false;
    const source = this.adapterFor(credit.asset);
    const observation = await source.scanInbound(record.depositTag, credit.asset);
    if (!observation || observation.depositTag !== record.depositTag ||
        observation.chain !== credit.chain || observation.asset !== credit.asset ||
        observation.amountBaseUnits !== credit.amountBaseUnits ||
        txIdentity(observation.chain, observation.txHash) !== txIdentity(credit.chain, credit.txHash)) {
      record.fundingStatus = observation ? "changed" : "missing";
      credit.confirmations = 0;
      return false;
    }
    const confirmations = safeConfirmations(await source.getConfirmations(credit.txHash));
    credit.confirmations = confirmations;
    const confirmed = confirmations >= positiveConfirmations(source.requiredConfirmations(credit.asset));
    record.fundingStatus = confirmed ? "confirmed" : "unconfirmed";
    return confirmed;
  }

  private isSettling(record: StreamingSwapRecord): boolean {
    return record.state === "awaiting_outbound" || record.state === "outbound_signed" || record.state === "outbound_broadcast";
  }

  private needsReview(record: StreamingSwapRecord, reason: string): StreamingSwapRecord {
    this.cfg.opener.discard(record.orderId);
    record.state = "needs_review";
    record.error = reason;
    record.updatedAt = this.now();
    return record;
  }

  private isTerminal(state: StreamingSwapState): boolean {
    return (
      state === "completed" ||
      state === "partially_completed" ||
      state === "refunded" ||
      state === "needs_review"
    );
  }

  private adapters(): ChainAdapter[] {
    return Object.values(this.cfg.adapters).filter(
      (a): a is ChainAdapter => !!a,
    );
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

  private async withLock(
    id: string,
    fn: () => Promise<StreamingSwapRecord>,
  ): Promise<StreamingSwapRecord> {
    if (this.busy.has(id)) throw new Error(`order ${id} already in progress`);
    this.busy.add(id);
    try {
      return structuredClone(await fn());
    } finally {
      this.busy.delete(id);
    }
  }

  private mustGet(id: string): StreamingSwapRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown order ${id}`);
    return record;
  }
}
