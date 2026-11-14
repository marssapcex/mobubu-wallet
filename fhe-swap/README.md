# fhe-swap v2 — NYX hub, streaming swaps, sealed orderflow

Reference TypeScript codebase for a **native cross-chain hub swap** supporting exactly:

```text
BTC, ETH, XMR, ZEC, DAI
```

Nothing else is externally routable: no RUNE, no synths, no extra ERC-20s, no wrapped substitutes. DAI is the only ERC-20, on Ethereum.

`NYX` is the project-native internal hub/settlement/fee asset. Every external swap routes:

```text
A -> NYX -> B
```

Example:

```text
BTC -> NYX -> ETH
XMR -> NYX -> ZEC
DAI -> NYX -> BTC
```

> **Status: research/reference prototype, not production.**
> Chain adapters and threshold signers are mocks/scaffolds. The v2 private orderflow layer is threshold sealed orderflow, not audited threshold FHE. The v1 BFV path is leveled HE, not bootstrapped TFHE/fhEVM.

---

## What v2 adds

1. **NYX hub routing** (`src/core/hub.ts`, `src/core/token.ts`)
   - One `A/NYX` pool per external asset.
   - All 20 ordered pairs route through NYX.
   - Fees collected in NYX and split into burn / bond rewards / protocol-owned liquidity.

2. **Streaming swaps** (`src/core/streaming.ts`)
   - One inbound deposit, many internal sub-swaps.
   - Exact split: chunks differ by at most 1 thor unit.
   - Proportional per-sub-swap `minOut`.
   - If a later sub-swap fails its limit: send accumulated output, refund unexecuted input.
   - No rollback of executed sub-swaps or arb trades.

3. **Arbitrage rebalancing** (`src/core/arb.ts`, `src/core/price-feed.ts`)
   - Permissionless arb-bot interface.
   - CEX reference-price feed interface.
   - Demo uses a static Binance-mid-style feed.
   - Arb rebalances pools between streaming sub-swaps.

4. **Sealed private orderflow** (`src/privacy/threshold.ts`, `src/core/orderflow.ts`)
   - AES-GCM sealed order.
   - Shamir threshold opening of the AES key.
   - Public relayer sees only sealed blob, not pair/amount/destination/refund/schedule.
   - Epoch-delayed opening.

5. **Deposit unlinkability references** (`src/chains/vault.ts`)
   - Random L1 deposit tag, not derived from order id or plaintext fields.
   - One-time vault deposit book with reuse rejection.
   - Production still needs chain-valid one-time address derivation.

6. **Threshold signer boundary** (`src/tss/*`)
   - BTC: FROST secp256k1 Schnorr/taproot-style boundary.
   - ETH/DAI: threshold ECDSA secp256k1 boundary. Ethereum does not verify FROST Schnorr natively.
   - XMR: FROSTLASS / threshold CLSAG boundary.
   - ZEC: experimental threshold spend-auth boundary.
   - Mock cluster only; not audited FROST/FROSTLASS/ECDSA-TSS.

7. **v1 BFV encrypted-intent path remains** (`src/fhe/*`, `src/core/engine.ts`)
   - SEAL BFV encrypted amount/minOut quote.
   - Useful as the FHE reference path, but not the v2 streaming orderflow backend.

---

## Quick start

Requires Node.js ≥ 20. Tested with Node v22.22.3.

```bash
cd fhe-swap
npm ci
npm test
npm run demo
```

Expected demo shape:

```text
NYX hub streaming demo — native BTC/ETH/XMR/ZEC/DAI, no wrapped assets
Route: BTC -> NYX -> ETH, sealed orderflow, threshold opening, arb between subswaps
sealed order id: ...
public orderflow size: 1
public view before opening: { orderId: ..., state: 'sealed' }
L1 deposit tag (not order id): ...
one-time BTC vault address: ...
state: completed
subswaps: 5
one-shot netOutThor: 19360351088
streamed netOutThor: 19821309995
total fee NYX thor: ...
treasury: { collectedNyxThor: ..., burnedNyxThor: ..., bondRewardsNyxThor: ..., polNyxThor: ... }
arb rebalances: 10
outbound: ETH 198.21309995
outbound tx: ...
```

Current test suite:

```text
# tests 61
# pass 61
# fail 0
```

Run the older BFV demo:

```bash
npm run demo:bfv
```

Fetch reference upstreams:

```bash
npm run fetch:upstreams
# or:
npm run fetch:upstreams -- /path/to/upstreams
```

---

## Core equations

### Hub pool output

Reference constant-product output:

```text
y = floor(xY / (x + X))
```

This is THORChain CLP derivation **Eqn 2**, not the slip-fee CLP output **Eqn 6**.

### Two-leg route

```text
h = A -> NYX output
fee_NYX = floor(h * feeBps / 10000)
out = NYX -> B output using h - fee_NYX
```

### Streaming split

```text
base = floor(A / n)
rem  = A mod n
chunk_i = base + 1 if i < rem else base
sum(chunk_i) = A
```

### Proportional sub-swap limit

```text
chunkMinOut_i = ceil(minOut * chunk_i / A)
sum(chunkMinOut_i) >= minOut
```

### Shamir threshold opening

```text
s = sum_{i in T} y_i * lambda_i(0) mod p
lambda_i(0) = product_{j in T, j != i} x_j / (x_j - x_i) mod p
```

Full architecture, citations, and privacy limits: [`docs/ARCHITECTURE-V2.md`](docs/ARCHITECTURE-V2.md).

---

## Privacy model

### Hidden from public orderflow

- asset pair;
- amount;
- minOut;
- destination;
- refund address;
- streaming schedule;
- deadline.

### Still visible or linkable

- L1 inbound transaction existence, amount, timing, address metadata;
- L1 outbound transaction existence, amount, timing, destination;
- transparent BTC/ETH/DAI legs;
- traffic metadata;
- plaintext after threshold committee opening.

This is stronger than a public THORChain-style memo for orderflow privacy, but it is **not** full cross-chain anonymity. XMR/ZEC legs can be shielded only if real adapters/wallets use shielded addresses correctly.

---

## FHE / threshold cryptography honesty

- v1 backend: `node-seal 7.0.0 -> Microsoft SEAL 4.1.2 -> BFV`.
- BFV here is exact integer **leveled HE**, not TFHE bootstrapped FHE.
- v2 sealed orderflow: AES-GCM + Shamir threshold opening. It is not threshold FHE.
- Production needs threshold DKG, private share channels, verifiable shares, anti-censorship inclusion, and possibly threshold FHE/TFHE encrypted intent processing.
- Mock TSS approvals are ed25519 authorizations, not FROST/FROSTLASS partial signatures.

---

## Upstream source links

See [`docs/UPSTREAMS.md`](docs/UPSTREAMS.md).

### Serai

```text
https://github.com/serai-dex/serai
```

Inspected commit:

```text
4b89cf0206184886e96d0663861596312e5b47d2
```

Mixed license per crate: MIT / AGPL-3.0-only. Inspected tree has Bitcoin/Ethereum/DAI processor paths; Monero library moved to monero-oxide.

### monero-oxide / FROSTLASS

```text
https://github.com/monero-oxide/monero-oxide
```

Inspected commit:

```text
a6b46701fb9b331006d7f2f2278bf51f123b1447
```

Relevant paths:

```text
audits/FROSTLASS/FROSTLASS.pdf
audits/FROSTLASS/README.md
monero-oxide/ringct/clsag/src/multisig.rs
monero-oxide/wallet/src/send/multisig.rs
```

FROSTLASS paper:

```text
https://eprint.iacr.org/2026/589.pdf
```

### THORChain

Canonical:

```text
https://gitlab.com/thorchain/thornode
```

GitLab was unreachable from this sandbox. Fallbacks:

```text
https://github.com/thorchain/thornode      # deprecated README-only mirror
https://github.com/faddat/thornode         # third-party source fork, NOT canonical
```

Streaming swaps docs:

```text
https://dev.thorchain.org/swap-guide/streaming-swaps.html
```

CLP equations:

```text
https://docs.thorchain.org/technical-documentation/thorchain-finance/continuous-liquidity-pools
```

---

## Repository layout

```text
fhe-swap/
├── src/
│   ├── assets.ts                 # exact 5-asset allow-list
│   ├── cli.ts                    # v1 BFV XMR -> ZEC demo
│   ├── cli-streaming.ts          # v2 BTC -> NYX -> ETH streaming demo
│   ├── index.ts
│   ├── fhe/                      # SEAL BFV backend
│   ├── core/
│   │   ├── engine.ts             # v1 settlement engine
│   │   ├── hub.ts                # NYX pools + router
│   │   ├── token.ts              # NYX fee treasury
│   │   ├── streaming.ts          # streaming hub engine
│   │   ├── arb.ts                # arb bots
│   │   ├── price-feed.ts         # CEX reference feed interface
│   │   ├── orderflow.ts          # sealed orderflow store
│   │   ├── intent.ts             # v1 encrypted intent
│   │   ├── matcher.ts            # v1 encrypted quote
│   │   ├── pool.ts               # v1 bounded fixed-price pool
│   │   ├── privacy.ts            # shielded/mixed/transparent policy
│   │   ├── types.ts
│   │   └── units.ts
│   ├── privacy/
│   │   └── threshold.ts          # sealed order + Shamir opening
│   ├── tss/
│   │   ├── types.ts              # FROST/FROSTLASS/ECDSA suite mapping
│   │   └── mock.ts               # mock threshold approvals
│   └── chains/
│       ├── types.ts
│       ├── vault.ts              # one-time vault deposit book
│       ├── mock.ts
│       ├── rpc.ts
│       └── adapters.ts           # RPC scaffolds
├── test/                         # node:test suites
├── docs/
│   ├── ARCHITECTURE-V2.md
│   └── UPSTREAMS.md
├── scripts/fetch-upstreams.sh
├── LICENSE
└── NOTICE
```

---

## Production checklist

Do not use with real funds until all of the following are true:

- [ ] Real chain watchers/indexers and one-time vault address derivation.
- [ ] Audited FROST / FROSTLASS / threshold ECDSA signers.
- [ ] Committee DKG, private share channels, verifiable share submission.
- [ ] Anti-censorship private orderflow inclusion.
- [ ] Real CEX/DEX arb connectors and profit-aware arb solver.
- [ ] Outbound confirmations, reorg handling, fee estimation, dust/change rules.
- [ ] Real address validation, shielded address handling, network privacy.
- [ ] Persistent storage, idempotency, crash recovery, rate limits.
- [ ] Threshold FHE/TFHE or ZK backend if encrypted on-chain computation is required.
- [ ] Independent cryptographic and economic audit.

---

## License

MIT. See `LICENSE` and `NOTICE`.

Upstream projects keep their own licenses. Serai crates may be AGPL-3.0-only; monero-oxide/monero-clsag is MIT at the inspected commit. This reference implementation does not vendor upstream source into `src/`.
