use crate::types::{Asset, ChainAdapter};
use async_trait::async_trait;

pub struct EthAdapter;

impl EthAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ChainAdapter for EthAdapter {
    fn chain_name(&self) -> &str {
        "ETH"
    }

    async fn get_balance(&self, address: &str) -> anyhow::Result<u128> {
        tracing::info!(address, "ETH get_balance (stub)");
        Ok(0)
    }

    async fn send_transaction(&self, to: &str, amount: u128) -> anyhow::Result<String> {
        tracing::info!(to, amount, "ETH send_transaction (stub)");
        Ok("eth_tx_placeholder".to_string())
    }

    async fn watch_deposits<F>(&self, callback: F) -> anyhow::Result<()>
    where
        F: Fn(String, String, u128) + Send + Sync + 'static,
    {
        tracing::info!("ETH watch_deposits started (stub)");
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }

    fn clone_box(&self) -> Box<dyn ChainAdapter + Send + Sync> {
        Box::new(Self)
    }
}
