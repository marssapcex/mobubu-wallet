# Findings — self-audit (pre-external)

Basic audit performed while writing the code, and the harness that found each
one. Severity is stated as an auditor would need it: what breaks, who loses, and
whether the invariant or the accounting is the casualty. **This is not a
substitute for the external audit**; it is the list an external auditor should
start from, with the ones already closed marked as such.

Status legend: **fixed** (code changed, regression added), **mitigated**
(parameter or design constraint, documented), **accepted** (known, bounded, and
cheaper to live with than to fix in v1).

---

## F1 — the flow could take less collateral than it paid for · High · fixed

`_deleverage` capped the seized units by the position's remaining collateral:

```solidity
seized = unitsForValue((c * x) / WAD, p0, ...);
if (seized > p.coll) seized = p.coll;   // <-- the bug
```

When the cap bound, the pool paid `x` of debt but received less than `c·x` of
collateral, so `S' = S + (c·x − seizedValue) < S`. On a near-empty position this
made the surplus negative — observed in campaign A as `S = −1.26 USDC` — which is
the one thing the mechanism must never do by itself.

**Fix:** cap the *debt* instead of the collateral: `x ≤ V·WAD/c`, so
`seizedValue ≤ V` and the seizure can never exceed what exists. `S' ≥ S` holds
by construction, and campaign A now reports `|S' − (S − c·rent)| ≤ 0 wei`.

## F2 — the buffer line was evaluated with a floored division · Medium · fixed

`surplus` and `rentCap` computed `c·D/WAD` first. The floor let the line sit up to
one unit below its true value, so a rent exactly at its cap could leave
`S = −1 wei`. Small, but it is the invariant: a `−1 wei` surplus is a broken
proof, and the regression that checks the invariant would have to tolerate it
forever.

**Fix:** compare on one numerator — `V·WAD` against `c·D` — so there is no
division and therefore no rounding. `rentCap = (V·WAD − c·D)/c` is then exact:
`c·(D+r) ≤ V·WAD` by construction.

## F3 — the flow is only as strong as idle cash · High · mitigated by design

The flow pays debt at par using the pool's *idle* cash. At 100% utilisation there
is no protection at all, and a price gap becomes bad debt immediately. The
mechanism's promise is a liquidity promise, and a lending market that lends out
everything cannot keep it.

**Mitigation:** `idleFloor` (default 20% of debt) is enforced in `_borrowGates`.
At `target = 1.20`, `c = 1.02`, a fall to the buffer line costs about
`(1 − c/target) ≈ 15%` of debt, so 20% idle is the number that makes the
protection deliverable. **Residual risk:** a gap larger than the idle cushion,
which is what `writeOff` is for.

## F4 — NAV marks inventory at the oracle · Medium · accepted

`assets()` values the pool's collateral inventory at `price()`. A stale or
manipulated print moves NAV, and therefore the share price. Alternatives (TWAP,
haircut, last-sale) all trade one distortion for another; the honest answer is
that the pool holds spot risk and reports it at the best available number.

**Mitigation:** inventory only ever enters through the flow at a 2% discount, so
a mark error costs at most that discount plus the mark error, and `buyInventory`
lets anyone arbitrage the inventory back to cash at the mark.

## F5 — `writeOff` reads the oracle and is permissionless · Medium · accepted

A manipulated *low* print lets anyone force a write-off. The loss is real only if
the print is real, because `writeOff` transfers the collateral to inventory at
the same mark — a false write-off is a false NAV drop, not a withdrawal of funds.
The attack is therefore a griefing/NAV-distortion attack, bounded by the oracle
problem above.

**Mitigation:** the write-off path is the same code path the market uses for real
gaps. Removing permissionlessness would make bad debt hideable, which is worse.

## F6 — first-depositor share inflation · Low · mitigated

`previewDeposit` uses `(amount × (supply + 1))/(assets + 1)`, the virtual-offset
construction. An attacker who mints 1 wei of shares and donates a large amount
raises the floor but cannot make a later depositor receive 0 shares; the test
`test_donationAttackDoesNotInflateShares` asserts the resulting shares stay sane.

**Residual:** rounding dust accrues to the incumbent holders. Bounded by 1 wei
per operation.

## F7 — bucket boundary at `bid == rho` · Low · accepted

The demand book buckets bids; a bid exactly equal to the clearing rent can land
in a bucket whose lower bound is below `rho`, so it is counted as *not* covered.
This is conservative (demand is under-read by at most one bucket, i.e. 15.6 bp of
rent), and it is the same resolution that makes the step law stable (B7 in
`../../AUDIT.md`).

## F8 — role and cap management · Informational

`riskAdmin` is a single address with a single-step handover. It cannot move funds
or change the mechanism, but it can freeze borrowing and set caps to zero. Before
deployment: two-step transfer plus a timelock, and the role should be a
multisig. Not fixed here because it is a governance decision, not code.

---

## Round 2 — findings F9 to F14 (audit continuation)

### F9 — stale NAV let a fresh depositor capture rent that was not theirs · High · fixed

The rent is accrued lazily per position: `loans` only grows when somebody calls
`poke`. With no keeper — which is the design — nobody is *paid* to poke, so the
book can sit unaccrued for months. `assets()` read `cash + loans + inventory`,
so NAV understated what was owed, and a depositor who arrived after a long silence
bought shares cheaply, poked, and exited with other people's rent.

Measured before the fix (`verify/attack.cjs`, 180 idle days, 74,000 of debt):
the attacker deposited 100,000 and redeemed 100,000 plus a share of the ~365 of
accrued rent.

**Fix:** an aggregate accrual that does not need a keeper.
`rateMassAbove` / `rateMassFixed` maintain `rate = A + rho·M` in O(1), and

```solidity
assets() = cash + loans + inventoryValue() + pendingRent()
pendingRent() = unbookedRent + rateDebt() * elapsed / YEAR
```

After the fix the same attack returns **0.000011 USDC** — rounding dust — and
the incumbent lender's 100,000 shares are worth 100,364.93, which is exactly the
rent they earned. A test now asserts the property directly:
`test_sharePriceRisesWithoutAnyTransaction` requires NAV to rise with time alone,
and to be unchanged by the poke that materialises it.

### F10 — the first version of the fix was wrong, and the differential test caught it · High · fixed

The first implementation recomputed all 64 buckets whenever `rho` moved (correct,
212k gas). The "optimisation" that followed — adjusting only buckets whose upper
edge lies between the old and new rent — was based on a wrong derivation: the
rate per bucket is `min(rho, upper)`, so **every bucket above the rent** changes
rate when the rent moves, not just the one being crossed. Measured drift:
697,171,234 in `rateDebt` after 30 updates, i.e. NAV priced off a fiction.

The drift was found by F14's differential check, not by reading the code. The fix
is the `A + rho·M` split: buckets below the rent are fixed at their edge, buckets
above contribute `rho`, so a rent move reclassifies exactly the one bucket it
crosses. Drift after the fix: **0**.

This is worth recording as a process fact: the second bug was introduced by the
fix for the first, and only the invariant test caught it.

### F11 — oracle reentrancy · checked, not exploitable

`price()` is an external call made from inside `_materialise`, before `_syncBook`
has run, and `poke` carries no `nonReentrant`. A hostile feed would therefore be
able to run market code in the middle of an accrual.

It cannot: `IOracle.price()` is declared **`view`**, so Solidity emits
STATICCALL, and any state change inside the callback reverts in that static
context, with the failure swallowed exactly as `_materialise` expects.
`ReentrantOracle` is armed with `updateRho()` and the market is poked; the rent
does not move. The `view` declaration is load-bearing security, and a future
refactor that makes the oracle interface non-view (a proxy, an adapter that
writes a cached price) would silently remove it.

### F12 — the demand book must equal the positions · invariant, holding

`coveredDebtStored` is maintained incrementally (`_book`, `_unbook`,
`_relevelCovered`) and is what the rent law prices off. A differential check
against a full recomputation from the positions, over 40 rent updates, shows a
drift of **0**.

### F13 — gas of the accrual aggregate · measured

| call | gas |
|---|---|
| `poke` | 89,831 |
| `updateRho` | 74,953 |
| `deposit` | 93,243 |
| `withdraw` | 84,851 |
| `borrow` | 133,847 |

`updateRho` was 212,409 while the aggregate was resynced over all 64 buckets, and
it is back to 74,953 with the `A + rho·M` split. It is permissionless and unpaid,
so 75k gas is the price of anyone who wants the rent to move.

### F14 — rounding in the aggregate · bounded, 0 observed

`rateMassFixed` is accumulated per position (`amount × edge / WAD`), while a
reclassification moves a per-bucket quantity (`mass × edge / WAD`); the two can
differ by one wei per position. Measured drift over 30 updates: **0**. The
differential check stays in the harness so a future change that breaks it cannot
ship quietly.

---

## Regression map

| finding | pinned by |
|---|---|
| F1 | `verify/protocol.cjs` campaign A (exact `S` accounting, 0 wei drift) |
| F2 | campaign A (`|S' − (S − c·rent)| = 0`) |
| F3 | `_borrowGates` + campaign A band (idle floor 20%) |
| F4 | campaign D (assets decomposition, exact) |
| F5 | campaign E (write-off reduces NAV by exactly the shortfall) |
| F6 | `test_donationAttackDoesNotInflateShares` |
| F7 | campaign C (bid priced out of the book once `rho` clears it) |
| F8 | out of code scope |
| F9 | `verify/attack.cjs` F9 (attack returns dust after the fix) + `test_sharePriceRisesWithoutAnyTransaction` |
| F10 | `verify/attack.cjs` F14 (aggregate drift 0) |
| F11 | `verify/attack.cjs` F11 (armed feed, rent unchanged) |
| F12 | `verify/attack.cjs` F12 (book drift 0) |
| F13 | `verify/attack.cjs` F13 (gas table) |
| F14 | `verify/attack.cjs` F14 |

## What an external auditor should attack first (updated after round 2)

0. **The claim that NAV is continuous.** `assets()` now contains an estimate of
   accrued rent (`A + rho·M`). Try to make it lie in either direction: a position
   whose rent cap binds (distress) accrues less than the estimate; a bucket edge
   is used instead of the exact bid. Quantify the error and decide whether a
   depositor can still time an entry.


1. **Rounding in every path**, not just the two already found. The pattern that
   produced F1 and F2 is "floor a division, then compare" — look for it in
   `_chargeRent`, `_deleverage`, `previewDeposit`, `previewRedeem`, `withdraw`.
2. **The demand book's incrementality.** `_book`, `_unbook`, `_syncBook` and
   `_relevelCovered` must agree with a full recomputation at all times. A
   differential test against a naive O(n) recomputation is the right tool and is
   not yet written.
3. **`_relevelCovered` boundaries.** It assumes one step moves at most half a
   bucket. If `eta` or `rhoCap` is configured so that a step crosses two buckets,
   the cached `coveredDebtStored` desynchronises and the rent law operates on a
   stale book. The parameter check `stepCap = rhoCap/64/2` is what enforces it;
   verify that no path can move `rho` further (e.g. a future admin setter).
4. **Oracle direction asymmetry** (§4 of `SCOPE.md`): a high print is the
   dangerous one, and nothing in this code defends against it.
5. **Liquidity promises.** `withdraw` reverts rather than queue. Confirm that
   front-ends do not present shares as instantly redeemable; that is a
   communication failure with real bank-run consequences.
