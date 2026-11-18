use crate::types::{Asset, ChainAdapter};
use async_trait::async_trait;

pub struct DaiAdapter;

impl DaiAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ChainAdapter for DaiAdapter {
    fn chain_name(&self) -> &str {
        "DAI"
    }

    async fn get_balance(&self, address: &str) -> anyhow::Result<u128> {
        tracing::info!(address, "DAI get_balance (stub)");
        Ok(0)
    }

    async fn send_transaction(&self, to: &str, amount: u128) -> anyhow::Result<String> {
        tracing::info!(to, amount, "DAI send_transaction (stub)");
        Ok("dai_tx_placeholder".to_string())
    }

    async fn watch_deposits<F>(&self, callback: F) -> anyhow::Result<()>
    where
        F: Fn(String, String, u128) + Send + Sync + 'static,
    {
        tracing::info!("DAI watch_deposits started (stub)");
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }

    fn clone_box(&self) -> Box<dyn ChainAdapter + Send + Sync> {
        Box::new(Self)
    }
}
