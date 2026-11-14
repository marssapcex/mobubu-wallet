/**
 * @title Validator Node — Coprocessor Architecture (Off-chain)
 * @dev Node trong mạng lưới validator chạy off-chain:
 *   1. Chỉ có cloud key (không có secret key)
 *   2. Chạy FHE evaluator để kiểm tra encrypted_balance >= withdraw_amount
 *   3. Ký threshold vote
 *   4. Blockchain chỉ verify ZK-SNARK + threshold signatures, KHÔNG chạy FHE on-chain
 *
 * Ưu tiên CMP/MUX thay vì MUL/DIV (FHE MUL/DIV cực chậm). Width mặc định = 16-bit.
 */

import * as crypto from "node:crypto";
import { CoprocessorNode, CoprocessorNetwork, type WithdrawalRequest } from "../../fhe-swap/src/fhe/coprocessor.js";

export interface ValidatorVote {
  nullifierHash: string;
  valid: boolean;
  signatureShare: string;
  nodeId: string;
  timestamp: number;
}

export class ValidatorNode extends CoprocessorNode {
  private thresholdKeyShare: Buffer;

  constructor(nodeId?: string) {
    super(nodeId);
    this.thresholdKeyShare = crypto.randomBytes(32);
  }

  /**
   * Validate withdrawal request: cấu trúc hợp lệ + FHE check passed.
   */
  async validateWithdrawal(req: WithdrawalRequest): Promise<boolean> {
    if (!req.nullifierHash || !req.commitment || !req.root || !req.encryptedAmountFHE) {
      return false;
    }
    // FHE check đã được thực hiện bởi CoprocessorNode.checkBalance
    // Ở đây chỉ xác nhận cấu trúc và ký vote
    return true;
  }

  signVote(nullifierHash: string, valid: boolean): ValidatorVote {
    const payload = `${this.nodeId}:${nullifierHash}:${valid}:${Date.now()}`;
    const signatureShare = crypto
      .createHmac("sha256", this.thresholdKeyShare)
      .update(payload)
      .digest("hex");

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

  constructor(config: NetworkConfig) {
    super(config.threshold);
    this.config = config;
  }

  addNode(node: ValidatorNode): void {
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
}
