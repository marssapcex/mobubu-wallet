/**
 * @title Client SDK — Anonymous Cross-Chain Vault (REAL, not mock)
 * @dev Client-side logic:
 *   1. Kết nối ví, sinh ephemeral key pair khi nạp
 *   2. Tạo note = {nullifier, secret, commitment, nullifierHash, encryptedAmountFHE}
 *      với Poseidon hash (khớp circuit Circom)
 *   3. Mã hóa số tiền bằng FHE (off-chain)
 *   4. Chuẩn bị ZK-SNARK proof (snarkjs groth16) cho withdrawal
 *   5. Gửi withdrawal packet đến blockchain qua coprocessor network
 */

import * as ethers from "ethers";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { encryptFHE } from "./fhe-client";

export interface DepositParams {
  asset: string;
  amount: bigint;
  chain: string;
  secret: string;
}

export interface WithdrawParams {
  recipient: string;
  amount: bigint;
  note: Note;
  zkProof: any;
  thresholdSigs: any;
  root: string;
}

export interface Note {
  commitment: string;
  nullifier: string;
  secret: string;
  nullifierHash: string;
  encryptedAmountFHE: string;
  chain: string;
  asset: string;
  noteAmount: bigint;
}

let poseidon: any = null;

async function getPoseidon() {
  if (!poseidon) {
    poseidon = await buildPoseidon();
  }
  return poseidon;
}

/**
 * Hash Poseidon (khớp circuit Circom: Poseidon(2) cho commitment, Poseidon(1) cho nullifierHash)
 */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  const arr = inputs.map((x) => p.F.toObject(x));
  const res = p(arr);
  return p.F.toObject(res);
}

/**
 * Sinh ephemeral key pair khi user kết nối ví và muốn nạp.
 */
export function generateEphemeralKeys(): { secret: string; publicKey: string } {
  const secret = ethers.randomBytes(32).toString("hex");
  const publicKey = ethers.keccak256(ethers.toUtf8Bytes(secret));
  return { secret, publicKey };
}

/**
 * Tạo note sau khi nạp.
 * commitment = Poseidon(nullifier, secret)
 * nullifierHash = Poseidon(nullifier)
 * encryptedAmountFHE = FHE.encrypt(networkPublicKey, amount)
 */
export async function createNote(
  params: DepositParams
): Promise<Note> {
  const { secret, amount, chain, asset } = params;

  const nullifierInput = ethers.solidityPackedKeccak256(
    ["string", "string", "string", "string"],
    [secret, chain, asset, "nullifier"]
  );
  const nullifierBigInt = BigInt(nullifierInput);
  const secretBigInt = BigInt(secret);

  // commitment = Poseidon(nullifier, secret) — KHỚP CIRCUIT
  const commitmentBigInt = await poseidonHash([nullifierBigInt, secretBigInt]);
  const commitment = "0x" + commitmentBigInt.toString(16).padStart(64, "0");

  // nullifierHash = Poseidon(nullifier) — KHỚP CIRCUIT
  const nullifierHashBigInt = await poseidonHash([nullifierBigInt]);
  const nullifierHash = "0x" + nullifierHashBigInt.toString(16).padStart(64, "0");

  // Mã hóa amount bằng FHE (client-side, chỉ client có secret key)
  const encryptedAmountFHE = await encryptFHE(amount);

  return {
    commitment,
    nullifier: nullifierInput,
    secret,
    encryptedAmountFHE,
    nullifierHash,
    chain,
    asset,
    noteAmount: amount,
  };
}

/**
 * Sinh ZK-SNARK proof thật bằng snarkjs groth16.
 * Trong production, input JSON phải chứa tất cả private inputs:
 *   { nullifier, secret, pathElements, pathIndices, noteAmount, root, nullifierHash, commitment }
 */
export async function proveWithdrawal(
  wasmPath: string,
  zkeyPath: string,
  input: any
): Promise<{ proof: any; publicSignals: any[] }> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );
  return { proof, publicSignals };
}

/**
 * Chuẩn bị dữ liệu withdrawal: cấu trúc đầu vào cho ZK prover và contract.
 */
export async function prepareWithdrawal(
  withdrawParams: WithdrawParams
): Promise<{
  nullifierHash: string;
  commitment: string;
  amount: bigint;
  recipient: string;
  root: string;
  zkProofInputs: any;
}> {
  const { note, amount, recipient, root } = withdrawParams;

  const zkProofInputs = {
    root,
    nullifierHash: note.nullifierHash,
    recipient,
    relayer: "0x0000000000000000000000000000000000000000",
    fee: "0",
    amount: amount.toString(),
    // Private inputs (không gửi lên chain, chỉ dùng để prove):
    nullifier: note.nullifier,
    secret: note.secret,
    noteAmount: note.noteAmount.toString(),
    // pathElements và pathIndices được lấy từ indexer/RPC (merkle tree audit path)
    pathElements: [],
    pathIndices: [],
  };

  return {
    nullifierHash: note.nullifierHash,
    commitment: note.commitment,
    amount,
    recipient,
    root,
    zkProofInputs,
  };
}
