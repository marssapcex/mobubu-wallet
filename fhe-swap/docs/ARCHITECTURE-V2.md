# fhe-swap v2 architecture — NYX hub, streaming swaps, sealed orderflow

Status: **research/reference prototype**. This document describes the mechanism
implemented in `src/` and the production gaps that remain. It is not an audit,
not a mainnet deployment, and not a claim of production privacy.

External routable assets remain exactly:

```text
BTC, ETH, XMR, ZEC, DAI
```

`NYX` is the project-native hub/settlement/security/fee asset. It is internal to
the protocol. Users do not deposit/withdraw NYX as a sixth external swap asset in
this reference implementation.

---

## 1. One mechanism

**NYX-hub native settlement with sealed streaming orderflow.**

Every external swap is routed through NYX:

```text
A -> NYX -> B
```

For example:

```text
BTC -> NYX -> ETH
XMR -> NYX -> ZEC
DAI -> NYX -> BTC
```

There are no wrapped BTC/ETH/XMR/ZEC/DAI IOUs. The vaults hold native assets on
their native chains. NYX is used for hub liquidity, fees, node bonding rewards,
and protocol-owned liquidity accounting.

The differentiator is not “another CLP fork”. It is the combination of:

1. hub-token routing for all five native assets;
2. streaming sub-swaps with arbitrage rebalancing between sub-swaps;
3. sealed/private orderflow opened only by a threshold committee;
4. random L1 deposit tags and one-time vault deposit references;
5. epoch-delayed opening and optional outbound delay;
6. FROST/FROSTLASS/ECDSA-TSS signer boundaries instead of a single hot key.

---

## 2. Settlement flow

```text
client
  │ seal plaintext order with AES-GCM
  │ split AES key into Shamir shares
  ▼
private orderflow / relayer
  │ sees only sealed blob + order id
  ▼
vault committee
  │ collect >= t shares
  │ epoch-batched threshold opening
  ▼
NYX hub engine
  │ observe inbound by random deposit tag
  │ confirm native inbound
  │ split order into sub-swaps
  │ route A -> NYX -> B
  │ arb bots rebalance between sub-swaps
  ▼
threshold signer
  │ FROST / FROSTLASS / ECDSA-TSS boundary
  ▼
native outbound broadcast or refund / partial refund
```

The public orderflow layer does not see:

- asset pair;
- amount;
- minOut;
- destination;
- refund address;
- streaming schedule;
- deadline.

Those fields are inside the sealed order. The committee opens them only after
enough shares are available and the epoch boundary is reached.

---

## 3. Hub pools and routing

Implemented in:

```text
src/core/hub.ts
src/core/token.ts
```

Each external asset has an `A/NYX` pool. The reference pool uses constant-product
output, not THORChain’s slip-fee CLP formula.

### Proposition H1 — constant-product output

For input `x`, input reserve `X`, output reserve `Y`:

```text
y = floor(xY / (x + X))
```

This is the base XYK output equation in THORChain’s CLP derivation,
**Eqn 2** in “Continuous Liquidity Pools”:

```text
https://docs.thorchain.org/technical-documentation/thorchain-finance/continuous-liquidity-pools
```

The reference implementation deliberately does **not** implement THORChain’s
slip-fee output:

```text
y = xYX / (x + X)^2
```

which is **Eqn 6** in the same document. That is a production extension, not a
hidden claim about this codebase.

### Proposition H2 — two-leg hub route

For external assets `A` and `B`, input amount `a`, protocol fee `f` in bps:

```text
h = floor(Y_NYX,A * a / (X_A + a))
fee_NYX = floor(h * f / 10000)
h_net = h - fee_NYX
out_B = floor(X_B * h_net / (Y_NYX,B + h_net))
```

Implemented by `HubRouter.quote` and `HubRouter.execute`. Tested in
`test/hub.test.ts` and `test/streaming.test.ts`.

The fee is collected in NYX from the intermediate hub leg.

### Proposition H3 — NYX fee split

For collected NYX fee `F`:

```text
burn = floor(F * burnBps / 10000)
bond = floor(F * bondRewardsBps / 10000)
pol  = F - burn - bond

burnBps + bondRewardsBps + polBps = 10000
```

Implemented by `TokenTreasury.collectFeeNyx`. Default split:

```text
burn: 5000 bps
bond: 4000 bps
pol:  1000 bps
```

This is reference accounting, not an on-chain token contract.

---

## 4. Streaming swaps

Implemented in:

```text
src/core/streaming.ts
```

THORChain’s streaming-swap documentation describes the two control variables:

- **interval**: time between sub-swaps, giving arbitrageurs time to rebalance;
- **quantity**: number of sub-swaps, reducing per-sub-swap size.

Source:

```text
https://dev.thorchain.org/swap-guide/streaming-swaps.html
```

### Proposition S1 — exact streaming split

For total amount `A` and quantity `n`:

```text
base = floor(A / n)
rem  = A mod n

chunk_i = base + 1 if i < rem else base

sum(chunk_i for i in [0, n)) = A
max(chunk_i) - min(chunk_i) <= 1
```

Implemented by `StreamingHubEngine.start`.

### Proposition S2 — proportional sub-swap price limit

For total minimum output `M`:

```text
chunkMinOut_i = ceil(M * chunk_i / A)

sum(chunkMinOut_i) >= M
```

Each sub-swap must meet its proportional limit. If a later sub-swap fails, the
engine does **not** roll back already executed sub-swaps or arbitrage trades.
Instead it:

1. stops the stream;
2. sends accumulated destination output;
3. refunds unexecuted source input;
4. collects NYX fees only for executed sub-swaps.

This follows the streaming-swap settlement model described in THORChain’s dev
docs: successfully swapped value is sent, remaining source asset is refunded.

### Proposition S3 — streaming can beat one-shot execution

With arbitrage rebalancing between sub-swaps, later sub-swaps can execute closer
to the external reference price than a single large swap.

The test suite checks:

```text
streamedNetOut > oneShotNetOut
```

for a large BTC -> NYX -> ETH order under the reference pool/arb configuration.
See `test/streaming.test.ts`.

This is a property of the simulated market structure, not a guarantee for all
pool depths, volatility paths, or arb latency.

---

## 5. Arbitrage rebalancing

Implemented in:

```text
src/core/arb.ts
src/core/price-feed.ts
src/core/hub.ts
```

The protocol does not use a CEX price to clear swaps. Pool clearing is reserve
based. The CEX feed is used only by permissionless arb bots.

### Proposition A1 — perfect-arb target

For pool reserves `X_A`, `Y_NYX`, invariant `k = X_A * Y_NYX`, and external
reference price `p_ref` scaled by `S = PRICE_SCALE`:

```text
target_Y / target_X = p_ref / S

target_X = floor(sqrt(k * S / p_ref))
target_Y = floor(k / target_X)
```

The reference bot rebalances the pool toward this target when the spot price is
outside a tolerance band.

`ReferencePriceArbBot` uses the pool’s configured reference price.
`CexPriceArbBot` uses an external `CexPriceFeed`, for example a static Binance-mid
feed in the demo.

Production gap: this is a simulated local rebalance, not a real CEX connector,
not a real profit-maximizing arb solver, and not a permissionless on-chain arb
transaction format.

---

## 6. Sealed private orderflow

Implemented in:

```text
src/privacy/threshold.ts
src/core/orderflow.ts
```

The reference uses:

```text
AES-256-GCM sealed order
Shamir secret sharing of the AES key over a 256-bit prime field
threshold opening with >= t shares
```

### Proposition P1 — Shamir threshold reconstruction

For shares `(x_i, y_i)` and threshold `t`, any set `T` of `t` shares reconstructs:

```text
s = sum_{i in T} y_i * lambda_i(0) mod p

lambda_i(0) = product_{j in T, j != i} x_j / (x_j - x_i) mod p
```

This is the standard Shamir secret-sharing reconstruction used as background in
FROST, Section 2.1 “Shamir Secret Sharing”:

```text
https://cypherpunks.ca/~iang/pubs/frost-sac20.pdf
```

The AES-GCM tag authenticates the sealed order. Tampered ciphertext fails opening.

### What this hides

From the public relayer/orderflow layer:

- pair;
- amount;
- minOut;
- destination;
- refund address;
- streaming interval/quantity;
- deadline.

### What this does not hide

- L1 inbound transaction existence, amount, timing, and address metadata;
- L1 outbound transaction existence, amount, timing, and destination;
- traffic analysis against the relayer or vault committee;
- plaintext once the threshold committee opens the order;
- chain-analysis links on transparent legs such as BTC/ETH/DAI.

This is stronger than a public THORChain-style memo for orderflow privacy, but it
is **not** full L1 anonymity.

Production gap: the reference dealer flow returns shares to the client for local
testing. Production needs committee DKG, private share channels, verifiable share
submission, anti-censorship inclusion, and threshold decryption/opening policy.

---

## 7. Epoch batching and deposit unlinkability

Implemented in:

```text
src/core/streaming.ts
src/chains/vault.ts
```

### Proposition E1 — epoch opening boundary

For epoch length `E` and submission time `t`:

```text
openableAt = floor(t / E) * E + E
```

If `E = 0`, opening is immediate. The engine refuses to open before `openableAt`.

### Proposition D1 — random deposit tag

The L1 deposit reference is:

```text
depositTag = random 128-bit value
```

It is not derived from:

```text
orderId
destination
refundAddress
amount
pair
```

The vault keeps the private mapping:

```text
depositTag -> orderId
```

`OneTimeVaultBook` allocates fresh one-time vault deposit references and rejects
reuse after marking used.

Production gap: the reference address format is not a real Bitcoin/Ethereum/
Monero/Zcash address derivation. Production must derive chain-valid one-time
addresses from threshold vault public keys, handle dust/change/fees, and never
reuse deposit addresses.

---

## 8. Threshold signing boundary

Implemented in:

```text
src/tss/types.ts
src/tss/mock.ts
```

Suite mapping:

```text
BTC -> frost-secp256k1       (Schnorr/taproot-style reference boundary)
ETH -> ecdsa-secp256k1       (Ethereum needs ECDSA, not FROST Schnorr)
DAI -> ecdsa-secp256k1
XMR -> frostlass-clsag       (threshold CLSAG)
ZEC -> frost-ed25519-experimental
```

Important correction: FROST produces Schnorr signatures. Ethereum does not
natively verify Schnorr secp256k1 signatures, so ETH/DAI require threshold ECDSA,
not FROST.

### FROST

FROST is a threshold Schnorr signature protocol. The FROST paper states security
against chosen-message attacks assuming discrete logarithm hardness and an
adversary controlling fewer than the threshold number of participants.

Source:

```text
https://cypherpunks.ca/~iang/pubs/frost-sac20.pdf
```

### FROSTLASS / Monero

FROSTLASS thresholdizes Monero CLSAG. The Cypher Stack formalization is:

```text
https://eprint.iacr.org/2026/589.pdf
```

Relevant verified definition:

```text
Definition 2 (κ-OMDL): one-more-than-κ discrete logarithm assumption.
```

The paper’s abstract states FROSTLASS is strongly unforgeable up to the
κ-one-more discrete logarithm problem and statistically linkable.

The Rust implementation is in monero-oxide:

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

`monero-oxide/ringct/clsag/src/multisig.rs` contains the FROST-inspired CLSAG
multisig implementation. The crate license is MIT.

Serai’s Monero library was transferred to monero-oxide:

```text
https://serai.exchange/2025/09/09/monero-serai-oxide.html
```

Production gap: `MockTssCluster` uses ed25519 member approvals and emits a mock
transaction. It is **not** FROST, FROSTLASS, or ECDSA-TSS. Real vault signing must
use audited implementations and chain-specific transaction builders.

---

## 9. FHE status

The v1 BFV encrypted-intent path remains:

```text
src/fhe/seal.ts
src/core/intent.ts
src/core/matcher.ts
src/core/engine.ts
```

It uses:

```text
node-seal 7.0.0 -> Microsoft SEAL 4.1.2 -> BFV leveled HE
```

It is not bootstrapped TFHE/fhEVM.

The v2 streaming path uses threshold sealed orderflow, not BFV, for private
orderflow. A production version can replace or augment the sealed-order layer
with threshold FHE / TFHE encrypted intent processing, but that is not implemented
here.

---

## 10. Privacy comparison with THORChain-style public memos

| Layer | THORChain-style public memo | This reference |
|---|---|---|
| Order pair | public memo | sealed until threshold opening |
| Amount | public L1 amount | sealed order amount; L1 amount still visible |
| Destination | public memo | sealed until opening; outbound L1 still visible |
| Refund address | public memo/origin | sealed until opening |
| Streaming params | public memo | sealed until opening |
| Deposit reference | memo/order link | random deposit tag + one-time vault reference |
| Opening | public | epoch-delayed threshold opening |
| Outbound timing | immediate/queue | optional outbound delay |
| Transparent L1 legs | visible | still visible |
| Shielded L1 legs | depends on asset | XMR/ZEC can be shielded if adapters/wallets do it correctly |

This is a meaningful orderflow-privacy improvement, not a proof of full
cross-chain anonymity.

---

## 11. What is implemented vs mocked

Implemented and tested:

- exact five-asset allow-list;
- NYX hub pools and two-leg routing;
- NYX fee treasury split;
- streaming split and proportional sub-swap limits;
- partial settlement and refund semantics;
- arb rebalancing simulation;
- CEX price-feed interface and static feed;
- sealed orderflow with Shamir threshold opening;
- epoch-delayed opening;
- random deposit tags;
- one-time vault deposit book;
- TSS suite mapping and mock threshold approvals;
- v1 BFV encrypted quote path.

Mocked / reference only:

- chain adapters for real networks;
- real one-time vault address derivation;
- real FROST/FROSTLASS/ECDSA-TSS signing;
- real CEX connectors;
- real profit-maximizing arb bots;
- threshold DKG and private share channels;
- outbound confirmation/reorg handling;
- fee estimation, dust, change, address validation;
- production FHE/TFHE backend;
- network-level privacy.

---

## 12. Test evidence

Run:

```bash
cd fhe-swap
npm ci
npm test
npm run demo
```

Current suite:

```text
# tests 61
# pass 61
# fail 0
```

Demo shape:

```text
NYX hub streaming demo — native BTC/ETH/XMR/ZEC/DAI, no wrapped assets
Route: BTC -> NYX -> ETH, sealed orderflow, threshold opening, arb between subswaps
state: completed
subswaps: 5
one-shot netOutThor: 19360351088
streamed netOutThor: 19821309995
arb rebalances: 10
outbound: ETH 198.21309995
```

The exact order id, deposit tag, and tx hash vary because they are randomized.
