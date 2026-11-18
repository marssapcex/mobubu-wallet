# Shielded spend guest — development only

This is a RISC Zero guest **source** for a transparent STARK profile, not an EVM verifier, a proof fixture, or a deployed program ID. The native Rust/OpenSSL parity harness executes the same relation; it does not generate or validate a zero-knowledge proof. No Groth16/PLONK seal, fake receipt, or verifier that returns `true` is an acceptable replacement for the missing EVM STARK verifier.

The guest reads exactly two fixed-size segments via `env::read_slice`:

- **Public journal, 224 bytes**: Solidity `abi.encode(bytes32 poolDomain, bytes32 root, uint32 count, bytes32 nullifier, uint128 debit, bytes32 changeLeaf, bytes32 exitDigest)`. `exitDigest` is SHA-256 of the entire signed exit message. The vault derives this journal and pins the guest program, rather than accepting a caller-supplied public journal as authorization. The opaque digest binds the proof to the selected exit; it is not a price proof or foreign-chain finality proof.
- **Private witness, 724 bytes**: secret (32), note value (16, big-endian), index (4, big-endian), 20 siblings (640), change secret (32, all zero for full withdrawal). The side of each hash is derived from the index; `index < count` excludes padding. The relation rederives deposit key and leaf, checks the exact root, derives a stable nullifier from the original note, and checks integer `change = value − debit` with no modular wraparound. Only the 224-byte public journal is committed.

SHA-256 preimages use one tag byte followed by fixed-length fields: `1 || domain || secret`, `2 || domain || noteKey || value[16]`, `3 || domain || secret || leaf`, `4 || left || right`. The actual vault deposit sets the original value. A self-consistent witness under a root not recorded by that vault is not authorized. A copied proof cannot authorize a different payout or another vault; on-chain signature verification and nullifier state are still mandatory.

Before any release with funds, build the guest reproducibly with a pinned RISC Zero toolchain, verify a real transparent ZK-STARK receipt (not dev-mode), pin the executable image and the non-upgradeable verifier dependencies, add positive/negative on-chain proof and payout tests and measure gas against the target chains. Independently review the chosen proof parameters, witness masking, circuit/guest, metadata leaks, balances and cross-chain safety. This repo does not ship those deployment artifacts.

## Optional local proof experiment (not run in the workspace)

`prover/` embeds the RISC Zero 3.0.5 guest and its image ID at build time. It accepts a fixed binary statement through stdin and verifies a **composite STARK receipt** with dev mode disabled before writing it out. `verify` independently checks the embedded image ID, receipt and expected journal. It never calls a hosted prover, and the receipt bytes are not Solidity calldata. Treat these builds as experimental: the direct dependencies are versioned, but a deployment needs audited transitive lockfiles, reproducible toolchain and measured, verified parameters.

On a machine with Cargo, C/C++ build tools, the RISC Zero `rzup` toolchain manager and access to its upstream dependencies, install the matching guest compiler and run:

```sh
rzup install rust 1.88.0
cargo build --release --manifest-path proofs/shielded-spend/prover/Cargo.toml
POOL_STARK_TOOL=proofs/shielded-spend/prover/target/release/mobubu-shielded-spend-local node scripts/test-pool-proof.mjs
```

The smoke test uses generated dev notes, not user note files; it exercises one valid partial spend and rejects an altered opening or journal and malformed receipts. The sandbox could read the upstream source but not fetch the Linux release assets for the zkVM tooling. Do not treat native parity as the result of this optional proof test.
