/**
 * @title Client SDK — Anonymous Cross-Chain Vault (REAL)
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
  root: string;
  pathElements: string[];
  pathIndices: number[];
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
 * commitment = Poseidon(nullifier, secret) — KHỚP CIRCUIT
 * nullifierHash = Poseidon(nullifier) — KHỚP CIRCUIT
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
 * Input JSON phải chứa tất cả private inputs:
 *   { nullifier, secret, pathElements, pathIndices, noteAmount, root, nullifierHash, commitment, recipient, relayer, fee, amount }
 */
export async function proveWithdrawal(
  wasmPath: string,
  zkeyPath: string,
  input: Record<string, any>
): Promise<{ proof: any; publicSignals: string[] }> {
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
  zkProofInputs: Record<string, any>;
  publicSignals: string[];
}> {
  const { note, amount, recipient, root, pathElements, pathIndices } = withdrawParams;

  // Convert path elements/indices to strings for snarkjs input
  const pathElementsStr = pathElements.map((e) => e.toString());
  const pathIndicesStr = pathIndices.map((i) => i.toString());

  const zkProofInputs: Record<string, any> = {
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
    pathElements: pathElementsStr,
    pathIndices: pathIndicesStr,
    commitment: note.commitment,
  };

  // Public signals (để verify trên chain)
  const publicSignals = [
    root,
    note.nullifierHash,
    recipient,
    "0x0000000000000000000000000000000000000000",
    "0",
    amount.toString(),
  ];

  return {
    nullifierHash: note.nullifierHash,
    commitment: note.commitment,
    amount,
    recipient,
    root,
    zkProofInputs,
    publicSignals,
  };
}

/**
 * Mã proof thành bytes calldata để gửi đến Solidity verifyProof.
 * proof là object {A, B, C} từ snarkjs.
 */
export function encodeProof(proof: any): string {
  const A = proof.pi_a;
  const B = proof.pi_b;
  const C = proof.pi_c;

  const bytes = [];
  // A.x, A.y
  bytes.push(padTo64(A[0]));
  bytes.push(padTo64(A[1]));
  // B.x0, B.x1, B.y0, B.y1
  bytes.push(padTo64(B[0][0]));
  bytes.push(padTo64(B[0][1]));
  bytes.push(padTo64(B[1][0]));
  bytes.push(padTo64(B[1][1]));
  // C.x, C.y
  bytes.push(padTo64(C[0]));
  bytes.push(padTo64(C[1]));

  return "0x" + bytes.join("");
}

function padTo64(value: string): string {
  let hex = value.startsWith("0x") ? value.slice(2) : value;
  while (hex.length < 64) hex = "0" + hex;
  return hex;
}
