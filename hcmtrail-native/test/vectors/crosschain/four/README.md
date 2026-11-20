# Public four-asset settlement vectors

`hype-trx`, `trx-bnb`, and `bnb-eth` are funded format-7 NotBefore STARK spends for `test/crosschain-four.test.mjs`. Paired with `../swap` (ETH → HYPE), the fixtures check each coin once as source and once as destination. They do **not** attest any live chain event. The quotes loop is separate from the funded spends.

The `.json` contains only an order ID, public spend fields, and a SHA-256 of the `.bin`. No opening, fee signer, journal, signed transaction or feed service credential is included. These fixture addresses and note openings are public; never reuse them outside the in-process tests. TRX → BNB spends only part of the TRX note and leaves backed change.

To rebuild, obtain the pinned EVM/TVM compilers and prover from [the runbook](../../../../docs/TESTNET.md) and run `NATIVE_CROSSCHAIN_VECTORS_DIR="$(mktemp -d)" npm run test:crosschain:four:fresh` from the native root. With `TRON_SOLC` set, copy the six public files only after verification and run `npm run test:crosschain:four`. Intentionally changing the test domains, order terms, funded notes or TVM creation bytes can require new proofs. Do not regenerate merely to change an on-chain price after proof creation: the buyer's min/cap/deadline are pinned, not the quote observed at lock.

| Proof | Bytes | SHA-256 |
| --- | ---: | --- |
| `hype-trx.bin` | 95624 | `48b3dbc59f66ead5a33c692fc18817ae341a89dc43865d59d89cf9ee49c315ae` |
| `trx-bnb.bin` | 95208 | `7cdd9040ac5168f55b6faefb247de57c6eda3f464f8b7d05a5a4faff18c16779` |
| `bnb-eth.bin` | 95688 | `4b4ccbaabbe6e14e77ecaf6b232d4e848d61683b32f4ab7f141b27fe887ced94` |
