# hcmtrail: Equal-Amount Batch Withdrawals Across Four Chains

hcmtrail · November 2026

[Read the PDF](whitepaper/hcmtrail-whitepaper-en.pdf)

## Abstract

hcmtrail is a design for a four-chain privacy pool. Instead of releasing funds as each user withdraws, a vault waits for 50 valid withdrawal requests in the same payout class. It then sends exactly the same amount of native coin to 50 distinct recipient addresses in one transaction. Each request proves entitlement without identifying the deposit it spends. The design extends the same rule to asset conversion: a user who deposited ETH can qualify for one standard HYPE payout, but the HyperEVM vault pays only from prefunded HYPE and only as part of a full batch. The two defining rules are that a proof, not a secret key, authorizes a request, and that individual recipients cannot choose a different payout amount or receive an early payout.

## 1. Introduction

Tornado Cash combines fixed-denomination deposits with a zero-knowledge proof that a withdrawal spends a valid, unused deposit [1][tornado]. hcmtrail retains that separation between deposit and withdrawal but changes the unit of payment: **the vault pays a cohort, not an individual request**. Equal values remove amount differences among the cohort's outputs; one transaction removes their separate payout times. A withdrawal may stay in the queue while the vault waits for a full cohort.

There is one native-asset vault on each network: ETH on Ethereum, BNB on BNB Smart Chain, TRX on TRON, and HYPE on HyperEVM. The user can request a payout on the deposit chain or convert the entitlement to an available denomination on another chain. Neither choice creates a transferable private balance on the destination: the end result is a native transfer to a recipient the user selects.

## 2. A batch of 50 on Ethereum

### 2.1 Deposit and keep the withdrawal secret

Suppose 50 users each deposit 0.1 ETH in the same denomination pool on Ethereum. Each wallet generates its own secret and blinding material. The vault records an authenticated deposit leaf containing a commitment, the denomination and the funding address. The deposit transaction is public; the opening that lets the wallet spend the deposit is not. Deposits need not be made together, and the 50 requests in a payout need not come from 50 consecutive deposits.

### 2.2 Register a withdrawal to a different address

The wallet selects a recipient and proves that it controls one eligible deposit under a vault root. The proof checks the fixed denomination, derives a **nullifier** to prevent a second use, and binds the request to a commitment to the new recipient. It also checks that the recipient differs from the authenticated funding address. The proof does not identify the deposit leaf or expose its path. Commitments, Merkle membership, and spent markers are established techniques for this kind of statement [2][zerocash]; a zero-knowledge STARK is one way to prove it [3][stark].

The contract can verify each registration ahead of settlement, holding one pending slot per nullifier. The recipient commitment is blinded so an observer cannot test guessed addresses against it. The wallet provides an opening for batch settlement: the recipient and the blinding value for that commitment, **not** the deposit or spending secret. Anyone holding the necessary openings may submit the batch. A batch submitter can see the openings it receives, so this is not a claim that it learns no metadata.

### 2.3 Pay the entire cohort at once

The vault does not pay on registration. A batch call presents 50 distinct pending requests and 50 matching recipient openings. The vault checks eligibility, distinct recipients, the payout class and sufficient backing, then marks the requests spent and transfers every payment. These effects are atomic: if one required transfer fails, none of the 50 payments takes effect and no entitlement is consumed by that failed call. Checking the proof at registration leaves the final transaction to check stored requests and openings and make the transfers.

With fees charged separately, the example batch sends **0.1 ETH to each of 50 addresses**, or 5 ETH in total. There is no payout at 49, no payment of 0.11 ETH to one member, and no special output that bypasses the batch.

## 3. What the contract can enforce

**One class, one amount.** The contract selects the amount from the class, not from a per-recipient input. A class fixes the destination asset, net payout per slot, and group size. If a route uses a fee, it is accounted for outside individual payout values or baked into the same net amount for every member. Settlement never recalculates an individual's exchange rate or fee.

**Different, non-reused recipient addresses.** The proof compares the recipient against the corresponding original funding address without identifying that address as the deposit used. The destination vault also rejects duplicate recipients in the same batch and addresses already recorded in its own deposit or payout history. For cross-chain comparisons the protocol must specify compatible address encodings; ETH and HYPE, for example, use the EVM account format. The rule checks addresses the protocol can compare. It does not establish that an address has never appeared anywhere, or that two addresses have different owners.

**One use of the entitlement.** Every request binds the chain, vault, and class. Registration reserves the spend marker, and a successful payout consumes it. The same local deposit cannot be registered for withdrawal and locked for conversion at the same time. The vault must check this state even if both requests carry valid proofs. For cross-chain claims the destination uses a separate nullifier, not a copy of the public source marker.

## 4. Example: deposit ETH, withdraw HYPE

### 4.1 Authenticate the right to a fixed HYPE payout

Consider a class that accepts one standard ETH unit per slot and pays a fixed net amount of HYPE per slot. A liquidity provider first reserves real HYPE in the HyperEVM vault for a group of swaps at those terms. On Ethereum, each wallet proves control of a valid ETH deposit and locks one eligible unit. That consumes its source entitlement for ordinary spending. As part of the lock it creates a blinded commitment to one HYPE withdrawal ticket, binding the route, denomination, original funding-address field and independent destination secret without publishing its future recipient address.

Ethereum seals a group of such commitments under one root. HyperEVM authenticates the **finalized** Ethereum record, then atomically admits the ticket group, assigns the corresponding reserved HYPE as backing, and records that the group is funded. The cross-chain message carries the batch terms, root and count, not 50 individual withdrawal addresses. A native consensus verifier authenticates the checkpoint; a separate inclusion proof authenticates the recorded batch under that checkpoint [4][eth] [5][receipts]. A proof of knowledge of an ETH deposit, by itself, does not make an Ethereum block final or create a right to spend unfunded HYPE.

```text
ETHEREUM VAULT                         HYPEREVM VAULT
Accept finalized reserve  <---------- Reserve actual HYPE
Lock ETH; seal claim root  ----------> Verify seal; back HYPE tickets
Credit LP or restore ETH   <---------- Finalized FUNDED or CANCELLED
                                      50 eligible requests → 50 equal HYPE payouts
```

### 4.2 Join the destination batch with a proof, not the key

The user selects a new HyperEVM recipient. The same wallet proves membership of its ticket under an eligible, funded root, binds the recipient commitment, and shows that the destination ticket has not already been used. Neither the original deposit leaf nor the individual source lock appears in that request. Eligible tickets of the same class can join the same payout queue even if they were funded in different groups. A ticket authorizes one withdrawal slot; it is not a token or a balance that can be transferred for other purposes.

The HYPE vault waits until it can settle 50 valid requests with 50 different recipient openings. It pays one common HYPE amount 50 times in a single transaction, exactly as the ETH vault does for its local batch. The exchange changes which native coin backs the payout, not the equal-amount rule. A proof and its approved recipient cannot be reused as an ETH withdrawal or a second HYPE withdrawal.

## 5. Where the privacy comes from

The proof hides which deposit authorized the request. The batch removes differences in payout amount and time, but its recipients and transfers are public. Across chains, the route and funded totals are visible; there is no published table matching each ETH lock to a HYPE payment.

Fifty slots do not imply fifty independent users. An observer who knows 49 slots may still identify the last one. Sparse traffic, registration timing, root choice, gas, network metadata, and later spending can narrow the set of plausible matches. Checking for a reused address blocks one direct link, not every way to infer a connection.

## 6. Waiting, failed batches, and refunds

**If fewer than 50 requests are ready, the vault waits.** Fifty commitments are not enough: settlement needs 50 valid openings that satisfy the address rules. An unready or rejected request can remain pending or be withdrawn from the queue by its owner without spending the underlying right. A replacement recipient requires fresh authorization for the same unspent right and invalidates the previous request. If a receiver causes settlement to revert, a later group can exclude that request or use its authorized replacement. A missing batch submitter does not require a special recovery key; another submitter can take over if the openings are available. The class must fit all 50 transfers in one transaction on its chain; splitting a group into individual payouts is not the same rule.

**An exchange needs a terminal result from the destination.** Before HYPE backing is assigned to tickets, a reservation can expire and be cancelled on HyperEVM. Ethereum can restore the locked value as a new ETH entitlement only after it verifies that finalized cancellation. The original source marker remains spent. If HyperEVM has already funded the tickets, that finalized result credits the liquidity provider with the locked ETH and the users continue to the HYPE queue. Funding and cancellation are mutually exclusive. A deadline or missing message at the source is not a refund proof. Restoring a right after cancellation returns it to the pool; it is not a solo payout around the group rule.

## 7. Conclusion

hcmtrail changes the ordinary fixed-denomination pool into a four-chain system with one payout discipline: **50 eligible requests, 50 distinct recipients, one amount, one transaction**. A user can move from an ETH deposit to a HYPE payout without publishing a direct link between the two. The trade-off for less distinctive payouts is waiting for a populated class and, for conversion, verifying both chains and maintaining real destination liquidity.

## References

1. [Tornado Cash Classic: fixed-denomination pool contract][tornado]. Source at revision `1ef6a26`.
2. [Ben-Sasson et al., *Zerocash: Decentralized Anonymous Payments from Bitcoin*][zerocash], 2014.
3. [Ben-Sasson et al., *Scalable, Transparent, and Post-Quantum Secure Computational Integrity*][stark], 2018. Reference for the STARK proof family.
4. [Ethereum proof-of-stake consensus specifications][eth]. Light-client and finality rules at revision `031a603a`.
5. [EIP-2718: Typed Transaction Envelope][receipts]. Transaction and receipt trie encoding.

[tornado]: https://github.com/tornadocash/tornado-core/blob/1ef6a263ac6a0e476d063fcb269a9df65a1bd56a/contracts/Tornado.sol
[zerocash]: https://eprint.iacr.org/2014/349
[stark]: https://eprint.iacr.org/2018/046
[eth]: https://github.com/ethereum/consensus-specs/tree/031a603a48e4efaf5e52bab38c473d8b7161f6ef/specs
[receipts]: https://eips.ethereum.org/EIPS/eip-2718
