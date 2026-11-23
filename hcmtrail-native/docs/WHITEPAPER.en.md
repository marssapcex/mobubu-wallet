# hcmtrail

**A multichain wallet with shielded balances, batch settlement, and independent exits**

**Research design · English edition · 18 November 2026.** This paper proposes a protocol built from existing cryptography and chain machinery. It is not a production specification, an audit, or a claim of measured anonymity. The proposed architecture is not deployed. **Do not use real funds.**

[Read or download the typeset PDF](whitepaper/hcmtrail-whitepaper-en.pdf)

## Abstract

hcmtrail proposes a wallet for native ETH on Ethereum, BNB on BNB Smart Chain, TRX on TRON, and HYPE on HyperEVM. Each network has a separate vault. Inside a vault, users hold **notes**: cryptographic commitments to value and the authority to spend it. A wallet keeps note secrets and builds zero-knowledge STARK proofs locally. Users can hold or transfer value without assigning each note a public account balance.

The proposed cross-chain flow exchanges a source note for a **funded note on the destination chain**, not an immediate transfer to a public address. A liquidity provider reserves native capital. The source seals a batch of valid claims, and the destination verifies the source's finalized batch before funding it. The destination admits the batch under a vault root shared with other notes. Later spending proves membership without identifying the claim used. No per-user order identifier is published on both chains. Users can hold or spend the destination note before deciding whether to withdraw.

The proposal combines established tools: commitments and nullifiers, Merkle proofs, transparent STARKs, native consensus verification, and standardized encryption building blocks. The research question is whether this particular composition reduces measured linkage without sacrificing backing, recovery, or independent local exits. Public chains still expose routes, batch totals, timing, and native payouts. Tests of an earlier VM prototype do not validate the proposed batch protocol or establish live finality, anonymity, or end-to-end post-quantum security.

Reading guide: §2 defines the privacy claim; §5 follows the capital and explains refunds; §10 sets test and release gates; §11 separates prototype evidence from open work.

## 1. Design goals and cryptographic foundations

A user should be able to deposit ETH, obtain a backed BNB note, hold it across many epochs, transfer a portion, or use it with a supported batch DeFi adapter. The wallet should not require a persistent hcmtrail account or a single public address reused across networks. An unlocked note, including an already funded destination note, must remain spendable locally if the oracle, liquidity provider (LP), or cross-chain relay stops. Funds already locked in a swap follow a separate settlement and refund path.

| Established building block | Role in this design | What it does not establish |
| --- | --- | --- |
| **Commitments, nullifiers, and Merkle trees** [1][notes] | Bind hidden note data, detect double spends, and prove membership under a vault root. | A Merkle root does not make leaves available. A commitment alone does not hide amount or timing outside the proof. |
| **Transparent STARKs** [2][stark] | Prove note ownership, correct state inputs, and value conservation without revealing the witness. | The proof family does not establish a correct AIR, safe masking, acceptable cost, or the parameters of this application. |
| **Consensus and receipt verification** [3][consensus] [4][receipts] | Authenticate a finalized block and then show inclusion of the expected settlement record. | An inclusion proof is not finality. Each direction needs the correct chain rules and independently sourced bootstrap evidence. |
| **ML-KEM, a standardized key-encapsulation mechanism** [5][mlkem] | Candidate for establishing encryption keys for note delivery and recovery. | ML-KEM is not a signature, a complete note-encryption format, or proof that the recipient is hidden. |

The new work is the composition, not a new cryptographic primitive. The first design uses fixed-size slots and one public execution quote per batch. That allows the contracts to account for total capital with integer arithmetic without requiring a coordinator to know arbitrary private amounts. Settlement uses real native reserves on both sides, not wrapped assets or unbacked IOUs. The proposed architecture has no project signing quorum, RPC-trusted root, or discretionary rescue key as a fallback for consensus evidence.

The wallet-level goal is aligned with the idea of shielded balances by default [6][roadmap]. RAILGUN already has private note balances and DeFi integrations, and some applications connect shielded endpoints across chains [7][railgun] [8][railoxide]. This design must demonstrate a narrower advantage: **replace the public per-order settlement link with one funded batch without weakening independent exits**. More networks, more deposits, or a different proof family do not alone imply better privacy.

## 2. Threat model and privacy claims

### 2.1 Observers and assumptions

- **Cross-chain observers:** see ledger and public mempool activity, events, root changes, route assignments, prices, fees, gas payers, and transaction shapes on multiple chains.
- **Colluding services:** RPCs, indexers, relayers, LPs, and quote services can combine request contents, timestamps, and network metadata they collect. Transport encryption does not hide a request from the service receiving it.
- **Active participants:** can supply many of their own slots, know their own outcomes, and influence timing or liquidity. Ten addresses need not represent ten independent users.
- **Long-term observers:** can archive ciphertext and public records now and analyze or attempt to decrypt them later. Automated analysis is an adversary capability, not a kind of cryptography the protocol defeats by definition.

Validators check proofs and public state, not note openings, spending secrets, or private Merkle paths. They can still make inferences from the public fields they see. A compromised device, a leaked opening, or a counterparty that reveals the link is outside the claimed protection. Monetary safety also assumes correct base-chain consensus and pinned verifiers. Zero-knowledge proofs do not hide network metadata.

### 2.2 What remains public

| Stage | Intentionally public | Not published in plaintext |
| --- | --- | --- |
| Native deposit | Chain, vault, funding transaction, deposited amount, time, commitment | Note opening and spending secret |
| Shielded spend | Accepted root, spent nullifier, output commitments, execution footprint; asset implied by the vault | Which note was spent, individual private values, keys, and shielded recipient |
| Swap lock | Route and quote, visible slot counts, commitments, intake window, final batch size | Link to the original deposit and the opening of the destination claim |
| Destination funding | Destination chain, **batch** ID and root, total funding, terminal state | Mapping from individual source slots to destination spends; no per-claim native payout |
| Native withdrawal | Each receiving address and transferred amount, time, public fee, gas transaction | Private Merkle path and the secrets that identify the note being spent |

Several slots submitted in one transaction can be visibly grouped. A route-specific batch does not hide the route. Distinct ciphertext lengths, rare proof shapes, and patterns in root selection can fingerprint operations even when contents are hidden. This table describes intended disclosures; it is not an exhaustive side-channel analysis.

### 2.3 Cryptographic and empirical tests

**Cryptographic claim to prove.** Compare two valid histories with identical declared public leakage and the same information already known to the adversary, but with the ownership of destination claims swapped. The protocol transcript should not distinguish them with non-negligible advantage. This tests hiding commitments, nullifier unlinkability, proof masking, and note delivery under the stated assumptions. It is not a promise of indistinguishability when the public amounts or timing already determine the answer.

**Empirical claim to measure.** Given the actual trace and realistic auxiliary data, measure how often an analyst matches the true endpoints and how many plausible candidates remain. A batch of 100 slots with 99 known to an adversary need not provide more than one candidate for the remaining slot. Count independent plausible participants, not commitments, padding, or total value locked.

Random fees do not remove this problem. At 0.15–0.5% a 1 BNB gross amount yields 0.995–0.9985 BNB, while 1.01 BNB yields 1.00495–1.008485 BNB. The intervals do not overlap even if the random draws are secret. Use cryptographic randomness for secrets and blinding, make fees explicit, and test any fee policy against the same observed trace.

## 3. Vaults, notes, and recovery

### 3.1 Notes and a shared vault root

A note commits to a vault domain, an integer amount in native base units, spending authority, a secret identifier, and blinding. The vault domain includes the chain, deployment, and version, not just the ticker. Use a cryptographically secure source of randomness, and persist the secrets before broadcasting.

- **Commitment:** bind the note fields while hiding the opening under the selected primitive and encoding. Append commitments, not keys or plaintext notes.
- **Nullifier:** derive a spent marker from the secret material bound to the note and its vault domain. The proof verifies that derivation. The marker stays the same across local spends, swap locks, roots, and relayers, so those paths cannot spend the same note twice. It must not be computable from the commitment alone.
- **Shared root:** the vault admits valid local note groups, funded destination groups, and cancelled-batch refund groups. A spend proves membership under an accepted vault root. The group type, leaf, and membership path stay in the witness. If public inputs or proof shapes differentiate these groups, that leakage must be measured rather than assumed away.

This is a tree of committed groups within one vault, not a universal root authorized to spend across chains. An imported group binds its subordinate root, the funded slot count, and the denomination. The destination proof checks a leaf is within the funded range and carries the correct amount. Empty or padded slots cannot create spending rights. The contract does not accept arbitrary roots asserted by a relay.

### 3.2 Spend relation and accounting

The STARK must prove that inputs belong to a valid root, the prover has spending authority, nullifiers and output commitments are well formed, and integer value is conserved. Any public payout, fee, or batch terms must be bound to that proof. The contract independently checks the accepted root, unspent markers, and transition bounds before applying it.

Conservation is over **integers**:

```text
sum(inputs) = sum(new notes) + value paid or locked, excluding fees + bound fees
```

Range-check limbs and carries so equality modulo the proof field cannot create value. Use exact base units: for example, sun on TRON. Each note, tree, transaction, and verifier has finite limits. A per-note bound need not impose a cap on vault-wide native balances. Before a tree or version reaches a limit, the vault needs an append or holder-authorized migration path, not a sweep key.

### 3.3 Long-lived notes and independent recovery

- **No batch expiry for funded notes:** a funded or unlocked note does not expire with an LP quote, batch, or oracle epoch. Spending still requires the chain, a safe verifier, valid witness data, and the owner's secrets. Prefer a common root over an unnecessarily narrow one that reveals a receipt window.
- **Local records:** persist spending and viewing material, openings, and change and refund notes before sending. A backup must restore what the wallet actually needs; a seed or gas address that cannot recover an opening is insufficient.
- **Independent public data:** reconstruct membership from authenticated public data and compare it to the accepted root. A wallet need not ask an indexer for the path of its specific commitment. A relay receives a proof and the permitted public fields, not the secret witness. There is no project-wide recovery key.

**Funding is not witness availability.** The wallet must verify funding and retain the opening and authenticated data needed to reconstruct the subordinate path. Publish the batch commitments and maintain independently verifiable archives, including for wallets that were offline when it settled. A root does not reconstruct missing leaves. After a funded note is imported, a recovered wallet must be able to spend it using destination-chain state without re-verifying the source for every spend. Test that with the default archive and relay unavailable.

## 4. Execution quotes, standard slots, and LP reserves

A batch on route `A → B` fixes its peer vaults, version, epoch, source denomination `d`, integer rate `p/q` in base units, fee `bps`, capacity `K`, minimum fill, source intake close, and destination funding deadline. The LP commits to the quote with actual reserve capital; a price feed is not collateral. The wallet checks its minimum acceptable outcome locally against public terms. Reference prices may inform that check but cannot change the quote after the lock or gate a local exit.

```text
per slot: gross B = floor(d × p / q), q > 0
          fee B   = floor(gross B × bps / 10_000)
          net B   = gross B − fee B
k slots:  escrow A = k × d
          native backing for notes B = k × net B
          fees collected B = k × fee B
```

Reserve `K × gross B` at B. Check quote, fee, slot, and multiplication bounds on both chains, including that the net note amount is positive. Compute the floor **per slot**, not once on the batch total. The LP's source credit account is bound before intake; a relay cannot substitute it. Track free and reserved LP funds separately. Disclose and cap relay gas charges separately from principal and swap fees.

**Arithmetic illustration, not a market quote.** One slot is `0.01 ETH`, the assumed rate is `33/8 BNB` per ETH, and the fee is `25 bps`. A slot has `0.04125 BNB` gross, a `0.000103125 BNB` fee, and a `0.041146875 BNB` note. With `K = 32`, the LP reserves `1.32 BNB`. If `k = 24` slots seal, A escrows `0.24 ETH`, B adds `0.987525 BNB` of note backing and collects `0.002475 BNB` in fees, and `0.33 BNB` returns to free LP capital. If B cancels before funding, no notes or swap fees arise at B; A restores `0.24 ETH` as refund notes when cancellation is authenticated.

Standard denominations trade flexibility for auditable totals without a coordinator collecting private amounts or a new private aggregation primitive. The wallet can keep the remainder as source change. Too many denominations, quotes, or routes split the candidate set. The first tests should use a small number of repeatable configurations and no per-identity quote schedule.

## 5. Funded cross-chain batches

```text
B: reserve native capital ── finality B → A ──► A may accept valid slot locks
A: lock slots and seal roots ── finality A → B ──► B may fund the whole batch
B: funded root → shielded balance on B; no immediate native withdrawal
B: FUNDED or CANCELLED ── finality B → A ──► credit LP or restore notes on A
```

### 5.1 Reserve and lock

1. **B records `RESERVED`.** Its contract locks actual native capital until the batch reaches a terminal state and fixes the deadline in B's time domain. A only opens intake under authenticated finality for the correct reserve terms and pinned peer. Wallets should reject an impractically short window. The two chains do not share a clock.
2. **A wallet locks a slot on A.** A proof consumes a valid note with its ordinary nullifier, debits `d`, creates any change, and binds both the B commitment for `net B` and the refund commitment for `d` on A. The wallet keeps both openings. It does not reveal a destination withdrawal address or a stable cross-chain per-user order ID. Apart from change, value moves from note liability to escrow; neither new commitment is yet spendable.
3. **A seals the batch.** The batch state derives its claim and refund subtrees from the accepted proofs. Sealing fixes roots and count. Publish the leaf commitments on A so independent wallets can reconstruct the trees. The authenticated outbox binds the terms and roots, not a list of individual public payouts. Missing the fill threshold cannot justify fabricating a funded batch to unlock escrow.

### 5.2 Fund or cancel on B

B verifies the `SEALED` record under authenticated finality from A. Check the version, domain, reserve terms, count, roots, and funding deadline. Before that deadline, if all checks pass, the contract **atomically funds the batch on B**: debit reserves, pay fees, move `k × net B` into vault backing, admit the claim root under the vault root, and mark `FUNDED`. Every local effect succeeds together or rolls back. B does not re-emit individual source commitments as payout orders. Once imported, the B note is usable under the common vault root.

If the funding deadline passes without funding, anyone can advance the contract to `CANCELLED` and release the reserve. **The terminal states are mutually exclusive.** A funded batch cannot be cancelled because its notes have not been spent. A batch deadline is not a note lifetime. The entire cross-chain flow is asynchronous; it is not one atomic transaction across chains.

### 5.3 Settle or restore notes on A

- **Finalized `FUNDED` on B:** authenticate that it matches the sealed batch, then convert the source escrow to credit for the pinned LP. A does not need to know which B note was spent, or whether any was spent.
- **Finalized `CANCELLED` on B:** stop source intake, freeze the accepted slots, return escrow to backing, and admit the refund group for exactly those slots. Do not send each refund to a funding address. The original nullifier stays spent; refund notes are new notes. An authenticated cancellation can also close a batch that never sealed.
- **Replay and races:** reject wrong domains, stale or incompatible transitions, mismatched terms, and repeat claims. Settlement to the LP and note restoration cannot both consume the same source escrow. The wallet can verify the result without relying on a relay's private journal.

**Liveness has a hard limit.** If B funded the batch and then stops communicating, A cannot distinguish that from failure to fund based only on silence. A's clock, a missing receipt, or an LP assertion is not a refund proof. Locked swaps can stall. Reserve before intake, cap outstanding exposure, and stop new batches when evidence is stale; none of those measures should disable exits for other valid notes.

### 5.4 Monetary invariants

| Invariant | Required enforcement |
| --- | --- |
| **Capital before claims.** | Import a subtree only with real native backing. Check the funded count and denomination at import and in the spend relation. A root is not collateral. |
| **One liability at a time.** | A spent note moves to escrow, then to LP credit **or** refund-note backing. B capital is free, reserved, transferred into backing, or paid as fees. Do not count it in two places. |
| **Local balances do not cover bridge losses.** | Each contract independently covers its liabilities; the bridge has no arbitrary withdrawal right over note-holder reserves. The import must not create claims above actual backing, including if an anchor fails. This requires testing and proof review. |
| **Replay protection without a trusted relay.** | Each transition is single-use in its domain. Note nullifiers are stable across spend paths and roots. Old proofs are not valid in a new domain. |

The cross-chain claim that a batch cannot fund B and restore A depends on correct **two-way finality**, inclusion, and state transition verification. A false terminal record can divert or restore source escrow incorrectly. Isolation and exposure limits bound losses; they do not repair a false consensus proof. Limits apply to outstanding cross-chain obligations, not to ordinary local note balances.

## 6. Authenticate consensus before inclusion

A settlement message must pass two distinct checks:

1. **Finality:** authenticate the chain and fork, genesis, independently sourced bootstrap, validator or sync-committee changes, and finalized checkpoints according to the chain's own rules. State the weak-subjectivity assumptions and expiry policy. Block depth, an RPC `finalized` label, and signatures from a project committee are not substitutes.
2. **Inclusion:** under an authenticated checkpoint, prove the expected state or log from the pinned contract. Bind the peer, domain, version, transition, terms, batch identifier, and roots. On EVM networks, a receipt Merkle Patricia trie proof authenticates a receipt under `receiptsRoot`; it does not establish that the header itself is canonical or finalized.

For ETH ↔ BNB, the forward direction needs Ethereum Beacon light-client evidence (including the correct fork and native sync-committee signatures), while the reverse direction needs BSC's Parlia rules [9][parlia]. The VM model of a BLS precompile is not observed BSC behavior. TRON and HyperEVM require their own finality and execution adapters; compatible execution interfaces do not establish compatible consensus.

A relayer transports bytes. It cannot select which finality claims the verifier accepts. Proof compression could later reduce verification cost, but the compressed statement would still need to verify the actual chain rules and bootstrap assumptions. A weaker emergency signer or RPC root would set the real security level. Until both directions are validated for a route, leave its cross-chain custody disabled.

## 7. Shielded use, batch withdrawals, and direct exits

### 7.1 Use value without a public payout

A shielded transfer spends an input note and commits a new note for the recipient, with private change if needed. The recipient needs authenticated access to the encrypted note opening. Do not publish a shielded recipient key as a stable identifier in logs. When changing networks for their own wallet, a user can generate the destination and refund openings locally without giving a service both identities.

Support DeFi through an adapter only where aggregate execution and allocation of the resulting claims can both be verified. A public AMM still exposes the assets, size, and price of the aggregate trade. An application that opens a public per-account position or emits a distinct action for each user cannot be made private merely by shielding before and after it. Measure LP rebalancing too: moving the exact amount immediately after each trade can reintroduce correlation. Begin with shielded transfers and batch swaps, not privacy promises for arbitrary DeFi positions.

### 7.2 Two local withdrawal paths

- **Batch withdrawal:** a relay combines independently authorized withdrawals with a common shape and window. Each proof binds the recipient, amount, fee, and relevant terms. Payout and nullifier/change effects must be atomic **per withdrawal**. A reverting receiver cannot destroy its note or indefinitely block others. Benchmark how many proofs fit within a chain's gas, size, and execution limits before claiming large batches.
- **Direct exit:** any valid submitter can pay gas for a local withdrawal proof. No crowd, quote, LP, or new cross-chain evidence is required for an unlocked or already funded note. The wallet should explain the privacy cost of a sparse exit without withholding the option.

**Batching does not hide a native transfer.** Every final `recipient, amount` remains public. Individual proofs and their payouts may be matched within a batch. The benefit to test is that cross-chain settlement no longer requires an immediate public exit and that common withdrawal windows may reduce distinctive timing or gas patterns.

## 8. Wallet metadata and post-quantum scope

Separate spending, viewing/delivery, and gas roles. Generate proofs locally and sync from shared public data. Do not collect telemetry that joins quotes, note records, relay requests, and final addresses. Keep a private, recoverable operation journal for retries; do not turn local operation IDs into shared cross-chain identifiers. These practices reduce avoidable disclosure but do not make network observation impossible.

Three post-quantum questions require separate answers:

1. **Spending authority and commitments.** Evaluate hash and PRF choices, entropy, binding, hiding, and domain separation under the stated quantum model. A digest length alone does not justify a specific security claim.
2. **Proof system.** Publish the AIR, masking, Fiat–Shamir transcript, FRI parameters, and soundness budget across proofs and adversarial queries. A foundational STARK result does not certify an application circuit or parameter set. Do not expect to repair long-lived notes only after deploying an unsafe verifier.
3. **Archived ciphertext.** Test the store-now, decrypt-later threat separately. FIPS 203 ML-KEM is a candidate for key establishment. The full envelope also needs authenticated encryption, review of recipient privacy, and a scanning strategy that avoids stable recipient tags. Do not ship permanent public ciphertext until that composition is evaluated.

A note holder should be able to authorize migration to a new version without granting an administrator the right to move funds. Migration cannot erase ciphertext already recorded. **Base-chain consensus and gas transaction signatures are separate security layers** and may use classical algorithms. Report exactly what was evaluated; do not market end-to-end quantum resistance.

## 9. Scoped disclosure without a wallet-wide viewing key

A policy proof could attest that **the value used for a particular action satisfies policy P at snapshot S**, following the association-set approach of Privacy Pools [10][policy]. Bind the disclosure to the verifier's request, the policy version, and the relevant value. Do not expose the wallet's global viewing key, other recipients, or unrelated history. A policy provider gets no spending authority or arbitrary vault freeze key.

Policy criteria and sources must be reviewable. Transfers, merges, splits, and chain changes do not automatically make funds eligible. If the proof claims provenance across steps, it must show the eligible amount is conserved and tracked through those steps. A user's policy proof does not attest to the provenance of the LP's reserves; that is a separate obligation.

Such a proof is a limited disclosure tool, not a universal legal determination. Sets can be wrong or too small, reducing privacy or excluding legitimate users. Evaluate false positives, correction paths, and the effect of narrower sets. A service may impose eligibility for that service; a newly selected policy list should not become an administrative veto on already funded local notes.

## 10. Measurement and release gates

### 10.1 A falsifiable first experiment

Start with **ETH ↔ BNB** and reproducible labeled simulation or faucet data. Compare the existing public per-order payout model with batch-funded notes, each under fixed fees and experimental random fees. This is a `2 × 2` comparison, not a reason to adopt random fees. Replay the same labeled user activity and liquidity conditions across configurations; report exactly how public transcripts differ.

- **Scenarios:** dense and sparse traffic, concentrated LP inventory, many adversary-controlled slots, quick and delayed exits, service collusion, route splitting, and distinctive public amounts or fees. Include failures, cancellations, and public rebalancing.
- **Analyst inputs:** compare public-chain-only traces with the addition of timing, network, service, and counterparty information. Test amount, time, asset, route, root, graph, fee, and gas constraints jointly and separately.
- **Outcomes:** measure correct top-1 and top-k links against ground truth, remaining feasible candidates, calibration of confidence, and the share of users left with few candidates. Also report proving and verifying cost, reserves, throughput, delay, failure rates, and recovery success. Show poor cases and subgroup results, not just a mean from busy batches.

Register thresholds and assumptions before testing. If the improvement only exists above a traffic floor, state the floor. Historical studies of RAILGUN report candidate narrowing from behavioral and public constraints [11][huseynov] [12][guo]; they do not identify every user or show that hcmtrail is better. An implemented verifier passing a fixture is not evidence of practical unlinkability.

### 10.2 Milestones and stop conditions

| Milestone | Evidence required to proceed |
| --- | --- |
| **1. State machine and leakage model** | Exercise `reserve/lock/seal/fund/cancel/settle` orderings, reorgs, and delayed evidence. Show conservation, no double settlement, and independent local exits. Publish the comparison and its failure cases. |
| **2. Real circuits and recoverable vaults** | Prove ordinary, change, imported, and refund notes. Reject bad denominations, out-of-range slots, wrong domains, replay, integer wraparound, and substituted payouts. Shut off the bridge, oracle, and default relay; recover and exit from valid notes. |
| **3. Native finality on ETH ↔ BNB** | Obtain independent real-chain positive and negative evidence in both directions, validate bootstrap and fork transitions, and complete both settlement and refund with faucet assets. Measure verifier, reserve, retry, and execution costs. No fixture or historical-only anchor may authorize live custody. |
| **4. TRON and HyperEVM** | Add chain-specific adapters only after the first route shows value. Verify TVM behavior, TRON Energy and TAPOS, HyperEVM block limits, and both chains' consensus. Repeat leakage and recovery tests; a common codebase does not establish route safety. |
| **5. Independent audit and release** | Audit vault state, AIR, proof parameters, note encryption, dependencies, off-chain disclosure, and migrations. Exercise long outages, expired evidence, receiver failures, and batches dominated by known slots. No real funds or comparative security claims before the relevant gates pass. |

Added privacy may cost time, reserved capital, data retention, and local proving resources. Report these together. A smaller proof is not an improvement if it requires handing the witness to a service, and adding routes is counterproductive if it fragments every batch below a useful number of independent participants.

## 11. Prototype evidence and open work

**Public prototype baseline.** The repository provides earlier native-vault, STARK spend, and receipt-proof research code at a pinned commit [13][prototype], with the upstream verifier and prover provenance spelled out separately [14][provenance]. These public contracts and tests are evidence that the constituent mechanisms are concrete, not a deployment of the protocol described here.

**Later VM replay, not independent replication.** The project recorded **45 of 45 checks passing** for a separate development snapshot. The checks covered native deposit and STARK exit, batch deposits, recovery of an automatic local withdrawal, oracle fixtures, and receipt-based cross-chain VM settlement. The numbers refer to that snapshot, not to tests run by publishing this paper. The VM paid each order individually from funded inventory; its public logs and payouts were linkable. It did not deliver batch-funded, privately spendable destination notes.

**Finality readiness.** Receipt inclusion was tested under anchored blocks. The experimental Sepolia-to-BSC testnet path exercised Beacon verification with synthetic updates and a modeled BLS precompile; it is not public-network finality evidence. Reverse Parlia verification, production-quality TRON and HyperEVM adapters, the new batch circuits, real-network cost measurements, and independent audits are open. There is no measured cross-chain privacy gain or assessed end-to-end post-quantum security for this design.

**The test of the design:** after a swap, the user still has a privately spendable, native-backed note. Chains can account for the capital and enforce one spend without publishing a mapping from each source order to its destination spend. If the mapping can still be recovered reliably from public and auxiliary data under the stated experiment, revise the design rather than calling it a proven private cross-chain wallet.

[notes]: https://eprint.iacr.org/2014/349
[stark]: https://eprint.iacr.org/2018/046
[consensus]: https://github.com/ethereum/consensus-specs/tree/031a603a48e4efaf5e52bab38c473d8b7161f6ef/specs
[receipts]: https://eips.ethereum.org/EIPS/eip-2718
[mlkem]: https://csrc.nist.gov/pubs/fips/203/final
[roadmap]: https://ethereum-magicians.org/t/a-maximally-simple-l1-privacy-roadmap/23459
[railgun]: https://docs.railgun.org/wiki/learn/integrating-railgun/example-dex-swaps
[railoxide]: https://github.com/triamazikamno/railoxide/pull/13
[parlia]: https://github.com/bnb-chain/bsc/tree/4bd1c73016e31038a0ce9fdadce24d19d7128e25/consensus/parlia
[policy]: https://cif.unibas.ch/en/news/details/blockchain-privacy-and-regulatory-compliance-towards-a-practical-equilibrium
[huseynov]: https://arxiv.org/abs/2606.25926
[guo]: https://arxiv.org/html/2608.22987
[prototype]: https://github.com/marssapcex/mobubu-wallet/tree/3d773bf894fbc32cd1081d392f8b502d83a1e323/hcmtrail-native
[provenance]: https://github.com/marssapcex/mobubu-wallet/blob/3d773bf894fbc32cd1081d392f8b502d83a1e323/hcmtrail-native/contracts/vendor/nonos/NOTICE.md
