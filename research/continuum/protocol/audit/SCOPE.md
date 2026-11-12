# Audit scope and threat model

## 1. In scope

| file | lines | why it holds value |
|---|---|---|
| `src/ContinuumMarket.sol` | ~560 | all user funds, the rent law, the flow |
| `src/ContinuumShares.sol` | 45 | the lenders' claim |
| `src/lib/BufferMath.sol` | 130 | every inequality the solvency argument rests on |
| `src/lib/SafeTransferLib.sol` | 55 | token movement into and out of the pool |
| `src/oracle/Oracles.sol` | 95 | the single external number the protocol trusts |

Out of scope: `src/token/ERC20.sol` (a stock implementation, no extensions),
`src/../Continuum.sol` (the research prototype, never to be deployed), and any
deployment/parameter choice made by a governance process.

## 2. Trusted components

- **The oracle.** One number, `price()` in debt units per collateral token at
  1e18. The market trusts it completely for solvency checks and NAV. Every
  mitigation for that trust is outside this code; see §4.
- **The collateral and debt tokens.** Standard ERC20 semantics, no rebasing, no
  fee-on-transfer (rejected by `safeTransferIn`, which checks the balance delta),
  no callback into the market (there is no `onTokenTransfer` path).
- **`riskAdmin`.** Can set `depositCap`, `borrowCap`, `borrowFrozen`, and hand
  the role on. Cannot move funds, cannot change the mechanism, cannot pause
  accrual, cannot set the oracle, cannot change a parameter that is immutable.

## 3. Adversaries considered

1. **A borrower who wants protection without paying** — bids below the clearing
   rent. Result: excluded from the flow (`_deleverage` returns early when
   `bid < rho`), and priced out of the book by `updateRho`. Residual: they keep
   their position, accumulate no protection, and can still be written off.
2. **A borrower who wants to grief the book** — spamming bids, opening and
   closing positions, forcing O(n) work in a permissionless function. Result:
   the demand book is maintained incrementally (`_book`/`_unbook`/`_relevel`), a
   bid is locked for `MIN_BID_LOCK`, and `updateRho` is O(1) in the number of
   borrowers (measured: 1 borrower vs 200 borrowers on the prototype, +0.25%).
3. **A keeper-class actor** — there is nothing to win. `poke` pays nothing;
   `updateRho` pays nothing; there is no liquidation call to front-run.
4. **A lender who wants to steal from other lenders** — first-depositor
   inflation, donations, share-price manipulation at the boundary. Mitigated by
   a virtual offset (`+1` on both sides of the mint ratio) and by accrual being
   lazy per position rather than batched.
5. **A supplier that becomes insolvent** — a price gap. `writeOff` is
   permissionless and books the loss against `loans` in the same block, so NAV
   cannot overstate.
6. **A governance actor** — caps only, no fund custody.

## 4. Oracle risk (the honest part)

The market uses the oracle price directly in `_materialise`, `healthOf`,
`withdrawCollateral`, `depositCollateral`, `buyInventory` and `writeOff`. A
manipulated print therefore has two distinct effects:

- **A low print** accelerates the flow: the pool buys collateral cheaply and the
  borrower loses value. The pool's solvency is *preserved* (it paid par for
  collateral valued at `c·x`), so this is borrower-side risk, not systemic.
- **A high print** stops the flow and inflates NAV. This is the dangerous
  direction: it delays deleverage and lets `shares.price` overstate assets.

Mitigations are deployment-side and are mandatory, not optional:

1. Chainlink (or equivalent) with `heartbeat` set to the feed's own heartbeat,
   an answered-in-round check and a positive-answer check — implemented in
   `ChainlinkOracleAdapter`.
2. A `maxMoveBps` inter-block band enforced by the deployer's own watcher, or a
   TWAP sanity band in front of the adapter (not implemented here; a designed
   addition, not a shipped one).
3. Caps (`borrowCap`, `depositCap`) sized so that a bad print cannot move enough
   value to matter in one block.

`OracleGuard.check` exists as a library for exactly this band; it is **not**
wired into the market yet, deliberately: a hard band would block accrual during a
real gap, which is when the mechanism is needed most. The right place for it is
the adapter, not the market.

## 5. Invariants an auditor should try to break

| id | statement | where it is enforced | how it was tested |
|---|---|---|---|
| I1 | `S = V·WAD − c·D ≥ 0` after any market transition | `_chargeRent` cap, `_deleverage` cap, `withdrawCollateral` gate | campaign A: 300 randomised materialisations, exact accounting to 0 wei |
| I2 | `S` never falls except by `c × rent` | same | campaign A: `|S' − (S − c·rent)| ≤ 0` |
| I3 | two pokes in one transaction = one poke | `if (dt == 0) return` | `PokeProbe`, delta 0 |
| I4 | `assets() = cash + loans + inventoryValue()` | definitions | campaign D, exact equality |
| I5 | `rho ∈ [minBid, rhoCap]`, and `sign(Δrho) = sign(imbalance)` | `updateRho` | campaign C: 120 updates, 0 sign violations |
| I6 | a bid below the clearing rent is not in `coveredDebt` | `_relevelCovered`, `_book` | campaign C |
| I7 | the flow never pays more than the collateral it takes | `x ≤ V·WAD/c` | campaign A (this is finding F1) |
| I8 | no bad debt hides: a shortfall is booked the block it is observable | `writeOff` | campaign E |

## 6. Out-of-scope but load-bearing assumptions

- `k`, `target`, `c`, `idleFloor` are chosen so that the flow can outrun
  ordinary volatility. With `k = 365` the gap closes in about a year; a shock
  faster than that is handled by the *price*, not the flow, and shows up as
  `writeOff`. This is a parameter-design question, not a code question.
- Underwriters are assumed unlevered. If lenders borrow against their shares
  elsewhere, `6.1(d)` of the paper applies and the feedback can invert.
