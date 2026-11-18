import { randomBytes } from "node:crypto";
import { assertAsset, chainOf, type Asset, type Chain } from "../assets.js";
import type { ChainAdapter, ThresholdSigner } from "../chains/types.js";
import type { ArbBot } from "./arb.js";
import { HubPoolBook, HubRouter, type ArbAction } from "./hub.js";
import { PrivateOrderFlow } from "./orderflow.js";
import { TokenTreasury } from "./token.js";
import {
  type SealedOrder,
  type ThresholdShare,
  ThresholdOrderOpener,
} from "../privacy/threshold.js";
import type {
  InboundObservation,
  OutboundInstruction,
  SignedOutbound,
} from "./types.js";
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
  | "failed";

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
}

export interface StreamingSwapRecord {
  orderId: string;
  sealed: SealedOrder;
  /** Random L1 deposit reference. Not derived from the plaintext order. */
  depositTag: string;
  state: StreamingSwapState;
  /** Vault-only plaintext after threshold opening. Never expose publicly. */
  opened?: StreamingOrderPlain;
  inbound?: InboundObservation;
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
  refundOutbound?: OutboundInstruction;
  refundSigned?: SignedOutbound;
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
  adapters: Partial<Record<Chain, ChainAdapter>>;
  signer: ThresholdSigner;
  arbBots?: ArbBot[];
  maxSubswaps?: number;
  /** Optional outbound delay to reduce timing linkability. */
  outboundDelaySeconds?: number;
  /** Optional epoch batching for threshold opening. 0 = open immediately. */
  epochSeconds?: number;
  now?: () => number;
}

function parseBigint(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a decimal string`);
  return BigInt(value);
}

export function parseStreamingOrder(raw: unknown): StreamingOrderPlain {
  if (!raw || typeof raw !== "object") throw new Error("invalid order");
  const o = raw as Record<string, unknown>;
  const from = assertAsset(o.from);
  const to = assertAsset(o.to);
  if (from === to) throw new Error("self-swap is not supported");
  if (typeof o.destination !== "string" || !o.destination) {
    throw new Error("destination required");
  }
  if (typeof o.refundAddress !== "string" || !o.refundAddress) {
    throw new Error("refundAddress required");
  }
  if (!Number.isSafeInteger(o.deadline) || (o.deadline as number) <= 0) {
    throw new Error("deadline must be unix seconds");
  }
  const streaming = o.streaming as Record<string, unknown> | undefined;
  if (!streaming) throw new Error("streaming schedule required");
  const intervalSeconds = streaming.intervalSeconds;
  const quantity = streaming.quantity;
  if (!Number.isInteger(intervalSeconds) || (intervalSeconds as number) < 1) {
    throw new Error("streaming.intervalSeconds must be >= 1");
  }
  if (!Number.isInteger(quantity) || (quantity as number) < 1) {
    throw new Error("streaming.quantity must be >= 1");
  }
  return {
    from,
    to,
    amountThor: String(o.amountThor),
    minOutThor: String(o.minOutThor),
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
  private busy = new Set<string>();
  private router: HubRouter;
  private now: () => number;
  private maxSubswaps: number;
  private outboundDelaySeconds: number;
  private epochSeconds: number;

  constructor(private readonly cfg: StreamingEngineConfig) {
    // Fees are collected only at final settlement, and only for executed
    // subswaps. Failed/unexecuted input is refunded without protocol fees.
    this.router = new HubRouter(cfg.pools, cfg.feeBps);
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.maxSubswaps = cfg.maxSubswaps ?? 1440;
    this.outboundDelaySeconds = cfg.outboundDelaySeconds ?? 0;
    this.epochSeconds = cfg.epochSeconds ?? 0;
    if (!Number.isInteger(this.maxSubswaps) || this.maxSubswaps < 1) {
      throw new Error("maxSubswaps must be >= 1");
    }
    if (!Number.isInteger(this.outboundDelaySeconds) || this.outboundDelaySeconds < 0) {
      throw new Error("outboundDelaySeconds must be >= 0");
    }
    if (!Number.isInteger(this.epochSeconds) || this.epochSeconds < 0) {
      throw new Error("epochSeconds must be >= 0");
    }
  }

  submitSealed(sealed: SealedOrder): string {
    const orderId = this.cfg.orderFlow.submit(sealed);
    if (this.records.has(orderId)) throw new Error("order already exists");
    const now = this.now();
    const openableAt =
      this.epochSeconds === 0
        ? now
        : Math.floor(now / this.epochSeconds) * this.epochSeconds + this.epochSeconds;
    this.records.set(orderId, {
      orderId,
      sealed,
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
    this.mustGet(orderId);
    this.cfg.opener.submitShare(orderId, share);
  }

  get(orderId: string): StreamingSwapRecord | undefined {
    return this.records.get(orderId);
  }

  /**
   * Random deposit reference the client puts in the L1 deposit memo/payment id.
   * It is not the order id and is not derived from the plaintext order.
   * Production vaults should map this to a fresh one-time deposit address.
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
    const record = this.mustGet(orderId);
    if (record.state !== "sealed" && record.state !== "inbound_observed") {
      return record;
    }
    for (const adapter of this.adapters()) {
      for (const asset of adapter.assets) {
        const obs = await adapter.scanInbound(record.depositTag, asset);
        if (!obs) continue;
        if (obs.intentId !== record.depositTag) {
          throw new Error("inbound deposit tag mismatch");
        }
        if (obs.chain !== adapter.chain || obs.asset !== asset) {
          throw new Error("inbound chain/asset mismatch");
        }
        record.inbound = { ...obs };
        record.state = "inbound_observed";
        record.updatedAt = this.now();
        const required = adapter.requiredConfirmations(asset);
        const confirmations = await adapter.getConfirmations(obs.txHash);
        record.inbound.confirmations = confirmations;
        if (confirmations >= required) {
          record.state = "inbound_confirmed";
          record.updatedAt = this.now();
        }
        return record;
      }
    }
    return record;
  }

  async start(orderId: string): Promise<StreamingSwapRecord> {
    const record = this.mustGet(orderId);
    if (record.state !== "inbound_confirmed" || !record.inbound) {
      throw new Error("inbound not confirmed");
    }
    if (record.opened) return record;
    if (this.now() < record.openableAt) {
      throw new Error("order epoch not openable yet");
    }
    if (!this.cfg.opener.canOpen(orderId)) {
      throw new Error("not enough threshold shares");
    }

    const plain = parseStreamingOrder(
      this.cfg.opener.open(orderId, record.sealed),
    );
    record.opened = plain;
    const amountThor = parseBigint(plain.amountThor, "amountThor");
    const minOutThor = parseBigint(plain.minOutThor, "minOutThor");
    if (amountThor <= 0n) throw new Error("amount must be positive");
    if (minOutThor < 0n) throw new Error("minOut must be non-negative");
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
    if (record.inbound.asset !== plain.from) {
      return this.refundRecord(record, "inbound asset does not match sealed order");
    }

    this.adapterFor(plain.from);
    this.adapterFor(plain.to);
    this.cfg.pools.get(plain.from);
    this.cfg.pools.get(plain.to);

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
        record = await this.observeInbound(orderId);
      }
      if (record.state === "inbound_confirmed") {
        if (this.now() < record.openableAt) return record;
        if (!this.cfg.opener.canOpen(orderId)) return record;
        record = await this.start(orderId);
      }
      if (record.state === "streaming") {
        record = await this.executeDueSubswaps(record);
      }
      if (record.state === "awaiting_outbound") {
        if (this.now() >= (record.outboundReadyAt ?? 0)) {
          record = await this.finalize(record);
        }
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
      if (record.state === "streaming") next = record.nextSubswapAt;
      if (record.state === "awaiting_outbound") next = record.outboundReadyAt;
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

  /** Cancel/refund. If subswaps already executed, settle partially. */
  async refund(orderId: string, reason: string): Promise<StreamingSwapRecord> {
    return this.withLock(orderId, async () => {
      const record = this.mustGet(orderId);
      if (this.isTerminal(record.state)) return record;
      if (record.completedSubswaps > 0) {
        record.error = reason;
        record.state = "awaiting_outbound";
        record.outboundReadyAt = this.now() + this.outboundDelaySeconds;
        return this.finalize(record);
      }
      return this.refundRecord(record, reason);
    });
  }

  private async executeDueSubswaps(
    record: StreamingSwapRecord,
  ): Promise<StreamingSwapRecord> {
    const plain = record.opened;
    const chunks = record.chunks;
    const chunkMinOuts = record.chunkMinOuts;
    if (!plain || !chunks || !chunkMinOuts || record.remainingInThor === undefined) {
      throw new Error("stream not started");
    }

    while (
      record.state === "streaming" &&
      record.completedSubswaps < chunks.length &&
      this.now() >= (record.nextSubswapAt ?? 0)
    ) {
      if (this.now() > plain.deadline) {
        return this.stopStream(record, "deadline passed during streaming");
      }
      const index = record.completedSubswaps;
      const amountInThor = chunks[index];
      const minOutThor = chunkMinOuts[index];

      let quote;
      try {
        quote = this.router.quote(plain.from, plain.to, amountInThor);
      } catch (err) {
        return this.stopStream(
          record,
          `subswap quote failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (quote.netOutThor < minOutThor) {
        return this.stopStream(record, "subswap minOut not met");
      }

      try {
        this.router.execute(plain.from, plain.to, amountInThor);
      } catch (err) {
        return this.stopStream(
          record,
          `subswap failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const arbActions: ArbAction[] = [];
      const affected = [
        this.cfg.pools.get(plain.from),
        this.cfg.pools.get(plain.to),
      ];
      for (const bot of this.cfg.arbBots ?? []) {
        for (const pool of affected) {
          const action = bot.rebalance(pool);
          if (action) arbActions.push(action);
        }
      }

      record.subswaps.push({
        index,
        scheduledAt: record.nextSubswapAt ?? this.now(),
        executedAt: this.now(),
        amountInThor,
        minOutThor,
        intermediateNyxThor: quote.intermediateNyxThor,
        feeNyxThor: quote.feeNyxThor,
        netOutThor: quote.netOutThor,
        arbActions,
      });
      record.totalNetOutThor += quote.netOutThor;
      record.totalFeeNyxThor += quote.feeNyxThor;
      record.remainingInThor -= amountInThor;
      record.completedSubswaps += 1;
      record.updatedAt = this.now();

      if (record.completedSubswaps >= chunks.length) {
        record.streamCompletedAt = this.now();
        record.outboundReadyAt = this.now() + this.outboundDelaySeconds;
        record.state = "awaiting_outbound";
      } else {
        record.nextSubswapAt =
          (record.nextSubswapAt ?? this.now()) + plain.streaming.intervalSeconds;
      }
    }
    return record;
  }

  private stopStream(
    record: StreamingSwapRecord,
    reason: string,
  ): StreamingSwapRecord {
    record.error = reason;
    record.streamCompletedAt = this.now();
    record.outboundReadyAt = this.now() + this.outboundDelaySeconds;
    record.state = "awaiting_outbound";
    record.updatedAt = this.now();
    return record;
  }

  private async finalize(
    record: StreamingSwapRecord,
  ): Promise<StreamingSwapRecord> {
    const plain = record.opened;
    if (!plain || record.remainingInThor === undefined || record.amountThor === undefined) {
      throw new Error("missing opened order");
    }
    const minOutThor = parseBigint(plain.minOutThor, "minOutThor");
    const remaining = record.remainingInThor;
    const netOut = record.totalNetOutThor;

    if (netOut === 0n) {
      return this.refundRecord(record, record.error ?? "streaming minOut not met");
    }

    const outbound: OutboundInstruction = {
      intentId: record.orderId,
      chain: chainOf(plain.to),
      asset: plain.to,
      to: plain.destination,
      amountBaseUnits: fromThorUnits(plain.to, netOut),
      memoHash: plain.memoHash,
    };
    record.outbound = outbound;
    const adapter = this.adapterFor(plain.to);
    const unsigned = await adapter.buildOutbound(outbound);
    const signed = await this.cfg.signer.sign(adapter.chain, plain.to, unsigned);
    record.signed = {
      intentId: record.orderId,
      chain: adapter.chain,
      rawTx: signed.rawTx,
      txHash: signed.txHash,
    };
    record.state = "outbound_signed";
    record.updatedAt = this.now();

    const txHash = await adapter.broadcast(signed.rawTx);
    record.signed.txHash = txHash;
    record.state = "outbound_broadcast";
    record.updatedAt = this.now();

    if (remaining > 0n) {
      const refundAdapter = this.adapterFor(plain.from);
      const refund: OutboundInstruction = {
        intentId: record.orderId,
        chain: refundAdapter.chain,
        asset: plain.from,
        to: plain.refundAddress,
        amountBaseUnits: fromThorUnits(plain.from, remaining),
        memoHash: plain.memoHash,
      };
      record.refundOutbound = refund;
      const refundUnsigned = await refundAdapter.buildOutbound(refund);
      const refundSigned = await this.cfg.signer.sign(
        refundAdapter.chain,
        plain.from,
        refundUnsigned,
      );
      record.refundSigned = {
        intentId: record.orderId,
        chain: refundAdapter.chain,
        rawTx: refundSigned.rawTx,
        txHash: refundSigned.txHash,
      };
      const refundHash = await refundAdapter.broadcast(refundSigned.rawTx);
      record.refundSigned.txHash = refundHash;
    }

    this.cfg.treasury?.collectFeeNyx(record.totalFeeNyxThor);

    if (remaining === 0n && netOut >= minOutThor) {
      record.state = "completed";
    } else if (remaining > 0n) {
      record.state = "partially_completed";
    } else {
      // Should be unreachable because proportional limits enforce total minOut.
      record.state = "failed";
      record.error = record.error ?? "total minOut not met after full execution";
    }
    record.updatedAt = this.now();
    return record;
  }

  private async refundRecord(
    record: StreamingSwapRecord,
    reason: string,
  ): Promise<StreamingSwapRecord> {
    if (this.isTerminal(record.state)) return record;
    if (record.completedSubswaps > 0) {
      throw new Error("cannot full-refund after subswaps executed; use partial settlement");
    }
    if (!record.inbound) {
      record.state = "failed";
      record.error = reason;
      record.updatedAt = this.now();
      return record;
    }
    const plain = record.opened;
    if (!plain) {
      record.state = "failed";
      record.error = `${reason}; no opened refund address`;
      record.updatedAt = this.now();
      return record;
    }
    const adapter = this.adapterFor(plain.from);
    const refund: OutboundInstruction = {
      intentId: record.orderId,
      chain: adapter.chain,
      asset: plain.from,
      to: plain.refundAddress,
      amountBaseUnits: record.inbound.amountBaseUnits,
      memoHash: plain.memoHash,
    };
    record.refundOutbound = refund;
    const unsigned = await adapter.buildOutbound(refund);
    const signed = await this.cfg.signer.sign(adapter.chain, plain.from, unsigned);
    record.refundSigned = {
      intentId: record.orderId,
      chain: adapter.chain,
      rawTx: signed.rawTx,
      txHash: signed.txHash,
    };
    const txHash = await adapter.broadcast(signed.rawTx);
    record.refundSigned.txHash = txHash;
    record.state = "refunded";
    record.error = reason;
    record.updatedAt = this.now();
    return record;
  }

  private isTerminal(state: StreamingSwapState): boolean {
    return (
      state === "completed" ||
      state === "partially_completed" ||
      state === "refunded" ||
      state === "failed"
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
      return await fn();
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
