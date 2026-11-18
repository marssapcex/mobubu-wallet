/**
 * @title FHE Client Placeholder
 * @dev Gói gọn TfheClient từ fhe-swap để mã hóa số tiền khi nạp note.
 *      Trong production, dùng public key của mạng validator network.
 */

import { makeTfhe, type TfheClient } from "../../../fhe-swap/src/fhe/tfhe";

let client: TfheClient | null = null;

/**
 * Khởi tạo FHE client (chỉ cần gọi một lần).
 */
export async function initFHEClient(cloudKeyPath?: string): Promise<void> {
  if (client) return;
  const { crypto } = await makeTfhe({
    role: "client",
    width: 16,
    security: 128,
  });
  client = crypto as TfheClient;
}

/**
 * Mã hóa amount bằng FHE (trả về base64 blob).
 * Chỉ client có secret key mới thực hiện được.
 */
export async function encryptFHE(amount: bigint | number): Promise<string> {
  if (!client) await initFHEClient();
  if (!client) throw new Error("FHE client not initialized");

  const ct = await client!.encrypt(amount);
  return ct.blob;
}
