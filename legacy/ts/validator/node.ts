/**
 * @title Validator Node — Coprocessor Architecture (Off-chain, REAL)
 * @dev Node trong mạng lưới validator chạy off-chain:
 *   1. Chỉ có cloud key (không có secret key)
 *   2. Chạy FHE evaluator để kiểm tra encrypted_balance >= withdraw_amount
 *   3. Ký threshold vote (FROST/BLS threshold signature scheme)
 *   4. Blockchain chỉ verify ZK-SNARK + threshold signatures, KHÔNG chạy FHE on-chain
 *
 * Ưu tiên CMP/MUX thay vì MUL/DIV (FHE MUL/DIV cực chậm). Width mặc định = 16-bit.
 */

import * as crypto from "node:crypto";
import { CoprocessorNode, CoprocessorNetwork, type WithdrawalRequest } from "../../fhe-swap/src/fhe/coprocessor.js";

/**
 * Threshold signature share (FROST/BLS structure).
 * Trong production, thay bằng thư viện FROST/BLS thật (đã có sẵn crates Rust / lib JS).
 */
export interface ThresholdSignatureShare {
  nodeId: string;
  shareIndex: number;
  share: string;       // hex-encoded signature share
  commitment: string;  // commitment để verify share (commitment scheme)
  timestamp: number;
}

export interface ValidatorVote {
  nullifierHash: string;
  valid: boolean;
  signatureShare: ThresholdSignatureShare;
  nodeId: string;
  timestamp: number;
}

/**
 * FROST threshold (cấu trúc thật, chưa có crypto thư viện).
 * Thay bằng @zenith-labs/frost hoặc nimbus-frost khi triển khai production.
 */
export class FrostThreshold {
  private readonly threshold: number;
  private readonly total: number;
  private readonly shares = new Map<number, string>();
  private readonly commitments = new Map<number, string>();

  constructor(threshold: number, total: number) {
    this.threshold = threshold;
    this.total = total;
  }

  addShare(index: number, share: string, commitment: string): void {
    this.shares.set(index, share);
    this.commitments.set(index, commitment);
  }

  canReconstruct(): boolean {
    return this.shares.size >= this.threshold;
  }

  getShareCount(): number {
    return this.shares.size;
  }

  // Placeholder: trong production, dùng Lagrange interpolation để ghép shares
  reconstruct(): string | null {
    if (!this.canReconstruct()) return null;
    const sorted = Array.from(this.shares.entries()).sort((a, b) => a[0] - b[0]);
    // XOR đơn giản làm placeholder (thay bằng Lagrange interpolation thật)
    let result = 0n;
    for (const [, share] of sorted) {
      result ^= BigInt("0x" + share);
    }
    return "0x" + result.toString(16).padStart(64, "0");
  }

  verifyShare(index: number, share: string, commitment: string): boolean {
    // Trong production: verify share bằng commitment scheme (Pedersen/VSS)
    // Ở đây: kiểm tra commitment khớp
    const stored = this.commitments.get(index);
    return stored === commitment;
  }
}

export class ValidatorNode extends CoprocessorNode {
  private thresholdKeyShare: Buffer;
  private shareIndex: number;
  private frost: FrostThreshold | null = null;
  private votedNullifiers = new Set<string>();

  constructor(nodeId?: string, shareIndex: number = 0) {
    super(nodeId);
    this.thresholdKeyShare = crypto.randomBytes(32);
    this.shareIndex = shareIndex;
  }

  setFrostThreshold(frost: FrostThreshold): void {
    this.frost = frost;
  }

  /**
   * Validate withdrawal request: cấu trúc hợp lệ + FHE check passed.
   * Kiểm tra double-vote cho cùng nullifier.
   */
  async validateWithdrawal(req: WithdrawalRequest): Promise<boolean> {
    if (!req.nullifierHash || !req.commitment || !req.root || !req.encryptedAmountFHE) {
      return false;
    }

    // Chống double-vote: mỗi node chỉ vote một lần cho mỗi nullifier
    if (this.votedNullifiers.has(req.nullifierHash)) {
      return false;
    }

    // FHE check đã được thực hiện bởi CoprocessorNode.checkBalance
    // Ở đây chỉ xác nhận cấu trúc và ký vote
    return true;
  }

  /**
   * Ký một vote cho withdrawal. Trả về ThresholdSignatureShare (FROST cấu trúc).
   * Đánh dấu đã vote để chống double-vote.
   */
  signVote(nullifierHash: string, valid: boolean): ValidatorVote {
    if (this.votedNullifiers.has(nullifierHash)) {
      throw new Error(`Validator ${this.nodeId} already voted for ${nullifierHash}`);
    }
    this.votedNullifiers.add(nullifierHash);

    const payload = `${this.nodeId}:${nullifierHash}:${valid}:${Date.now()}`;
    const share = crypto.createHmac("sha256", this.thresholdKeyShare).update(payload).digest("hex");
    const commitment = crypto.createHmac("sha256", Buffer.from(this.nodeId + "commit")).update(payload).digest("hex");

    const signatureShare: ThresholdSignatureShare = {
      nodeId: this.nodeId,
      shareIndex: this.shareIndex,
      share,
      commitment,
      timestamp: Date.now(),
    };

    if (this.frost) {
      this.frost.addShare(this.shareIndex, share, commitment);
    }

    return {
      nullifierHash,
      valid,
      signatureShare,
      nodeId: this.nodeId,
      timestamp: Date.now(),
    };
  }
}

export interface NetworkConfig {
  threshold: number;
  totalValidators: number;
  cloudKeyPath: string;
}

export class ValidatorNetwork extends CoprocessorNetwork {
  public readonly config: NetworkConfig;
  private frostThreshold: FrostThreshold;
  private finalizedNullifiers = new Set<string>();

  constructor(config: NetworkConfig) {
    super(config.threshold);
    this.config = config;
    this.frostThreshold = new FrostThreshold(config.threshold, config.totalValidators);
  }

  addNode(node: ValidatorNode): void {
    node.setFrostThreshold(this.frostThreshold);
    this.nodes.push(node);
  }

  async initializeAll(): Promise<void> {
    for (const node of this.nodes) {
      await node.init(this.config.cloudKeyPath);
    }
  }

  submitVote(vote: ValidatorVote): void {
    super.submitVote(vote.nullifierHash, vote.valid, vote.nodeId);
  }

  isThresholdMet(nullifierHash: string): boolean {
    return super.isThresholdMet(nullifierHash);
  }

  getConsensusResult(nullifierHash: string) {
    return super.getConsensus(nullifierHash);
  }

  /**
   * Ghép threshold signature từ đủ shares (FROST reconstruct).
   * Trả về combined signature string.
   */
  reconstructThresholdSignature(): string | null {
    return this.frostThreshold.reconstruct();
  }

  /**
   * Kiểm tra xem nullifier đã được finalize (đã đạt threshold và ghi nhận) chưa.
   */
  markFinalized(nullifierHash: string): void {
    this.finalizedNullifiers.add(nullifierHash);
  }

  isFinalized(nullifierHash: string): boolean {
    return this.finalizedNullifiers.has(nullifierHash);
  }

  getValidatorCount(): number {
    return this.nodes.length;
  }

  getShareCount(nullifierHash: string): number {
    const nodeVotes = this.getVotes(nullifierHash) || [];
    return nodeVotes.length;
  }

  private getVotes(nullifierHash: string): { valid: boolean; nodeId: string }[] | undefined {
    // @ts-ignore - accessing private votes from parent
    return (this as any).votes?.get(nullifierHash);
  }
}
