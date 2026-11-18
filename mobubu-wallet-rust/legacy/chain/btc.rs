use crate::types::{Asset, ChainAdapter};
use async_trait::async_trait;

pub struct BtcAdapter;

impl BtcAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ChainAdapter for BtcAdapter {
    fn chain_name(&self) -> &str {
        "BTC"
    }

    async fn get_balance(&self, address: &str) -> anyhow::Result<u128> {
        // TODO: connect to Bitcoin node (bitcoind RPC) or Electrum
        tracing::info!(address, "BTC get_balance (stub)");
        Ok(0)
    }

    async fn send_transaction(&self, to: &str, amount: u128) -> anyhow::Result<String> {
        tracing::info!(to, amount, "BTC send_transaction (stub)");
        Ok("btc_tx_placeholder".to_string())
    }

    async fn watch_deposits<F>(&self, callback: F) -> anyhow::Result<()>
    where
        F: Fn(String, String, u128) + Send + Sync + 'static,
    {
        tracing::info!("BTC watch_deposits started (stub)");
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }

    fn clone_box(&self) -> Box<dyn ChainAdapter + Send + Sync> {
        Box::new(Self)
    }
}
