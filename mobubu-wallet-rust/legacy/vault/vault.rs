use crate::types::{Asset, Note, WithdrawalProofPacket};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

/// In-memory Vault (mirrors Solidity AnonymousVault).
/// In production, this state lives on-chain; here we keep it for local testing.
pub struct Vault {
    pub leaves: RwLock<Vec<String>>,
    pub leaf_at_index: RwLock<HashMap<u64, String>>,
    pub commitment_to_index: RwLock<HashMap<String, u64>>,
    pub leaf_count: RwLock<u64>,
    pub used_roots: RwLock<HashSet<String>>,
    pub latest_root: RwLock<String>,
    pub spent_nullifiers: RwLock<HashSet<String>>,
    pub existing_commitments: RwLock<HashSet<String>>,
    pub total_locked: RwLock<u128>,
    pub tree_depth: u32,
}

impl Vault {
    pub fn new() -> Self {
        let zero = "0".repeat(64);
        let mut leaves = Vec::new();
        leaves.push(zero.clone());
        let mut leaf_at_index = HashMap::new();
        leaf_at_index.insert(0, zero.clone());
        let latest_root = zero.clone();
        let mut used_roots = HashSet::new();
        used_roots.insert(latest_root.clone());

        Self {
            leaves: RwLock::new(leaves),
            leaf_at_index: RwLock::new(leaf_at_index),
            commitment_to_index: RwLock::new(HashMap::new()),
            leaf_count: RwLock::new(1),
            used_roots: RwLock::new(used_roots),
            latest_root: RwLock::new(latest_root),
            spent_nullifiers: RwLock::new(HashSet::new()),
            existing_commitments: RwLock::new(HashSet::new()),
            total_locked: RwLock::new(0),
            tree_depth: 20,
        }
    }

    pub fn max_leaves(&self) -> u64 {
        1 << self.tree_depth
    }

    /// Deposit asset into vault. Returns leaf index.
    pub fn deposit(&self, amount: u128, commitment: &str, nullifier_hash: &str) -> anyhow::Result<u64> {
        let mut existing = self.existing_commitments.write().unwrap();
        let mut spent = self.spent_nullifiers.write().unwrap();
        let mut count = self.leaf_count.write().unwrap();

        if existing.contains(commitment.to_string()) {
            return Err(anyhow::anyhow!("commitment already exists"));
        }
        if spent.contains(nullifier_hash.to_string()) {
            return Err(anyhow::anyhow!("nullifier already spent"));
        }
        if *count >= self.max_leaves() {
            return Err(anyhow::anyhow!("merkle tree full"));
        }

        existing.insert(commitment.to_string());
        let index = *count;
        self.leaves.write().unwrap().push(commitment.to_string());
        self.leaf_at_index.write().unwrap().insert(index, commitment.to_string());
        self.commitment_to_index.write().unwrap().insert(commitment.to_string(), index);
        *count += 1;

        // Recompute root (simplified: hash all leaves)
        let new_root = self.compute_root();
        {
            let mut root = self.latest_root.write().unwrap();
            let mut roots = self.used_roots.write().unwrap();
            roots.insert(new_root.clone());
            *root = new_root;
        }

        *self.total_locked.write().unwrap() += amount;

        Ok(index)
    }

    /// Withdraw asset from vault. Requires ZK proof + threshold sigs (verified off-chain).
    pub fn withdraw(&self, nullifier_hash: &str, commitment: &str, root: &str, amount: u128) -> anyhow::Result<u128> {
        let mut spent = self.spent_nullifiers.write().unwrap();
        let mut existing = self.existing_commitments.write().unwrap();
        let mut count = self.leaf_count.write().unwrap();
        let mut total = self.total_locked.write().unwrap();
        let mut root_lock = self.latest_root.write().unwrap();
        let mut used_roots = self.used_roots.write().unwrap();

        if spent.contains(nullifier_hash.to_string()) {
            return Err(anyhow::anyhow!("nullifier already spent"));
        }
        if !existing.contains(commitment.to_string()) {
            return Err(anyhow::anyhow!("commitment does not exist"));
        }
        if *root_lock != root.to_string() {
            return Err(anyhow::anyhow!("stale merkle root"));
        }
        if *total < amount {
            return Err(anyhow::anyhow!("insufficient funds in vault"));
        }

        spent.insert(nullifier_hash.to_string());
        existing.remove(commitment);
        *total -= amount;

        Ok(amount)
    }

    /// Compute Merkle root from current leaves (simplified keccak tree)
    fn compute_root(&self) -> String {
        let leaves = self.leaves.read().unwrap();
        if leaves.is_empty() {
            return "0".repeat(64);
        }
        let mut level: Vec<String> = leaves.clone();
        while level.len() > 1 {
            let mut next = Vec::new();
            for i in (0..level.len()).step_by(2) {
                let left = &level[i];
                let right = if i + 1 < level.len() { &level[i + 1] } else { left };
                let combined = format!("{}{}", left, right);
                let hash = sha2::Sha256::digest(combined.as_bytes());
                next.push(format!("{:x}", hash));
            }
            level = next;
        }
        level[0].clone()
    }

    pub fn get_total_locked(&self) -> u128 {
        *self.total_locked.read().unwrap()
    }

    pub fn is_spent(&self, nullifier_hash: &str) -> bool {
        self.spent_nullifiers.read().unwrap().contains(nullifier_hash)
    }

    pub fn get_latest_root(&self) -> String {
        self.latest_root.read().unwrap().clone()
    }

    pub fn get_leaf_count(&self) -> u64 {
        *self.leaf_count.read().unwrap()
    }
}

impl Default for Vault {
    fn default() -> Self {
        Self::new()
    }
}
