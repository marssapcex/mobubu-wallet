# Phase 1 — audit every discrete event in a cross-chain swap

The rule from the first project applies unchanged: find the discrete events, test
each against three filters, keep only what survives. The difference is that this
time I expect the screen to reject the whole domain, so the screen *is* the
deliverable.

Filters: **A** = can the event be eliminated by an invariant (not by more
capital)? **B** = does nobody do it already? **C** = does the event cost money
worth capturing?

## The eight events

| # | event | who already eliminated it | A | B | C |
|---|---|---|---|---|---|
| E1 | lock / unlock custody of the asset | canonical bridges, CCTP (≈0 fee), LayerZero | no — needs shared state | no | no |
| E2 | attestation / quorum signature | zk light clients, Succinct-style provers, Wormhole zk | no | no | no |
| E3 | the quote / fill (solver picks a price) | UniswapX, 1inch Fusion, CoW, Across | no — RFQ is already continuous | no | no |
| E4 | reimbursement of the solver (lump-sum settlement) | Everclear netting, Across repayment | yes | **no — Everclear owns it** | no |
| E5 | timeout / refund clock | HTLC atomic swaps (COMIT, Serai) | no — a clock cannot be removed without shared state | no | no |
| E6 | finality wait (reorg window) | bonders price it into a flat fee (Hop, Across) | yes — price it as a rent | arguably not | **no — worth 1–2 bp** |
| E7 | inventory rebalancing | Everclear, Across treasury ops, arbitrage | yes | no | no |
| E8 | bond / slash of the validator set | THORChain RUNE bond, SYNAPSE | no — this *is* consensus | no | — |

Only E4, E6 and E7 pass filter A, and every one of them fails B or C. That is
not a coincidence; §4 says why.

## What the numbers say

- Bridges move **$1.60 b in 24 h**, $11.36 b in 7 d, $52.0 b in 30 d gross
  (DeFiLlama bridge overview). The category runs at roughly 30× THORChain's
  volume.
- THORChain: **$122.2 m TVL**, **$158.1 m swap volume in 24 h**, 544,347 swaps,
  $129 b lifetime volume (Thorcharts, 2026-10-01 state). Fees are 0.05–0.15%
  plus slip, so the entire gross prize at this volume is ≈ $79–237 k/day shared
  between LPs and 95 bonded nodes.
- Serai: **mainnet still not launched**; the project's own docs say so. Its
  Monero libraries are audited and FROSTLASS is a real contribution, but it has
  been "coming" since 2022.
- CCTP moves USDC for approximately nothing, which is the price floor for every
  stablecoin swap.

The conclusion from the numbers alone: a new entrant fights for a share of an
$80–240 k/day gross fee pool against four funded incumbents and one free
canonical bridge. There is no version of "better mechanism" that captures that
market.

## Where THORChain's volume actually comes from

Its own frontend breakdown shows a large share arriving through third-party
interfaces — SwapKit, AsgardEx, Trust, Ledger Live and similar — rather than its
native app. The moat is distribution, and distribution is not something a
mechanism can buy.

## 4. Why the screen fails structurally, not by accident

**Proposition.** Any cross-chain swap preserves value on both chains only if
some party takes an unhedged position on the state of a chain it cannot read.

*Proof sketch.* Chain A cannot observe chain B's state at the moment it acts, so
at the instant of the swap either (i) some party has already committed assets on
B against a promise on A, or (ii) the swap is conditional on a future
observation of B, which requires a shared clock and a shared state machine. Case
(ii) is a bridge or a chain. Case (i) is a market maker holding inventory. There
is no third holder: an actor with no position on either side has nothing to lose
and therefore nothing to enforce with.

So the design space partitions exactly into **{bonded shared state, capitalised
counterparty}** — THORChain and Serai are the first, solvers and CCTP are the
second. Every apparent "new" design is one of the two with a different payment
scheme. The only remaining degree of freedom is *how the position-holder is
compensated and how its risk is bounded*, which is a credit-pricing question,
not a swap-design question.

That is the whole negative result, and it is decisive: the residual freedom is
the same object the lending project already built — a continuous price for
holding a risk. A cross-chain project that only redesigns the swap is designing
around a constraint that has already been optimised away.

## The one thing that would change the verdict

If someone removed the need for the position-holder — i.e., if both chains could
read each other's state cheaply enough that no party must take a position — the
proposition fails and the space reopens. That is a light-client cost problem
(zero-knowledge proof verification on the destination chain), not a
mechanism-design problem, and it is already being solved by others with
hardware-scale budgets. Competing there is a proving-system race, not a math
race.

## Verdict

**FAIL.** Not "hard", not "crowded" — the events are eliminated, the
eliminations are owned, and the residual is worth basis points. Documented so it
is not re-litigated in six months.
