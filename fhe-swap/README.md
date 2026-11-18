# fhe-swap — local FHE experiments and mock NYX streaming

**Do not use real funds.** This package provides the TFHE engine used by [native BTC/ETH/BNB settlement](../docs/NATIVE-SWAP.md). The BFV demo and NYX streaming engine below remain independent research tools; the streaming mock does not drive that settlement. These are three separate paths:

| Path | What it does | What it does not do |
| --- | --- | --- |
| CGGI (`src/fhe/tfhe.ts`, `src/fhe/coprocessor.ts`) | A source-built worker evaluates `encryptedBalance >= publicAmount`; a separate client can decrypt the resulting bit | Prove a deposit, verify a balance, attest to a vote, or authorize a payment |
| BFV (`src/fhe/seal.ts`, `src/core/{intent,matcher,pool}.ts`) | Microsoft SEAL via `node-seal` evaluates a bounded fixed-price quote; the client checks the arithmetic of the reported terms | Authenticate a price/intent, reserve liquidity, or sign or settle trades |
| Streaming (`src/core/streaming.ts`, `src/chains/mock.ts`) | In-memory `A → NYX → B` routes, sealed orderflow, per-chunk price limits, and mock payout/refund | Use FHE for settlement, custody, or recover safely from a crash or deep reorg |

## Run locally

Use Node.js ≥22.13. The CGGI worker build currently requires Linux x86-64 and `g++`, `gcc`, `curl`, `tar`, `patch`, `sha256sum`. It fetches a pinned libtfhe archive, checks its SHA-256, applies the Linux `getrandom` patch, and smoke-tests the binary before publishing it to the ignored `native/bin/` directory. `TFHE_FFT=auto` uses SPQLIOS-FMA on AVX2/FMA CPUs and otherwise Nayuki portable.

```bash
cd fhe-swap
npm ci
npm test                # native build + BFV, CGGI and streaming tests
npm run demo:bfv        # BNB → BTC quote arithmetic only, no deposit or signer
npm run demo            # BTC → NYX → ETH using mock chains
npm run bench:tfhe      # hot comparator samples; run after the native build

# Focused fallback check (build TypeScript first, e.g. via npm test):
TFHE_FFT=nayuki-portable npm run build:native
node --test dist/test/tfhe-balance.test.js
```

A build clears the previous `dist/` before compiling, so files removed from `src/` cannot still be loaded from stale build output. The two local npm lockfiles are covered by `npm run audit:deps` at the repository root. For results and limitations see the [source review](../docs/RA-SOAT-MA-NGUON.md).

## Local crypto boundaries

- **CGGI:** The evaluator loads one trusted cloud key and has no encrypt/decrypt API. Client and evaluator check ciphertext width, encoding, and cloud-key `keyId` before sending gates. The ID is a SHA-256 fingerprint for accidental mix-ups, not authentication. IPC is local and bounded; raw commands bypass the TypeScript key-context check. The upstream parameter preset and native key parser have not been independently audited here. Regenerate keys made by the old worker before the OS randomness change. Do not import keys or ciphertexts from strangers or expose the worker over RPC.
- **BFV:** Arithmetic is modular and leveled, not a bootstrapped TFHE or fhEVM backend. Range checks in the quote demo bound products for the declared input limit; the client decrypts and checks the result and `minOut`. This is not a proof of the encrypted amount, not a guarantee that quoted terms are fair, and not a parser for untrusted WASM input.
- **Sealed orders:** The demo dealer splits a secret with Shamir and uses the derived key for AES-GCM. The version and committee ID are authenticated as associated data. `threshold-aes-gcm-v2` accepts bounded canonical envelopes and is not wire-compatible with v1. The in-process opener drops share references after use. This does not establish participant identity, verifiable shares, secure deletion, DKG, threshold FHE, or anonymity on a real chain.

## Streaming simulation

This independent streaming/BFV experiment uses the [three default native assets](src/asset-catalog.mjs): BTC on Bitcoin, ETH on Ethereum and BNB on BNB Smart Chain (`bsc`). The [ten-network note market and oracle](../docs/SWAP-10-MANG.md) do not run inside this engine. Wrapped assets are rejected. Ethereum and BSC have separate mock adapters and vaults. Mock streaming tests settle all six directed routes; the CLI streaming demo is a BTC→ETH example. NYX is an internal accounting unit, not a token deployed by this package. Each simulated route uses two XYK pools, a fee on the intermediate NYX amount, and a proportional `minOut` per chunk. The optional arb bot uses a simulated reference price, not a live connector. See the [equations and state transitions](docs/ARCHITECTURE-V2.md).

A random mock `depositTag` matches the inbound independently of the `orderId`. It is **not a real address**. After the engine credits an observation it pins the source tx and amount; it pauses if the watcher reports missing, changed or shallow funding. The engine retains each signed mock payout/refund and retries the same bytes and ID. It rechecks funding before new work and records completion only after observing inbound and all required outbound depths. `needs_review` means manual reconciliation, not refunded. These observations are not an atomic chain finality proof, and the RAM-only engine has no journal, nonce/UTXO reservations, or restart recovery.

The mock TSS cluster uses Ed25519 approvals of mock payloads. It is not FROST, threshold ECDSA, a real custody service, or protection from an operator with access to process memory.

## References

- [Architecture and production gaps](docs/ARCHITECTURE-V2.md)
- [Inspected upstreams: Serai and THORChain](docs/UPSTREAMS.md) (`npm run fetch:upstreams` is optional)
- [Historical benchmark and ZK/FHE research](../docs/NGHIEN-CUU-ZK-FHE.md)
- [Legacy and removed prototypes](../legacy/README.md)

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream code retains its own licenses.
