# Archived Groth16 vaults (v2 / v3)

**Do not deploy or fund these contracts.** The default native ETH deposit and withdrawal path is now [`PostQuantumVault`](../../PROTOCOL_DESIGN.md), using SLH-DSA for both operations. This directory preserves v2/v3 source, wire formats and local tests for historical comparison only. The root contract build, SDK exports, npm dependencies and CI do not use this archive. Source relocation does not upgrade existing on-chain deployments or move their balances; old Groth16 notes are not PQ accounts.

- [Fixed-value v2 design](PROTOCOL_V2.md) and [historical Rust verifier](../../mobubu-wallet-rust/README.md)
- [Variable-value v3 and mock ten-network notes](../../docs/NOTE-GIA-TRI.md); mock payouts do not settle any asset

To reproduce the old checks, run from the repository root. This archive reuses the root compiler, EDR, ethers and price fixtures, and isolates Circom/snarkjs/Poseidon in its own lockfile.

```sh
npm ci
npm --prefix legacy/groth16 ci
npm --prefix legacy/groth16 test
# Optional Rust parity (Cargo + Rust 1.88, or MOBUBU_RUST_VERIFY_BIN):
npm --prefix legacy/groth16 run test:rust
```

First execution generates disposable constants and proving artifacts under `legacy/groth16/build/zk/local-only/`. They are for the in-process EVM and mock ledger only. A checksum is not a trusted ceremony, and a passing proof is not evidence of live custody or migration.
