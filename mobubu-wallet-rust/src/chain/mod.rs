pub mod btc;
pub mod eth;
pub mod xmr;
pub mod zec;
pub mod dai;

pub use btc::BtcAdapter;
pub use eth::EthAdapter;
pub use xmr::XmrAdapter;
pub use zec::ZecAdapter;
pub use dai::DaiAdapter;

pub fn register_all(state: &crate::types::AppState) {
    state.register_adapter("BTC".to_string(), Box::new(BtcAdapter::new()));
    state.register_adapter("ETH".to_string(), Box::new(EthAdapter::new()));
    state.register_adapter("XMR".to_string(), Box::new(XmrAdapter::new()));
    state.register_adapter("ZEC".to_string(), Box::new(ZecAdapter::new()));
    state.register_adapter("DAI".to_string(), Box::new(DaiAdapter::new()));
}

/// Watch chain for deposit events (stub implementation).
/// In production, connect to JSON-RPC (eth_getLogs for ETH/DAI,
/// getblockchainnotify for BTC, monerod for XMR, zcashd for ZEC).
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
