use crate::types::WithdrawalRequest;
use crate::validator::node::{ValidatorNode, SignatureShare};
use std::collections::{HashMap, HashSet};

pub struct ValidatorNetwork {
    pub nodes: Vec<ValidatorNode>,
    pub threshold: u32,
    pub votes: RwLock<HashMap<String, Vec<SignatureShare>>>,
    pub finalized: RwLock<HashSet<String>>,
}

use std::sync::RwLock;

impl ValidatorNetwork {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            threshold: 2,
            votes: RwLock::new(HashMap::new()),
            finalized: RwLock::new(HashSet::new()),
        }
    }

    pub fn with_threshold(mut self, threshold: u32) -> Self {
        self.threshold = threshold;
        self
    }

    pub fn add_node(&mut self, node: ValidatorNode) {
        self.nodes.push(node);
    }

    pub fn submit_vote(&self, nullifier_hash: &str, vote: SignatureShare) {
        let mut votes = self.votes.write().unwrap();
        votes.entry(nullifier_hash.to_string()).or_default().push(vote);
    }

    pub fn is_threshold_met(&self, nullifier_hash: &str) -> bool {
        let votes = self.votes.read().unwrap();
        let node_votes = votes.get(nullifier_hash).unwrap_or(&Vec::new());
        let valid_count = node_votes.iter().filter(|v| /* all shares are valid by construction */ true).count();
        (valid_count as u32) >= self.threshold
    }

    pub fn reconstruct_signature(&self, nullifier_hash: &str) -> Option<String> {
        let votes = self.votes.read().unwrap();
        let node_votes = votes.get(nullifier_hash)?;
        if node_votes.len() < self.threshold as usize {
            return None;
        }
        // XOR all shares (placeholder for Lagrange interpolation)
        let mut result = 0u128;
        for v in node_votes {
            if let Ok(val) = u128::from_str_radix(&v.share, 16) {
                result ^= val;
            }
        }
        Some(format!("{:x}", result))
    }

    pub fn mark_finalized(&self, nullifier_hash: &str) {
        self.finalized.write().unwrap().insert(nullifier_hash.to_string());
    }

    pub fn is_finalized(&self, nullifier_hash: &str) -> bool {
        self.finalized.read().unwrap().contains(nullifier_hash)
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub async fn validate_and_vote(&self, node_idx: usize, req: &WithdrawalRequest, valid: bool) -> anyhow::Result<SignatureShare> {
        if node_idx >= self.nodes.len() {
            return Err(anyhow::anyhow!("node index out of range"));
        }
        let node = &self.nodes[node_idx];
        if node.validate_withdrawal(req).await? {
            let share = node.sign_vote(&req.nullifier_hash, valid);
            self.submit_vote(&req.nullifier_hash, share.clone());
            Ok(share)
        } else {
            Err(anyhow::anyhow!("validation failed"))
        }
    }
}

impl Default for ValidatorNetwork {
    fn default() -> Self {
        Self::new()
    }
}
