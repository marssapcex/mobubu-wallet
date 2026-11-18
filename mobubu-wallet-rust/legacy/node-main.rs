mod chain;
mod fhe;
mod zk;
mod vault;
mod validator;
mod network;
mod types;

use clap::Parser;
use std::sync::Arc;
use tokio::signal;

#[derive(Parser, Debug)]
#[command(author, version, about = "mobubu-wallet - Anonymous Cross-Chain Vault (FHE + ZK)", long_about = None)]
struct Args {
    /// Chain label for the archived example (btc or eth)
    #[arg(short, long, default_value = "eth")]
    chain: String,

    /// Role: client, validator, or both
    #[arg(short, long, default_value = "both")]
    role: String,

    /// Listen port for P2P
    #[arg(long, default_value = "30333")]
    port: u16,

    /// Cloud key path for FHE evaluator
    #[arg(long)]
    cloud_key: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    println!("=== mobubu-wallet (Rust) ===");
    println!("Chain: {}", args.chain);
    println!("Role: {}", args.role);
    println!("Port: {}", args.port);

    let config = types::Config {
        chain: args.chain.clone(),
        role: args.role.clone(),
        port: args.port,
        cloud_key_path: args.cloud_key.clone(),
    };

    let state = Arc::new(types::AppState::new(config)?);

    // Start P2P network
    if args.role == "validator" || args.role == "both" {
        let state_clone = state.clone();
        tokio::spawn(async move {
            if let Err(e) = network::run_p2p(state_clone).await {
                tracing::error!(error = %e, "P2P network error");
            }
        });
    }

    // Start chain watcher (deposit/withdraw events)
    let state_clone = state.clone();
    tokio::spawn(async move {
        if let Err(e) = chain::watch_chain(state_clone, &args.chain).await {
            tracing::error!(error = %e, chain = %args.chain, "Chain watcher error");
        }
    });

    // Wait for shutdown signal
    signal::ctrl_c().await?;
    println!("Shutting down mobubu-wallet...");
    Ok(())
}
