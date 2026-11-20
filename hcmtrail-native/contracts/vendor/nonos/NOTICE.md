# NON-OS/L1-Shield (MIT)

The Solidity import closure and `chunk0.hex` through `chunk2.hex` are copied verbatim from [NON-OS/L1-Shield at `9d17ad969812ed953143e5d832816a3e20dc7834`](https://github.com/NON-OS/L1-Shield/tree/9d17ad969812ed953143e5d832816a3e20dc7834), `contracts/shield/` and `spec/not-before/`. See [LICENSE](LICENSE). The chunks are generated evaluator runtime code (not user proofs or keys); `NbStraightEvaluatorAt.sol` pins their hashes.

Only shape A of the NotBefore statement, the verifier dependencies and the note-tree hasher are used. The upstream pool, administrator, policies, routers and attestation adapter are **not** part of the executable vault. The corresponding prover and AIR sources are separately available under AGPL-3.0-or-later in [NON-OS/STARKs](https://github.com/NON-OS/STARKs/tree/a47d23ae969e23b5f841e30b49a1d483a80a6b02). Neither project has been independently audited here.
