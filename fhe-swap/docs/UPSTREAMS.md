# Upstream sources and clone notes

This project is inspired by THORChain and Serai, but does not copy their source
into `fhe-swap/src`.

## Serai

Canonical repository:

https://github.com/serai-dex/serai

Inspected commit:

```text
4b89cf0206184886e96d0663861596312e5b47d2
```

Pinned links:

- Root: https://github.com/serai-dex/serai/tree/4b89cf0206184886e96d0663861596312e5b47d2
- FROST: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/crypto/frost/src/lib.rs
- DLEq cross-group: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/crypto/dleq/src/cross_group/mod.rs
- Processor multisigs: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/processor/src/multisigs/mod.rs
- Monero processor: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/processor/src/networks/monero.rs
- Bitcoin RPC: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/networks/bitcoin/src/rpc.rs
- Ethereum ERC-20: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/networks/ethereum/src/erc20.rs
- DEX pallet: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/substrate/dex/pallet/src/lib.rs
- In-instructions pallet: https://github.com/serai-dex/serai/blob/4b89cf0206184886e96d0663861596312e5b47d2/substrate/in-instructions/pallet/src/lib.rs

License notes from the inspected tree:

- Root `LICENSE` says Serai crates are MIT or AGPL-3.0 depending on crate.
- `crypto/frost`: MIT.
- `crypto/dleq`: MIT.
- `networks/bitcoin`: MIT.
- `networks/ethereum`: AGPL-3.0-only.
- `processor`: AGPL-3.0-only.
- `substrate/dex/pallet`: AGPL-3.0-only, with an Apache2 license file present.
- `substrate/in-instructions/pallet`: AGPL-3.0-only.

Serai’s README lists Bitcoin, Ethereum, DAI, and Monero. It does not provide
Zcash support in the inspected tree.

Note: the Monero library originally developed as `monero-serai` was transferred
to the neutral `monero-oxide` organization. See:

https://serai.exchange/2025/09/09/monero-serai-oxide.html

## monero-oxide / FROSTLASS

Canonical repository:

https://github.com/monero-oxide/monero-oxide

Inspected commit:

```text
a6b46701fb9b331006d7f2f2278bf51f123b1447
```

Pinned links:

- Root: https://github.com/monero-oxide/monero-oxide/tree/a6b46701fb9b331006d7f2f2278bf51f123b1447
- FROSTLASS audit README: https://github.com/monero-oxide/monero-oxide/blob/a6b46701fb9b331006d7f2f2278bf51f123b1447/audits/FROSTLASS/README.md
- FROSTLASS PDF: https://github.com/monero-oxide/monero-oxide/blob/a6b46701fb9b331006d7f2f2278bf51f123b1447/audits/FROSTLASS/FROSTLASS.pdf
- CLSAG crate: https://github.com/monero-oxide/monero-oxide/tree/a6b46701fb9b331006d7f2f2278bf51f123b1447/monero-oxide/ringct/clsag
- CLSAG multisig: https://github.com/monero-oxide/monero-oxide/blob/a6b46701fb9b331006d7f2f2278bf51f123b1447/monero-oxide/ringct/clsag/src/multisig.rs
- Wallet multisig send: https://github.com/monero-oxide/monero-oxide/blob/a6b46701fb9b331006d7f2f2278bf51f123b1447/monero-oxide/wallet/src/send/multisig.rs

FROSTLASS paper:

https://eprint.iacr.org/2026/589.pdf

Verified details used by this project:

- FROSTLASS thresholdizes Monero CLSAG, not a naive LSAG “thring”.
- The paper uses a “Schnorr-shaped hole” proof technique and one-more
  discrete-logarithm assumptions.
- Definition 2 in the paper is the κ-OMDL assumption.
- The Rust implementation is in `monero-oxide/ringct/clsag/src/multisig.rs`.
- The inspected `monero-clsag` crate license is MIT.

This project does not vendor monero-oxide code. It only defines a signer
boundary and uses a mock threshold cluster for local tests.

## THORChain

Canonical repository:

https://gitlab.com/thorchain/thornode

The user-supplied URL `https://gitlab.com/thorchain/thornod` is missing the final
`e`; the canonical name is `thornode`.

Clone attempt in this sandbox:

```text
git ls-remote https://gitlab.com/thorchain/thornode.git
=> TLS handshake failure / unreachable from sandbox
```

Fallback sources used for inspection:

1. Deprecated GitHub mirror, README-only:

   https://github.com/thorchain/thornode

   Inspected commit:

   ```text
   d27d99b5510978ba7c522419074efe18032ac7ae
   ```

   The README says the repository is hosted on GitLab.

2. Third-party GitHub source fork, NOT canonical upstream:

   https://github.com/faddat/thornode

   Inspected commit:

   ```text
   76bc0474ff8a8812299be2f9ae81d144f3b97089
   ```

   Pinned links:

   - Root: https://github.com/faddat/thornode/tree/76bc0474ff8a8812299be2f9ae81d144f3b97089
   - Bitcoin signer: https://github.com/faddat/thornode/blob/76bc0474ff8a8812299be2f9ae81d144f3b97089/bifrost/pkg/chainclients/bitcoin/signer.go
   - Ethereum client: https://github.com/faddat/thornode/blob/76bc0474ff8a8812299be2f9ae81d144f3b97089/bifrost/pkg/chainclients/ethereum/ethereum.go
   - Swap logic: https://github.com/faddat/thornode/blob/76bc0474ff8a8812299be2f9ae81d144f3b97089/x/thorchain/swap.go
   - Swap handler: https://github.com/faddat/thornode/blob/76bc0474ff8a8812299be2f9ae81d144f3b97089/x/thorchain/handler_swap.go
   - Vault keeper: https://github.com/faddat/thornode/blob/76bc0474ff8a8812299be2f9ae81d144f3b97089/x/thorchain/keeper_vault.go
   - Common tx: https://github.com/faddat/thornode/blob/76bc0474ff8a8812299be2f9ae81d144f3b97089/common/tx.go

THORChain thornode license in the inspected fork: MIT.

## THORChain mechanism documentation

Streaming swaps:

https://dev.thorchain.org/swap-guide/streaming-swaps.html

Continuous liquidity pools / CLP equations:

https://docs.thorchain.org/technical-documentation/thorchain-finance/continuous-liquidity-pools

Liquidity / streaming / arbitrage overview:

https://docs.thorchain.org/liquidity

Verified details used by this project:

- Streaming swaps split one deposit into sub-swaps using interval and quantity.
- The interval gives arbitrageurs time to rebalance between sub-swaps.
- Successfully swapped value is sent; remaining source asset is refunded.
- CLP derivation Eqn 2 is base XYK output: `y = xY / (x + X)`.
- CLP derivation Eqn 6 is slip-fee output: `y = xYX / (x + X)^2`.

The v2 reference hub pool implements Eqn 2-style constant-product output, not
Eqn 6 slip-fee output.

## Reproducing the fetch

From `fhe-swap`:

```bash
npm run fetch:upstreams
```

or:

```bash
bash scripts/fetch-upstreams.sh /path/to/upstreams
```

The script fetches Serai and monero-oxide from GitHub. It prefers canonical
THORChain GitLab. If GitLab is blocked, it explicitly warns that the GitHub
mirror is deprecated/README-only and that `faddat/thornode` is a third-party
fork.
