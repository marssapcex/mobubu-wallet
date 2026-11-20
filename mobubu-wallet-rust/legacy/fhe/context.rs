use crate::types::WithdrawalRequest;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// TFHE-rs lightweight FHE context
// ---------------------------------------------------------------------------
//
// Hướng dẫn tối ưu từ Zama TFHE-rs (áp dụng theo):
//
// 1. Width 16-bit: dùng FheUint16 (8 blocks × PARAM_MESSAGE_2_CARRY_2),
//    đủ cho số tiền đến 65,535 đơn vị (chia nhỏ nếu cần hơn).
// 2. Ciphertext compression: CompressedCiphertextListBuilder giảm kích thước
//    ciphertext lên đến ~1,900x khi lưu/truyền.
//
// 3. CMUX (ciphertext mux) 500–1000× nhanh hơn PBS (programmable bootstrapping).
//    Ưu tiên CMP/MUX thay vì MUL/DIV (đã được hướng dẫn ở cấp hệ thống).
//
// 4. Padding: TFHE-rs giữ MSB làm padding bit để tránh overflow khi cộng.
//
// 5. Leveled operations (cộng, trừ) nhanh; PBS (so sánh, max) chậm → chỉ dùng
//    PBS khi thực sự cần (ví dụ CMP ge để kiểm tra balance).
//
// Lưu ý: Crate `tfhe` chưa được thêm vào Cargo.toml vì Rust toolchain hiện
// chưa cài được (SSL block rustup). Khi có toolchain, hãy uncomment dòng
// tfhe = "0.11" trong Cargo.toml và cargo build.

pub struct FheContext {
    /// Persistent client key (giữ bí mật, chỉ có ở client side)
    client_key: Mutex<Option<Vec<u8>>>,
    /// Serialized server key (gửi đến coprocessor/evaluator node)
    server_key: Mutex<Option<Vec<u8>>>,
    /// Ciphertext cache cho persistent worker mode (id-matched)
    cache: Mutex<HashMap<u64, Vec<u8>>>,
    next_id: Mutex<u64>,
}

impl FheContext {
    pub fn new() -> Self {
        Self {
            client_key: Mutex::new(None),
            server_key: Mutex::new(None),
            cache: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    // -----------------------------------------------------------------------
    // Key generation (client side only)
    // -----------------------------------------------------------------------
    /// Sinh cặp client key / server key với params tối ưu cho 16-bit.
    /// Trả về serialized server key để gửi đến evaluator node.
    pub fn keygen(&self) -> Result<Vec<u8>> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2;
        //     use tfhe::{ClientKey, ServerKey};
        //
        //     let ck = ClientKey::generate(PARAM_MESSAGE_2_CARRY_2);
        //     let sk = ServerKey::new(&ck);
        //
        //     let ck_serialized = bincode::serialize(&ck).map_err(|e| anyhow!("serialize ck: {}", e))?;
        //     let sk_serialized = bincode::serialize(&sk).map_err(|e| anyhow!("serialize sk: {}", e))?;
        //
        //     *self.client_key.lock().unwrap() = Some(ck_serialized.clone());
        //     *self.server_key.lock().unwrap() = Some(sk_serialized.clone());
        //
        //     Ok(sk_serialized)
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        Err(anyhow!(
            "tfhe-rs feature not enabled. Add tfhe = \"0.11\" to Cargo.toml and build with Rust toolchain."
        ))
    }

    /// Load server key (evaluator/coprocessor side only, không có secret key).
    pub fn load_server_key(&self, sk_serialized: &[u8]) -> Result<()> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::ServerKey;
        //
        //     let sk: ServerKey = bincode::deserialize(sk_serialized)
        //         .map_err(|e| anyhow!("deserialize sk: {}", e))?;
        //     *self.server_key.lock().unwrap() = Some(sk_serialized.to_vec());
        //     drop(sk); // server key kept in memory by caller
        //     Ok(())
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        {
            *self.server_key.lock().unwrap() = Some(sk_serialized.to_vec());
            Ok(())
        }
    }

    // -----------------------------------------------------------------------
    // Encrypt / Decrypt (client side only)
    // -----------------------------------------------------------------------
    /// Mã hóa số nguyên 16-bit (width 16).
    pub fn encrypt_u16(&self, value: u16) -> Result<Vec<u8>> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2;
        //     use tfhe::FheUint16;
        //
        //     let ck_serialized = self.client_key.lock().unwrap()
        //         .clone()
        //         .ok_or_else(|| anyhow!("client key not loaded"))?;
        //     let ck: ClientKey = bincode::deserialize(&ck_serialized)
        //         .map_err(|e| anyhow!("deserialize ck: {}", e))?;
        //
        //     let ct = FheUint16::try_encrypt(value, &ck)
        //         .map_err(|e| anyhow!("encrypt: {}", e))?;
        //
        //     bincode::serialize(&ct).map_err(|e| anyhow!("serialize ct: {}", e))
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        Err(anyhow!(
            "tfhe-rs feature not enabled. Add tfhe = \"0.11\" to Cargo.toml."
        ))
    }

    /// Giải mã ciphertext 16-bit (client side only).
    pub fn decrypt_u16(&self, ct_blob: &[u8]) -> Result<u16> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::FheUint16;
        //
        //     let ck_serialized = self.client_key.lock().unwrap()
        //         .clone()
        //         .ok_or_else(|| anyhow!("client key not loaded"))?;
        //     let ck: ClientKey = bincode::deserialize(&ck_serialized)
        //         .map_err(|e| anyhow!("deserialize ck: {}", e))?;
        //
        //     let ct: FheUint16 = bincode::deserialize(ct_blob)
        //         .map_err(|e| anyhow!("deserialize ct: {}", e))?;
        //
        //     Ok(ct.decrypt(&ck))
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        Err(anyhow!("tfhe-rs feature not enabled"))
    }

    // -----------------------------------------------------------------------
    // FHE comparison (evaluator/coprocessor side)
    // -----------------------------------------------------------------------
    /// Kiểm tra encrypted_balance >= amount (trả về encrypted boolean).
    /// Dùng PBS (programmable bootstrapping) — chỉ gọi khi cần.
    pub fn cmp_ge_encrypted(&self, ct_a_blob: &[u8], ct_b_blob: &[u8]) -> Result<Vec<u8>> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::FheUint16;
        //
        //     let sk_serialized = self.server_key.lock().unwrap()
        //         .clone()
        //         .ok_or_else(|| anyhow!("server key not loaded"))?;
        //     let sk: ServerKey = bincode::deserialize(&sk_serialized)
        //         .map_err(|e| anyhow!("deserialize sk: {}", e))?;
        //
        //     let a: FheUint16 = bincode::deserialize(ct_a_blob)
        //         .map_err(|e| anyhow!("deserialize a: {}", e))?;
        //     let b: FheUint16 = bincode::deserialize(ct_b_blob)
        //         .map_err(|e| anyhow!("deserialize b: {}", e))?;
        //
        //     // smart_max dùng PBS nội bộ; chuyển về boolean >=
        //     let ct_max = sk.smart_max_parallelized(&mut a.clone(), &mut b.clone());
        //     // Nếu max(a,b) == b thì a >= b; ta dùng lookup table để sinh boolean
        //     // Ở đây đơn giản hóa: trả về ciphertext của max để client decrypt
        //     bincode::serialize(&ct_max).map_err(|e| anyhow!("serialize max: {}", e))
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        Err(anyhow!("tfhe-rs feature not enabled"))
    }

    // -----------------------------------------------------------------------
    // Ciphertext compression (giảm kích thước lưu/truyền)
    // -----------------------------------------------------------------------
    /// Nén danh sách ciphertext thành một serialized blob nhỏ gọn.
    /// Giúp giảm bandwidth giữa client ↔ coprocessor ↔ blockchain.
    pub fn compress_ciphertexts(&self, blobs: &[Vec<u8>]) -> Result<Vec<u8>> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::shortint::parameters::COMP_PARAM_MESSAGE_2_CARRY_2;
        //     use tfhe::{CompressedCiphertextListBuilder, FheUint16};
        //
        //     let mut builder = CompressedCiphertextListBuilder::new();
        //     for blob in blobs {
        //         let ct: FheUint16 = bincode::deserialize(blob)
        //             .map_err(|e| anyhow!("deserialize ct: {}", e))?;
        //         builder = builder.push(ct);
        //     }
        //     let list = builder.build()
        //         .map_err(|e| anyhow!("build compressed list: {}", e))?;
        //
        //     bincode::serialize(&list).map_err(|e| anyhow!("serialize compressed: {}", e))
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        {
            // Placeholder: serialize danh sách blob thô (chưa nén thật)
            let mut out = Vec::new();
            for blob in blobs {
                out.extend_from_slice(blob);
                out.push(0); // separator
            }
            Ok(out)
        }
    }

    /// Giải nén danh sách ciphertext từ blob đã nén.
    pub fn decompress_ciphertexts(&self, blob: &[u8]) -> Result<Vec<Vec<u8>>> {
        // #[cfg(feature = "tfhe-rs")]
        // {
        //     use tfhe::prelude::*;
        //     use tfhe::{CompressedCiphertextList, FheUint16};
        //
        //     let list: CompressedCiphertextList = bincode::deserialize(blob)
        //         .map_err(|e| anyhow!("deserialize compressed list: {}", e))?;
        //
        //     let mut out = Vec::new();
        //     for i in 0.. {
        //         match list.get::<FheUint16>(i).unwrap() {
        //             Some(ct) => {
        //                 out.push(bincode::serialize(&ct).map_err(|e| anyhow!("serialize: {}", e))?);
        //             }
        //             None => break,
        //         }
        //     }
        //     Ok(out)
        // }
        // #[cfg(not(feature = "tfhe-rs"))]
        {
            // Placeholder: tách theo separator 0x00
            let mut out = Vec::new();
            let mut cur = Vec::new();
            for &b in blob {
                if b == 0 {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                } else {
                    cur.push(b);
                }
            }
            if !cur.is_empty() {
                out.push(cur);
            }
            Ok(out)
        }
    }

    // -----------------------------------------------------------------------
    // Withdrawal request helper
    // -----------------------------------------------------------------------
    pub fn build_withdrawal_request(
        nullifier_hash: &str,
        commitment: &str,
        amount: u128,
        encrypted_amount_fhe: &str,
        root: &str,
        recipient: &str,
    ) -> WithdrawalRequest {
        WithdrawalRequest {
            nullifier_hash: nullifier_hash.to_string(),
            commitment: commitment.to_string(),
            amount,
            encrypted_amount_fhe: encrypted_amount_fhe.to_string(),
            root: root.to_string(),
            recipient: recipient.to_string(),
        }
    }
}

impl Default for FheContext {
    fn default() -> Self {
        Self::new()
    }
}
