# Public STARK staking fixtures · `stake-stark-v1`

These are genuine NotBefore format-7 proofs accepted by the pinned `HcmtStakeGate` in the test treasury. Each `.bin` is the on-chain proof; the matching `.json` is **only** public domain, action and permit metadata (including the SHA-256 proof ID). The test attaches the proof bytes to that metadata before exercising the same operator paths as the CLI. No opening, private credential, generated witness, signed transaction or RPC credentials belong here.

- `ETH/unlock-a`, `TRX/unlock-a`: authorize release of 20 HCMT from the 100-HCMT test position at the following period, to the proof-selected account.
- `ETH/claim-a`, `TRX/claim-a`: authorize periods 2 and 3 of historical native rewards to the test payout contract. Rejecting then accepting the payment tests atomic rollback and retry.
- `ETH/claim-b`: the second staker finishes period 2 and recycles its rounding remainder without modifying the historical periods.

**Do not reuse the deterministic test credentials or fixture addresses in a deployment.** The proofs are bound to the treasury address, chain, staker, action and nonce in `staking.test.mjs`; a VM transaction hash is not a public receipt. Keep `.bin` and `.json` paired.

Run from the standalone package on Linux x86-64, Node 22+. Set `TRON_SOLC` to the pinned TRON compiler per [the testnet runbook](../../../docs/TESTNET.md), then `npm run test:stake`. Verify using a clean checkout as well. To regenerate after an intentional change to treasury/proof statements or fixture addresses:

```bash
# NATIVE_STARK_PROVER_DIR points to the pinned local prover install.
VECTORS=$(mktemp -d)
NATIVE_STAKE_VECTORS_DIR="$VECTORS" npm run test:stake:fresh
# Only copy the verified .bin/.json pairs from the new temp directory.
# Re-run npm run test:stake with the replacement fixtures.
```

Fresh generation uses `/dev/urandom`; identical public inputs do not imply identical proof bytes. Run serially: each proof takes minutes and substantial RAM. No public RPC, signer file or external gas balance is used.
