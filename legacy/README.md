# Legacy implementations — not in the default build

[`groth16/`](groth16/README.md) archives the old v2/v3 vaults, circuits, SDK, mock note market and local tests. They are not fallback paths for [`PostQuantumVault`](../PROTOCOL_DESIGN.md). Do not deploy or fund the archived contracts.

The old EVM yield / RWA / authorization drafts (`evm/`), TypeScript client and
validator sketches (`ts/`), and a mock withdrawal sketch (`fhe-integration/`)
are retained here for reference only. Their original import
paths are historical. They are **not** supported packages or integration tests.
Do not deploy them, migrate notes to them, fund them, or treat the mock proofs,
votes, approval strings, or accounting as actual custody logic. An on-chain
code-hash registry is not an EIP-7702 authorization, and is not a privacy layer.

The original Rust node prototype is similarly kept under
[`mobubu-wallet-rust/legacy`](../mobubu-wallet-rust/legacy/README.md). The active
EVM vault and test fixtures are in [`contracts/`](../contracts/) and [`test/`](../test/).

The single-shot `SwapEngine`, RPC adapter scaffolds and placeholder one-time
address book were removed from `fhe-swap`, not moved into the buildable legacy
tree. Their original sketches remain in [Git history at the branch base](https://github.com/marssapcex/mobubu-wallet/tree/816d233bc48156b187a59268d0af45c56c2c8fcc/fhe-swap/src).
The supported local replacements are the [BFV quote demo and mock streaming
simulation](../fhe-swap/README.md); neither builds a real chain transaction.
