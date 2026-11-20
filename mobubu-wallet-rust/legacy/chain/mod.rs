pub mod btc;
pub mod eth;

pub use btc::BtcAdapter;
pub use eth::EthAdapter;

pub fn register_all(state: &crate::types::AppState) {
    state.register_adapter("BTC".to_string(), Box::new(BtcAdapter::new()));
    state.register_adapter("ETH".to_string(), Box::new(EthAdapter::new()));
}

/// Watch chain for deposit events (stub implementation).
/// Historical BTC/ETH stub; no real receipt or output validation.
pub async fn watch_chain(
    state: std::sync::Arc<crate::types::AppState>,
    chain: &str,
) -> anyhow::Result<()> {
    let adapter = state
        .get_adapter(chain)
        .ok_or_else(|| anyhow!("no adapter for chain {}", chain))?;
    tracing::info!(chain, "watch_chain started (stub)");
    adapter.watch_deposits(|_user, _asset, _amount| {
        // In production: validate deposit, create commitment, update merkle root
    })?;
    Ok(())
}
