/**
 * @title FHE Coprocessor Architecture (Off-chain)
 * @dev Mô hình coprocessor: FHE computation chạy hoàn toàn off-chain trên các
 *      node chuyên dụng. Blockchain chỉ verify ZK-SNARK proof và threshold
 *      signatures, không lưu ciphertext FHE, không chạy FHE on-chain.
 *
 * Kiến trúc:
 *   Client (có secret key) ──encrypt──> Coprocessor Node (chỉ có cloud key)
 *   Coprocessor Node ──compute FHE on ciphertext──> ZK Proof + Threshold Sig
 *   Blockchain ──verify ZK + Threshold──> unlock vault
 *
 * Ưu tiên CMP/MUX thay vì MUL/DIV (FHE MUL/DIV cực chậm).
 */

import {
  TfheClient,
  TfheEvaluator,
  type EncryptedInt,
  type TfheParams,
} from "./tfhe.js";

/**
 * Yêu cầu withdrawal được gửi từ client đến coprocessor node.
 */
export interface WithdrawalRequest {
  nullifierHash: string;
  commitment: string;
  amount: bigint;            // số tiền muốn rút (public, cho ZK circuit)
  encryptedAmountFHE: string; // base64 FHE ciphertext của số tiền trong note
  root: string;               // merkle root hiện tại
  recipient: string;          // địa chỉ nhận tiền
}

/**
 * Kết quả coprocessor xử lý xong: gửi đến blockchain để verify.
 */
export interface WithdrawalProofPacket {
  nullifierHash: string;
  commitment: string;
  amount: bigint;
  recipient: string;
  root: string;
  zkProof: any;               // Circom/SNARK proof (sinh bởi client hoặc prover)
  thresholdSigs: any;         // Chữ ký threshold từ mạng validator
  fheComparisonResult: boolean; // true nếu encrypted_balance >= amount
}

/**
 * CoprocessorNode: chạy off-chain, chỉ có cloud key.
 * Nhiệm vụ: chạy FHE comparison trên ciphertext, ký threshold vote.
 */
export class CoprocessorNode {
  public readonly nodeId: string;
  private evaluator: TfheEvaluator | null = null;
  private params: TfheParams | null = null;
  private votedNullifiers = new Set<string>();

  constructor(nodeId?: string) {
    this.nodeId = nodeId ?? `coproc-${Date.now()}`;
  }

  async init(cloudKeyPath: string): Promise<void> {
    const { crypto } = await import("./tfhe.js").then((m) =>
      m.makeTfhe({
        role: "evaluator",
        cloudKeyPath,
        width: 16, // giảm từ 32-bit xuống 16-bit để tăng tốc
      }),
    );
    if (!(crypto instanceof TfheEvaluator)) {
      throw new Error("expected evaluator");
    }
    this.evaluator = crypto;
    this.params = this.evaluator.params();
    console.log(`[Coprocessor ${this.nodeId}] initialized, params:`, JSON.stringify(this.params));
  }

  /**
   * Kiểm tra FHE: encrypted_balance >= withdrawAmount.
   * Chạy trên ciphertext, không bao giờ giải mã số tiền thật.
   * Ưu tiên CMP (so sánh) thay vì MUL/DIV.
   */
  async checkBalance(
    encryptedBalance: EncryptedInt,
    withdrawAmount: bigint,
  ): Promise<EncryptedInt> {
    if (!this.evaluator) throw new Error("evaluator not initialized");

    // Mã hóa withdrawAmount thành ciphertext cùng width
    const encAmount = await this.evaluator.constant(withdrawAmount);

    // CMP ge: balance >= amount (1 gate bootstrapped per bit, nhanh hơn MUL/DIV)
    const result = await this.evaluator.cmp(
      encryptedBalance,
      encAmount,
      "ge",
    );

    return result; // Trả về encrypted boolean, client/validator tập trung decrypt
  }

  /**
   * Ký threshold vote cho withdrawal hợp lệ.
   * Trong production dùng FROST/BLS threshold signature.
   */
  signVote(nullifierHash: string, valid: boolean): string {
    if (this.votedNullifiers.has(nullifierHash)) {
      throw new Error(`Coprocessor ${this.nodeId} already voted for ${nullifierHash}`);
    }
    this.votedNullifiers.add(nullifierHash);

    const payload = `${this.nodeId}:${nullifierHash}:${valid}:${Date.now()}`;
    return Buffer.from(payload).toString("hex");
  }

  hasVoted(nullifierHash: string): boolean {
    return this.votedNullifiers.has(nullifierHash);
  }
}

/**
 * CoprocessorNetwork: quản lý nhiều node, tích lũy threshold votes.
 */
export class CoprocessorNetwork {
  private nodes: CoprocessorNode[] = [];
  private votes = new Map<string, { valid: boolean; nodeId: string; timestamp: number }[]>();
  public readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  addNode(node: CoprocessorNode): void {
    this.nodes.push(node);
  }

  async initializeAll(cloudKeyPath: string): Promise<void> {
    for (const node of this.nodes) {
      await node.init(cloudKeyPath);
    }
  }

  submitVote(nullifierHash: string, valid: boolean, nodeId: string): void {
    if (!this.votes.has(nullifierHash)) {
      this.votes.set(nullifierHash, []);
    }
    this.votes.get(nullifierHash)!.push({ valid, nodeId, timestamp: Date.now() });
  }

  isThresholdMet(nullifierHash: string): boolean {
    const nodeVotes = this.votes.get(nullifierHash) || [];
    const validVotes = nodeVotes.filter((v) => v.valid).length;
    return validVotes >= this.threshold;
  }

  getConsensus(nullifierHash: string): {
    valid: boolean;
    votes: number;
    total: number;
  } {
    const nodeVotes = this.votes.get(nullifierHash) || [];
    const validVotes = nodeVotes.filter((v) => v.valid).length;
    return {
      valid: validVotes >= this.threshold,
      votes: validVotes,
      total: nodeVotes.length,
    };
  }

  getNodeCount(): number {
    return this.nodes.length;
  }
}

/**
 * Tạo gói proof gửi lên blockchain (chỉ chứa ZK proof + threshold sigs,
 * KHÔNG chứa ciphertext FHE).
 */
export function buildWithdrawalPacket(
  req: WithdrawalRequest,
  zkProof: any,
  thresholdSigs: any,
  fheOk: boolean,
): WithdrawalProofPacket {
  return {
    nullifierHash: req.nullifierHash,
    commitment: req.commitment,
    amount: req.amount,
    recipient: req.recipient,
    root: req.root,
    zkProof,
    thresholdSigs,
    fheComparisonResult: fheOk,
  };
}
