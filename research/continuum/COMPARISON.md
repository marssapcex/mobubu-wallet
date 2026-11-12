# Aave v4 vs Continuum — measured, not estimated

Cloned `aave/aave-v4` at commit `8be3e0d` ("feat: Add BabylonSpoke"), shallow.
Counts are code lines (non-blank, non-comment) from a single script for both
sides; `src/dependencies` (OpenZeppelin, Solady, WETH) is excluded from Aave's
"production" figure and reported separately, because Continuum writes its own
ERC20 and has no dependency at all.

## Size

| | Aave v4 | Continuum (`protocol/src`) | ratio |
|---|---|---|---|
| Solidity files (prod) | 123 | 4 | 31× |
| Code lines (prod) | 11,188 | 642 | **17.4×** |
| Comment lines | 4,360 | 187 | 23× |
| Contracts / libraries / interfaces | 56 / 36 / 31 | 2 / 2 / 0 | — |
| Functions | 1,135 | 66 | 17× |
| Structs | 91 | 2 | 18× |
| Storage mappings | 58 | 5 | 10× |
| Events / custom errors | 53 / 102 | 15 / 20 | — |
| Deployed bytecode | 56 contracts, each near the 24 KB limit | 1 contract, **13,736 B** | — |

Tests and verification:

| | Aave v4 | Continuum | ratio |
|---|---|---|---|
| Test files | 300 | 4 (+6 harness scripts) | — |
| Test code lines | 67,383 | 262 Solidity + 932 JavaScript | 55× |
| Test functions | 2,089 | 31 + 5 campaign scripts | 58× |
| External audit reports | 11 PDFs | 0 (14 self-audited findings) | — |
| Dependency code | OZ 9,032 + OZ-upgradeable 955 + Solady 252 + WETH 754 | 0 | — |

## Arithmetic

Operator density (multiplications/divisions plus WAD/RAY/BPS constant uses per
code line):

| | ops | code lines | density |
|---|---|---|---|
| Aave v4 `src` | 1,220 | 11,188 | 0.109 |
| Continuum production | 76 | 642 | 0.118 |
| Continuum prototype | 148 | 739 | 0.200 |
| Continuum verify harness | 302 | 932 | 0.324 |

So per line they are the same order — Continuum slightly denser, its prototype
twice as dense. In total Aave has ~16× more arithmetic, which is just its 17×
size: the arithmetic is spread, not concentrated.

What Aave's arithmetic actually is: fixed-point hygiene. Its entire math library
is 304 lines — `WadRayMath` 128, `MathUtils` 82, `PercentageMath` 47,
`SharesMath` 47 — plus an index/waiting-rate accrual and a liquidation bonus
interpolated between `minLiquidationBonus` and `maxLiquidationBonus` across the
health-factor range. Competent, standard, and shallow: no invariant is stated
anywhere, and none is proved.

## Where the difficulty sits

**Aave's complexity is breadth.** 56 contracts, a config engine, hubs, spokes,
position managers, tokenization, deployment orchestration, 58 storage mappings,
a 324-line governance payload, 11 audits. Its hardest file,
`spoke/libraries/LiquidationLogic.sol` at 673 code lines, is a state machine over
*configuration*: close factor, bonus ramp, collateral selection, dust thresholds,
per-asset flags. None of it is mathematically deep; all of it is combinatorially
wide, and "liquidat" appears 399 times in `src`.

**Continuum's complexity is depth on one axis.** 497 code lines in the market,
but the claim is global: no reachable state satisfies `S < 0`. That is not
provable by adding unit tests — 2,089 test functions would not establish it —
which is why the proof footprint (Lean 156 lines / 10 theorems, 1,440 lines of
Python, 932 lines of harness, 122,760-state grid, 23 SMT theorems on two solvers)
is ~4× the production code. Aave's tests are 6× its production code and prove
nothing global; they check behaviour.

## Verdict, honestly

- **Longer:** Aave v4, by an order of magnitude — 17× production code, 55× test
  code. Not close.
- **Heavier mathematically:** Aave carries more arithmetic *volume*, Continuum
  carries more mathematical *content*. Aave has no theorem to prove and does not
  claim one; Continuum's entire argument is a theorem, on 150 lines of algebra.
  Per line they are equally dense; in kind they are not the same discipline.
- **More complex:** Aave, on every engineering axis — surface area, configuration,
  integration, operational, audited. Continuum is more complex *to verify*, which
  is a different and narrower difficulty.

The comparison is not embarrassing in either direction: Aave v4 is a protocol
with an industry-wide integration surface, Continuum is one mechanism with a
proof obligation. What Continuum lacks — governance, per-asset configuration,
multi-market, position NFTs, a deployment pipeline — is exactly what makes Aave
17× bigger, and none of it is what makes a lending market safe.
