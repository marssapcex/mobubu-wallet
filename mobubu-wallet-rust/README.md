# Archived Rust native Groth16 verifier

This binary is for the historical v2 format only. It is not the default build or a spending authority for [`PostQuantumVault`](../PROTOCOL_DESIGN.md).

`mobubu-wallet` verifies the four-input BN254 Groth16 statement of the fixed-value EVM vault v2,
using `substrate-bn` for canonical curve decoding, subgroup validation and
batched pairings. There is no Node subprocess, witness, client secret, network
node or custody in the Rust binary. The circuit and proof generation remain
Circom and snarkjs. `Cargo.lock` pins the crates.io releases. The [value note v3](../docs/NOTE-GIA-TRI.md) uses a different circuit and is not supported by this wire format.

```sh
rustup toolchain install 1.88.0 --profile minimal --component rustfmt
cargo +1.88.0 test --locked --manifest-path mobubu-wallet-rust/Cargo.toml
cargo +1.88.0 build --locked --release --manifest-path mobubu-wallet-rust/Cargo.toml
# At repo root, with Rust/Cargo on PATH:
npm ci
npm --prefix legacy/groth16 ci
npm --prefix legacy/groth16 run test:rust
```

The Node integration test produces a fresh proof, verifies it on a local EVM,
then checks the same statement in Rust. It also checks a different public
recipient and malformed file. `MOBUBU_RUST_VERIFY_BIN=/path/to/mobubu-wallet`
can select an existing executable. No fixture proves trusted setup integrity.

## Wire v2

[`zk-wire.mjs`](../legacy/groth16/packages/client/src/zk-wire.mjs) converts
snarkjs JSON (`protocol=groth16`, `curve=bn128`) and an independently derived
expected statement to fixed-width files. Use a verification key obtained from
**your trusted circuit/ceremony**, not from whoever submits a proof.

| File | Length | Order of 32-byte big-endian words |
| --- | ---: | --- |
| VK | 768 | `alpha` (G1), `beta`, `gamma`, `delta` (G2), then 5 G1 ICs |
| Proof | 256 | `A` (G1), `B` (G2), `C` (G1) |
| Expected statement | 128 | `root`, `nullifierHash`, `recipient` (160 bits), `domain` |

G1 consists of `(x, y)`; G2 consists of `(x.real, x.imag, y.real, y.imag)`.
This is **not** Solidity calldata (the EIP-197 precompile uses the opposite
order within each Fq2 coordinate). The reader rejects wrong sizes, field
aliases, invalid affine points and out-of-range recipient values. Check
`vk`, `proof`, and `statement` are the files intended for this vault version.

```sh
./mobubu-wallet-rust/target/release/mobubu-wallet verify trusted-vk.bin proof.bin expected.bin
```

Exit `0` = pairing equation true for those public inputs; `1` = invalid proof;
`2` = input/I/O errors. This does **not** decide whether a nullifier has been
spent or a root is current on-chain. No references to historical Rust mocks are
in the public crate.
