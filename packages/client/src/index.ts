/**
 * @title Client SDK — Anonymous Cross-Chain Vault (mô hình Tornado Cash note)
 * @dev Client-side logic: kết nối ví, sinh key tạm khi nạp, tạo note,
 *      mã hóa số tiền bằng FHE, chuẩn bị dữ liệu ZK-SNARK withdrawal.
 */

import * as ethers from "ethers";
import { encryptFHE } from "./fhe-client"; // placeholder FHE client (gắn vào TfheClient từ fhe-swap)

export interface DepositParams {
  asset: string;            // token address hoặc "BTC"/"XMR"/"ZEC"
  amount: bigint;           // số tiền nạp (wei / đơn vị nhỏ nhất)
  chain: string;            // chain nạp
  secret: string;           // ephemeral secret do user sinh
}

export interface WithdrawParams {
  recipient: string;        // địa chỉ nhận trên chain destino
  amount: bigint;           // số tiền muốn rút
  note: Note;               // note do user giữ sau khi nạp
  zkProof: any;             // ZK-SNARK proof (sinh bởi prover bên ngoài)
  thresholdSigs: any;       // threshold signatures từ validator network
}

export interface Note {
  commitment: string;       // Pedersen(nullifier, secret)
  nullifier: string;        // bí mật, dùng để tính nullifierHash
  secret: string;           // bí mật, dùng để mở khóa commitment
  encryptedAmountFHE: string; // base64 FHE ciphertext của amount
  nullifierHash: string;    // Pedersen(nullifier), public input của ZK + contract
  chain: string;
  asset: string;
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
 * commitment = Pedersen(nullifier, secret)
 * nullifierHash = Pedersen(nullifier)  --> public input, contract dùng để chống double-spend
 * encryptedAmountFHE = FHE.encrypt(networkPublicKey, amount)
 */
export async function createNote(
  params: DepositParams
): Promise<Note> {
  const { secret, amount, chain, asset } = params;

  // nullifier có thể sinh từ secret + chain + asset để đảm bảo duy nhất
  const nullifierInput = ethers.solidityPackedKeccak256(
    ["string", "string", "string", "string"],
    [secret, chain, asset, "nullifier"]
  );

  // commitment = hash(nullifier, secret)
  const commitmentInput = ethers.solidityPackedKeccak256(
    ["string", "string"],
    [nullifierInput, secret]
  );

  // nullifierHash = hash(nullifier) -> công khai, contract đánh dấu đã dùng
  const nullifierHashInput = ethers.solidityPackedKeccak256(
    ["string"],
    [nullifierInput]
  );

  // Mã hóa amount bằng FHE public key của mạng validator (off-chain)
  const encryptedAmountFHE = await encryptFHE(amount);

  return {
    commitment: commitmentInput,
    nullifier: nullifierInput,
    secret,
    encryptedAmountFHE,
    nullifierHash: nullifierHashInput,
    chain,
    asset,
  };
}

/**
 * Chuẩn bị dữ liệu withdrawal: cấu trúc đầu vào cho ZK prover và contract.
 * Trong production, gọi ZK prover (snarkjs / circom) để sinh proof thực.
 */
export async function prepareWithdrawal(
  withdrawParams: WithdrawParams
): Promise<{
  nullifierHash: string;
  commitment: string;
  amount: bigint;
  recipient: string;
  zkProofInputs: {
    root: string;
    nullifierHash: string;
    amount: string;
    // pathElements và pathIndices được lấy từ indexer/RPC
  };
}> {
  const { note, amount, recipient } = withdrawParams;

  const zkProofInputs = {
    root: "", // TODO: lấy merkle root mới nhất từ indexer/RPC
    nullifierHash: note.nullifierHash,
    amount: amount.toString(),
  };

  return {
    nullifierHash: note.nullifierHash,
    commitment: note.commitment,
    amount,
    recipient,
    zkProofInputs,
  };
}
