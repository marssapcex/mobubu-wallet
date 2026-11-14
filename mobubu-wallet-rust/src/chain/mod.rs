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
