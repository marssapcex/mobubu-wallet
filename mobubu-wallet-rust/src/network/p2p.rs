use crate::types::AppState;
use libp2p::{
    identity, swarm::SwarmEvent, Multiaddr, PeerId, SwarmBuilder,
    tcp::TokioTcpConfig, noise::NoiseConfig, yamux::YamuxConfig,
    std::tokio::io,
};
use std::sync::Arc;
use anyhow::Result;

/// Run libp2P P2P network for validator nodes.
pub async fn run_p2p(state: Arc<AppState>) -> Result<()> {
    let local_key = identity::Keypair::generate_ed25519();
    let local_peer_id = PeerId::from(local_key.public());
    println!("Local peer ID: {}", local_peer_id);

    let transport = TokioTcpConfig::new()
        .upgrade(libp2p::core::upgrade::Version::V1)
        .authenticate(NoiseConfig::xx(local_key).into_authenticated())
        .multiplex(YamuxConfig::default())
        .boxed();

    let mut swarm = SwarmBuilder::with_existing_identity(local_key)
        .with_tokio()
        .with_tcp(
            tcp::TokioTcpConfig::new(),
            libp2p::core::upgrade::Version::V1,
        )?
        .with_noise()?
        .with_yamux()?
        .boxed();

    // Listen on configured port
    let listen_addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{}", state.config.port)
        .parse()
        .expect("valid listen address");
    swarm.listen_on(listen_addr)?;

    println!("P2P network listening on port {}", state.config.port);

    // Main event loop
    loop {
        match swarm.select_next_some().await {
            SwarmEvent::NewListenAddr { address, .. } => {
                println!("Listening on {:?}", address);
            }
            SwarmEvent::IncomingConnection { peer_id, .. } => {
                println!("Incoming connection from {:?}", peer_id);
            }
            SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                println!("Connection established with {:?}", peer_id);
            }
            SwarmEvent::Behaviour(event) => {
                tracing::debug!(event = ?event, "P2P behaviour event");
            }
            _ => {}
        }
    }

    Ok(())
}
