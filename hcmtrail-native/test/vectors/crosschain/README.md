# Public ETH/HYPE devnet fixtures

`swap` and `local` are real pinned NotBefore STARK proofs of the **same funded ETH note** in `crosschain.test.mjs`. The swap statement uses the full order hash in its two encoded address slots. The local statement pays a local address; its live nullifier is identical. Only one can be spent on a given VM state. The test branches from snapshots to exercise pay, cancel+refund, and a local exit separately.

The metadata is public and hashes the accompanying `.bin`; no note opening, witness, wallet state, signed transaction or witness signer credentials are included. Fixture openings, keys, IDs and contract addresses are deterministic and **must never be used with real funds or public networks**.

From the standalone package, `npm run test:crosschain` replays both proofs on a fresh setup. To regenerate for a deliberate change to the domain, fixture note or order, use the pinned prover from [the testnet runbook](../../../docs/TESTNET.md), run `NATIVE_CROSSCHAIN_VECTORS_DIR="$(mktemp -d)" npm run test:crosschain:fresh`, and copy only the verified `.bin`/`.json` pairs into this directory. Rerun the pinned tests after copying. The randomness, timing, hashes and byte lengths can differ between proof generations. No public RPC or actual bridge deployment is needed.
