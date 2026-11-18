use crate::fhe::context::FheContext;
use crate::types::WithdrawalRequest;
use std::sync::{Arc, RwLock};
use std::collections::HashSet;

pub struct ValidatorNode {
    pub node_id: String,
    pub share_index: u32,
    pub threshold_key_share: Vec<u8>,
    pub voted_nullifiers: RwLock<HashSet<String>>,
    pub fhe: Option<Arc<FheContext>>,
}

impl ValidatorNode {
    pub fn new(node_id: &str, share_index: u32) -> Self {
        Self {
            node_id: node_id.to_string(),
            share_index,
            threshold_key_share: rand::random::<[u8; 32]>().to_vec(),
            voted_nullifiers: RwLock::new(HashSet::new()),
            fhe: None,
        }
    }

    pub fn set_fhe(&mut self, fhe: Arc<FheContext>) {
        self.fhe = Some(fhe);
    }

    pub async fn validate_withdrawal(&self, req: &WithdrawalRequest) -> anyhow::Result<bool> {
        if !req.nullifier_hash.is_empty() && !req.commitment.is_empty() && !req.root.is_empty() {
            // Check double-vote
            let mut voted = self.voted_nullifiers.write().unwrap();
            if voted.contains(&req.nullifier_hash) {
                return Ok(false);
            }
            voted.insert(req.nullifier_hash.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn sign_vote(&self, nullifier_hash: &str, valid: bool) -> SignatureShare {
        let payload = format!("{}:{}:{}:{}", self.node_id, nullifier_hash, valid, std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos());
        let share = hex::encode(hmac_sha256(&self.threshold_key_share, payload.as_bytes()));
        let commitment = hex::encode(hmac_sha256(&self.node_id.as_bytes(), payload.as_bytes()));

        SignatureShare {
            node_id: self.node_id.clone(),
            share_index: self.share_index,
            share,
            commitment,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SignatureShare {
    pub node_id: String,
    pub share_index: u32,
    pub share: String,
    pub commitment: String,
    pub timestamp: u64,
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
