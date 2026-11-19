# Public native vault vectors

These proof packages were generated for the notes **actually deposited** by `vault-fixture.mjs` in a fresh isolated EVM/TVM. They are not the upstream demo proofs. Each `public.json` records the exact caller-independent withdrawal, deposit leaves and chain, plus a SHA-256 checksum of the binary NOXP format 7 package.

These fixtures contain no real funds or private secrets. The test note keys and blindings are intentionally public and **must never be used for real deposits**. Re-run the prover with fresh entropy using [`docs/VAULTS.md`](../../docs/VAULTS.md) if the deployment addresses, statement or deposit plan change; you cannot fix a proof by editing its metadata.
