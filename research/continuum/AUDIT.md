# Audit log — Continuum

Three revisions, seven findings. Revision 1 was the prototype described in
`PAPER.md`. Revision 2 fixed the three findings a first read of the contract
produced. Revision 3 is the one on disk now: it adds four findings that only
appeared once the contract was exercised on an EVM against a real lending
market, and it adds the integration itself.

Every finding below is (a) an attack or a divergence with a concrete mechanism,
(b) fixed in `src/Continuum.sol` or `src/AaveV4Buffer.sol`, and (c) pinned by a
regression that runs: `verify/audit.cjs`, 8/8 held.

| id | finding | class | regression |
|----|---------|-------|------------|
| B1 | a borrower who repays and re-borrows was pushed into `borrowers[]` twice, so the demand book counted the same debt twice and `rho` over-read demand | accounting | `B1` |
| B2 | `setRho` re-scanned every borrower to rebuild the demand book: O(n) inside a permissionless function, gas griefing | DoS | `B2` |
| B3 | `effectiveAsk` was the last ask written, so one wei of capital set the ask for the whole book; a bid could be repriced in the same block it was made | manipulation | `B3`, `B3b` |
| B4 | `open` overwrote `coll`, so a borrower who repaid and reopened lost the collateral still posted | loss of funds | `B4` |
| B5 | rent fell into `underCash` and was never claimable by the suppliers who carried the risk; and a supplier's un-realised rent was discarded on the next supply/withdraw | loss of funds | `B5` |
| B6 | the feedback step was `eta * (D - S)` with `D`, `S` in **notional**, while every theorem (T7, T7b, T8) assumes a **ratio**: any book above a few hundred dollars saturated `rho` at the cap on the first call, and `eta` stopped meaning anything | model ≠ code | `B6` |
| B7 | `coveredDebt` is a step function of `rho`, so its slope is unbounded; the unclipped `eta` step limit-cycled across the whole book — rent flipped between 0 and the top bid on alternating calls | instability | `B7`, T13 |

B6 and B7 are the interesting ones: neither is an exploit, and neither would
have been found by reading the contract. Both are the same failure — the code
was not the object the paper proved theorems about. B6 made the *scale* of the
book part of the law; B7 made the *resolution* of the book part of the law. The
fixes make the code the object:

```solidity
// B6: the theorem's z is a ratio in [-1, 1]
int256 z = imbalance();                       // (D - S) / max(D, S), WAD

// B7: the book resolves to one bucket of 64, so the step cannot exceed half of one
int256 cap = int256((rhoCap + 1) / BUCKETS / 2);
```

With those two, `rho` converges monotonically into a band no wider than
`rhoCap / 64` = 15.6 bp/yr at the deployed cap, and stops there. That band, not
a point, is what T13 proves: `T13a` no overshoot from below, `T13b`/`T13b2` band
invariance, `T13c` the approach is monotone. Measured on the EVM: amplitude
0.000781/yr over 50 calls after convergence, max step 0.000781, bucket 0.001563.

## What is NOT fixed, and is not a bug

`AaveV4Buffer.writeOff` has no consent and no owner: if the Spoke reports
`healthFactor < 1`, anyone can mark the principal dead. That is deliberate — the
loss is a fact in the Spoke's state, not a judgement, and delaying it only makes
the NAV a lie. The cost is that loss recognition can be triggered at the worst
moment for the *reported* NAV; it cannot be triggered falsely, because the read
comes from the Spoke.

---

# Integration — Continuum in front of Aave v4

Aave v4 is BUSL-1.1, so this is an arm's-length integration, not a fork:
`src/AaveV4.sol` declares the surface (`ISpoke`, `UserAccountData` in the exact
member order of `aave/aave-v4` `src/spoke/interfaces/ISpoke.sol:129-137`), and
`src/AaveV4Math.sol` is an MIT re-expression of the two functions that decide
what a liquidation *costs* (`LiquidationLogic.sol:312` bonus ramp and
`LiquidationLogic.sol:795` target-HF sizing) so the benchmark cannot drift from
Aave's arithmetic.

`src/AaveV4Buffer.sol` is the mechanism applied to a position that lives on a
real Spoke:

* the borrower `register()`s — consent is the only admission rule, because a
  cover is a debt the borrower owes the pool;
* anyone may call `cover(user, cap)`. It is a pure function of `(healthFactor,
  elapsed time)`, so it pays no keeper and cannot be raced: a second call in the
  same block pays 0;
* while `HF < hfFloor` (1.30 in the fixture, always **above** Aave's hard gate at
  1.0) the buffer repays the Spoke on the borrower's behalf, up to `hfTarget`
  (1.50), at par — no bonus is transferred anywhere;
* the borrower pays rent at the pool's own `rho`, from the same feedback law as
  the paper, capped by `rhoCap`;
* if the price gaps through, the buffer has no seizure right and no
  `liquidationCall`: it writes the principal off and the underwriters eat it,
  visibly, in proportion to shares.

## Measured, on an EVM, against Aave v4's own arithmetic

`npx hardhat run verify/aave.cjs` — 10 WETH at 2000 (20,000) against 14,000 USDC,
collateral factor 80%, target HF 1.5, max bonus 15%, mark walks 1950 → 1600 over
eight weeks:

| path | what happens | cost to the borrower |
|------|--------------|----------------------|
| Aave alone | HF reaches 0.9143 at mark 1600 → liquidation fires | **$820** of collateral destroyed in one block (15% bonus on 5,467 of covered debt) |
| Continuum buffer | HF never below 1.3077; 5,200 of debt repaid at par, rent 0.94%/yr | **$7.48** of rent over 56 days, plus a loan of 5,200 that the borrower still owes |

The honest reading: the buffer does not make the 820 disappear, it converts a
*fee* into a *loan plus rent*. The borrower is better off if the mark recovers
within a few months; worse off if it does not, because the 5,200 is still debt.
That trade is the product, and it is why the rent is priced by demand rather
than set by governance parameter.

The tail is measured too, not asserted: at mark 400 with a 6,000 pool, HF falls
to 0.4, and `writeOff` removes the entire 6,000 — 100% of NAV, no socialization,
no bad-debt token, no insurance fund to raid.

## Lean

The Lean 4 artifact (`lean/Continuum.lean`) is still not compiled, and after
this round it is fair to say it cannot be, here:

* every `release-assets.githubusercontent.com` route fails at TLS
  (`SSL_ERROR_SYSCALL`) — release URL, API asset endpoint by id, ranged request,
  API-by-id. That is the only host Lean binaries live on.
* `codeload.github.com` works, so `lean4` v4.9.0 **source** was fetched
  (22,768,229 B). Source alone cannot bootstrap: Lean 4 is self-hosted and needs
  a prebuilt stage-0, which lives on the blocked host.
* `leanprover/lean4-stage0` does not exist (checked over `git ls-remote`).
* no PyPI package ships the toolchain (the full simple index was scanned:
  `lean4`, `lean4check`, `leanclient`, `lean-dojo`, … are clients or unrelated),
  and the npm `lean4` package has zero versions.

So the mathematical content is discharged the other way, and the count went up
in this round: 23 theorems, Z3 5.4.1 and cvc5 1.4.2 agreeing on every one, plus
the 122,760-state integer grid. `lean/Continuum.lean` stays in the tree labelled
unverified — it is a specification, not evidence.

## Reproduce

```bash
cd research/continuum
python3 -m venv .venv && ./.venv/bin/pip install z3-solver cvc5 sympy numpy
cd verify && npm i solc@0.8.24 hardhat @nomicfoundation/hardhat-ethers ethers
mkdir -p lib && curl -sSL https://codeload.github.com/foundry-rs/forge-std/tar.gz/refs/tags/v1.9.7 | tar xz -C lib && mv lib/forge-std-1.9.7 lib/forge-std
node compile.mjs                 # solc 0.8.24, all of src/ and test/
npx hardhat run run.cjs          # the five mechanism campaigns
npx hardhat run audit.cjs        # B1-B7 regressions
npx hardhat run aave.cjs         # buffer vs liquidation, on Aave v4's math
cd .. && ./.venv/bin/python verify/proofs.py   # 23 theorems, two solvers
```
