use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct Config {
    pub chain: String,
    pub role: String,       // "client", "validator", "both"
    pub port: u16,
    pub cloud_key_path: Option<String>,
}

// ---------------------------------------------------------------------------
// AppState - shared state across tasks
// ---------------------------------------------------------------------------
pub struct AppState {
    pub config: Config,
    pub vault: RwLock<vault::Vault>,
    pub validator_net: RwLock<validator::ValidatorNetwork>,
    pub chain_adapters: RwLock<HashMap<String, Box<dyn chain::ChainAdapter + Send + Sync>>>,
    pub fhe_ctx: RwLock<Option<fhe::FheContext>>,
}

impl AppState {
    pub fn new(config: Config) -> anyhow::Result<Self> {
        Ok(Self {
            config,
            vault: RwLock::new(vault::Vault::new()),
            validator_net: RwLock::new(validator::ValidatorNetwork::new()),
            chain_adapters: RwLock::new(HashMap::new()),
            fhe_ctx: RwLock::new(None),
        })
    }

    pub fn register_adapter(&self, name: String, adapter: Box<dyn chain::ChainAdapter + Send + Sync>) {
        self.chain_adapters.write().unwrap().insert(name, adapter);
    }

    pub fn get_adapter(&self, name: &str) -> Option<Box<dyn chain::ChainAdapter + Send + Sync>> {
        self.chain_adapters.read().unwrap().get(name).map(|a| a.clone_box())
    }
}

// ---------------------------------------------------------------------------
// ChainAdapter trait - abstract over BTC, ETH, XMR, ZEC, DAI
// ---------------------------------------------------------------------------
#[async_trait::async_trait]
pub trait ChainAdapter: Send + Sync {
    fn chain_name(&self) -> &str;
    async fn get_balance(&self, address: &str) -> anyhow::Result<u128>;
    async fn send_transaction(&self, to: &str, amount: u128) -> anyhow::Result<String>;
    async fn watch_deposits<F>(&self, callback: F) -> anyhow::Result<()>
    where
        F: Fn(String, String, u128) + Send + Sync + 'static;
    fn clone_box(&self) -> Box<dyn ChainAdapter + Send + Sync>;
}

// ---------------------------------------------------------------------------
// Note - encrypted deposit note (Tornado-style)
// ---------------------------------------------------------------------------
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub commitment: String,       // Poseidon(nullifier, secret)
    pub nullifier: String,        // secret random
    pub nullifier_hash: String,   // Poseidon(nullifier)
    pub encrypted_amount_fhe: String, // base64 FHE ciphertext
    pub chain: String,
    pub asset: String,
    pub note_amount: u128,
}

// ---------------------------------------------------------------------------
// WithdrawalRequest - sent from client to coprocessor
// ---------------------------------------------------------------------------
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawalRequest {
    pub nullifier_hash: String,
    pub commitment: String,
    pub amount: u128,
    pub encrypted_amount_fhe: String,
    pub root: String,
    pub recipient: String,
}

// ---------------------------------------------------------------------------
// WithdrawalProofPacket - sent to blockchain for verification
// ---------------------------------------------------------------------------
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawalProofPacket {
    pub nullifier_hash: String,
    pub commitment: String,
    pub amount: u128,
    pub recipient: String,
    pub root: String,
    pub zk_proof: Vec<u8>,
    pub threshold_sigs: Vec<u8>,
    pub fhe_comparison_result: bool,
}

// ---------------------------------------------------------------------------
// Supported assets (5 coins)
// ---------------------------------------------------------------------------
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Asset {
    BTC,
    ETH,
    XMR,
    ZEC,
    DAI,
}

impl Asset {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_uppercase().as_str() {
            "BTC" => Some(Asset::BTC),
            "ETH" => Some(Asset::ETH),
            "XMR" => Some(Asset::XMR),
            "ZEC" => Some(Asset::ZEC),
            "DAI" => Some(Asset::DAI),
            _ => None,
        }
    }

    pub fn to_str(&self) -> &'static str {
        match self {
            Asset::BTC => "BTC",
            Asset::ETH => "ETH",
            Asset::XMR => "XMR",
            Asset::ZEC => "ZEC",
            Asset::DAI => "DAI",
        }
    }

    pub fn decimals(&self) -> u32 {
        match self {
            Asset::BTC => 8,
            Asset::ETH => 18,
            Asset::XMR => 12,
            Asset::ZEC => 8,
            Asset::DAI => 18,
        }
    }
}
