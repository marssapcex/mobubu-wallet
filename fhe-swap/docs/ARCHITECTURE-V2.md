# fhe-swap v2 architecture — NYX hub, streaming swaps, sealed orderflow

Status: **in-memory research simulation**. No live adapters, vault addresses,
or chain signatures are provided. This describes the model implemented in `src/`,
not a deployment, custody service, or claim of production privacy.

External routable assets are native coins on their own networks:

```text
BTC — Bitcoin
ETH — Ethereum
BNB — BNB Smart Chain (bsc in the simulator)
```

`NYX` is the internal hub and fee accounting unit in the model. No NYX token is
deployed or offered for deposit/withdrawal.

---

## 1. One mechanism

**Simulated NYX-hub settlement with sealed streaming orderflow.**

Every external swap is routed through NYX:

```text
A -> NYX -> B
```

For example:

```text
BTC -> NYX -> ETH
ETH -> NYX -> BNB
BNB -> NYX -> BTC
```

All six directed routes use the [shared native-asset catalog](../src/asset-catalog.mjs).
The model routes balances without wrapped substitutes; mock vaults hold no real
assets. NYX accounts for hub liquidity and simulated fees.

The differentiator is not “another CLP fork”. It is the combination of:

1. hub routing in both directions for each of the three asset pairs;
2. streaming sub-swaps with arbitrage rebalancing between sub-swaps;
3. sealed/private orderflow opened only by a threshold committee;
4. random deposit tags for mock inbound matching;
5. epoch-delayed opening and optional outbound delay;
6. an injected signer boundary exercised by an in-process mock.

---

## 2. Settlement flow

```text
client (local dealer)
  │ seal plaintext with AES-GCM and split key material into Shamir shares
  ▼
in-memory orderflow: sealed blob and order id
  │ watcher matches a mock inbound by deposit tag, then pins its credit
  ▼
engine checks confirmed funding, epoch boundary and >= t shares
  │ opens plaintext inside the engine process
  │ splits the order and routes at most one due chunk per tick
  ▼
mock signer and mock chain adapter
  │ retain/retry each payout or refund with the same bytes and ID
  ▼
observe source and all required outbound depths before final accounting
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

target_X ≈ sqrt(k * S / p_ref)
target_Y ≈ sqrt(k * p_ref / S)
```

When outside the tolerance band, the bot uses the appropriate integer square
root to propose the input-side reserve, then caps the delta in the units of that
side. It executes the normal XYK swap with floor-rounded output, rather than
assigning independently rounded reserves. It skips zero or non-improving trades;
`k` cannot decrease due to rounding, but a bounded trade need not reach the band.

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
Shamir secret sharing of the secret from which the AES key is derived
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

The `threshold-aes-gcm-v2` envelope authenticates the version and committee ID
as AES-GCM associated data. Validation requires canonical Base64, a 12-byte IV,
a 16-byte tag and at most 4 KiB of ciphertext. Share indices must belong to the
configured committee, and values must be canonical elements of the prime field.
An accepted participant share cannot be overwritten by a conflicting retry.
The opener deletes its share references after attempted reconstruction/opening
and the engine discards pending shares in `needs_review`. This is not secure
memory erasure or authentication of the participants.

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
- ciphertext length and traffic analysis against a relayer or the operator;
- plaintext once the threshold committee opens the order;
- chain-analysis links on transparent legs such as BTC/ETH/BNB.

A sealed blob does not reveal the whole order as a public plaintext memo would.
This does **not** establish real-chain unlinkability or a network privacy claim.

Production gap: the reference dealer flow returns shares to the client for local
testing. Production needs committee DKG, private share channels, verifiable share
submission, anti-censorship inclusion, and threshold decryption/opening policy.

---

## 7. Epoch batching and mock inbound matching

Implemented in:

```text
src/core/streaming.ts
src/chains/mock.ts
```

### Proposition E1 — epoch opening boundary

For epoch length `E` and submission time `t`:

```text
openableAt = floor(t / E) * E + E
```

If `E = 0`, there is no epoch delay. The engine still requires confirmed funding
and sufficient shares, and refuses to open before `openableAt`.

### Proposition D1 — random deposit tag

The mock deposit reference is:

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

The in-process record links the tag to the order. This tag is not an address
or a mechanism for hiding deposits on a real chain. The placeholder one-time
address book was removed because scanning used only the tag. No chain-specific
address derivation, change tracking or payment validation is implemented.

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
ETH -> ecdsa-secp256k1       (Ethereum transactions)
BNB -> ecdsa-secp256k1       (BNB Smart Chain transactions)
```

FROST produces Schnorr signatures, not signatures for native EVM transactions.
ETH and BNB use the ECDSA signing interface, but remain on separate networks
with distinct policies, vaults, and transaction identities.

### FROST

FROST is a threshold Schnorr signature protocol. The FROST paper states security
against chosen-message attacks assuming discrete logarithm hardness and an
adversary controlling fewer than the threshold number of participants.

Source:

```text
https://cypherpunks.ca/~iang/pubs/frost-sac20.pdf
```

Production gap: `MockTssCluster` uses ed25519 member approvals and emits a mock
transaction. It is **not** FROST or ECDSA-TSS. Real vault signing must
use audited implementations and chain-specific transaction builders.

---

## 9. FHE status

Only the local BFV quote experiment remains of the single-shot path:

```text
src/fhe/seal.ts
src/core/intent.ts
src/core/matcher.ts
src/cli-bfv.ts
```

It uses:

```text
node-seal 7.0.0 -> Microsoft SEAL 4.1.2 -> BFV leveled HE
```

The isolated quote path checks intent/quote consistency and the arithmetic of
the reported terms; it does not authenticate prices or settle anything. It is
not bootstrapped TFHE/fhEVM. The separate source-built CGGI path evaluates
public thresholds on encrypted unsigned integers (`GE_CONST`). It has no
withdrawal authority and is not an orderflow backend. See [research notes](../../docs/NGHIEN-CUU-ZK-FHE.md).

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
| Deposit reference | memo/order link | random mock deposit tag (no chain address) |
| Opening | public | epoch-delayed threshold opening |
| Outbound timing | immediate/queue | optional outbound delay |
| Transparent L1 legs | visible | still visible |

The comparison is about which fields a sealed envelope contains, not a
measurement of cross-chain anonymity.

---

## 11. What is implemented vs mocked

Implemented and tested:

- exact three-asset allow-list, with mock settlement for all six directions;
- NYX hub pools and two-leg routing;
- NYX fee treasury split;
- streaming split and proportional sub-swap limits;
- partial settlement/refund with pinned credits, funding checks before new signatures/broadcasts, per-leg retry without resigning, and independent confirmation observations before completion;
- arb rebalancing simulation;
- CEX price-feed interface and static feed;
- sealed orderflow with Shamir threshold opening;
- epoch-delayed opening;
- random deposit tags;
- TSS suite mapping and mock threshold approvals;
- isolated BFV quote and CGGI public-threshold experiments.

Not implemented for real chains:

- real network RPC adapters, indexers and transaction builders;
- real one-time vault address derivation;
- real FROST/ECDSA-TSS signing;
- real CEX connectors;
- real profit-maximizing arb bots;
- threshold DKG and private share channels;
- durable outbox, restart recovery and chain-specific finality/reorg handling;
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

The full suite builds the CGGI worker from pinned source and exercises the
mock settlement fault cases, ciphertext arithmetic, and v2 streaming path.
A separate EVM/Rust integration suite is run from the repository root.

Demo shape:

```text
NYX hub streaming simulation — mock chains, no real funds
Route: BTC -> NYX -> ETH, sealed orderflow, threshold opening, arb between subswaps
state: completed
subswaps: 5
one-shot netOutThor: 19360351088
streamed netOutThor: 19821309995
arb rebalances: 10
outbound: ETH 198.21309995
```

The exact order id, deposit tag, and tx hash vary because they are randomized.
