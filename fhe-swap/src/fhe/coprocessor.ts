import { TfheEvaluator, makeTfhe, type EncryptedInt } from "./tfhe.js";

/**
 * Local research capability: evaluate an encrypted unsigned balance >= a
 * public amount. Caller receives an encrypted bit, not a vote or attestation.
 * This does not bind the ciphertext to a deposit or authorize any withdrawal.
 */
export class BalanceCoprocessor {
  private constructor(private readonly evaluator: TfheEvaluator) {}

  static async create(cloudKeyPath: string): Promise<BalanceCoprocessor> {
    const { crypto } = await makeTfhe({ role: "evaluator", cloudKeyPath });
    return new BalanceCoprocessor(crypto);
  }

  checkBalance(balance: EncryptedInt, publicAmount: bigint): Promise<EncryptedInt> {
    return this.evaluator.geConst(balance, publicAmount);
  }

  close(): void { this.evaluator.close(); }
}
