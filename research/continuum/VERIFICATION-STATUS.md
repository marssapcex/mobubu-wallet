# Verification status — read before quoting anything in this folder

This file exists because the honest status of each artefact differs, and a
document about formal verification that blurs that distinction is worse than no
document.

## What is machine-checked

| artefact | check | result |
|---|---|---|
| `src/Continuum.sol` | `solc 0.8.24` via `verify/compile.mjs` (audit revision 3) | 0 errors, **7,213** deployed bytes |
| `src/AaveV4Buffer.sol`, `src/AaveV4Math.sol`, `src/mocks/*` | same compiler | 0 errors; the Aave v4 integration and its fixtures compile |
| `test/Continuum.t.sol` | same compiler, forge-std 1.9.7 | 0 errors; fuzz + handler + invariant suite compiles |
| **`protocol/src/ContinuumMarket.sol`** | solc 0.8.24, no `viaIR` | 0 errors, **12,510** deployed bytes (fits the EIP-170 limit with 12 KB to spare) |
| **`protocol/test/ContinuumMarket.t.sol`** | same compiler | 0 errors; 17 tests incl. two fuzz targets, forge-std only |
| **`protocol/script/Deploy.sol`** | same compiler | 0 errors |
| **shipping market, executed** | `verify/protocol.cjs`, 5 campaigns | all held: S accounting exact to 0 wei over 300 randomisations, 0 negative states, idempotent poke (delta 0), 0 sign-law violations in 120 rent updates, assets decomposition exact, bad debt booked exactly |
| audit findings B1–B7 | `verify/audit.cjs` | **8/8** regressions held (double count, O(1) `setRho`, one-wei ask, reopen, rent forfeiture, scale, limit cycle) |
| buffer vs liquidation, on Aave v4's own arithmetic | `verify/aave.cjs` | HF min 1.3077 with the buffer vs 0.9143 without; $7.48 rent vs $820 bonus on the same deleverage; tail writes off 100% of NAV |
| invariant P1 — buffer line `V ≥ c·D` preserved | `verify/run.cjs` campaign A | 1,000 randomised `(mark, dt, rent)` steps, **0 violations** |
| invariant P3 — `health > 1` always (liquidation predicate unreachable) | campaign A | **0 liquidatable states** |
| invariant P2 — health strictly rises while distressed | campaign B | 400/400 distressed accruals strictly positive |
| rent law — `sign(Δρ) = sign(excess demand)` and `ρ ∈ [0, ρ_max]` | campaign C | 60/60 steps, 0 violations, sign flips correctly when capital arrives |
| shock recovery | campaign D | −10% mark: `h 1.25 → 1.125 → 1.200` with 0 keeper calls |
| rent conservation | campaign E | 30 days at `ρ = 0.10/yr`: rent booked 131.5094, surplus fell by exactly that amount (residual 0.000000), buffer line intact |

## What is machine-checked by SMT (two independent solvers)

`verify/proofs.py` asserts hypotheses ∧ ¬goal and reports `unsat` as proved.
Z3 5.4.1 (`nlsat`, complete for QF_NRA) and cvc5 1.4.2 (independent
implementation) both discharge every statement; they agree on all 19.

```
19 rows (18 SMT theorems + 1 exhaustive grid): 0 counterexamples, 0 unknown,
0 solver disagreements.  I4-grid: 122,760 integer states, 0 violations.
```

| group | statements |
|---|---|
| algebra | T1 buffer neutrality, T2 no bad debt, T3/T3b health monotone, T4 spiral boundary, T5 empty liquidation domain, T6 gap contraction, T9 rent conservation, T10 health identity, T11 debt monotone, T12 drift equilibrium |
| control | T7/T7b contraction bound, T8 no overshoot |
| refinement | I1–I3 floor bounds, I4 exact integer step |
| exhaustive | I4-grid over the bounded integer domain with truncating division |

**Two theorems were false as first written and the solvers found counterexamples.**
Both are corrected in `PAPER.md` §3.4 and §6.5; the corrections are part of the
result, not an embarrassment to be sanded off. Reproduce:

```bash
python3 -m venv .venv
./.venv/bin/pip install z3-solver cvc5 sympy numpy
./.venv/bin/python verify/proofs.py --smt2      # also writes verify/smt/*.smt2
./.venv/bin/python verify/ode_study.py
```

The `.smt2` files are auditable with any SMT-LIB2 front end:
`z3 verify/smt/T5.smt2` prints `unsat`.

## What is NOT machine-checked

| artefact | status | why |
|---|---|---|
| `lean/Continuum.lean` | **written, never compiled** (content cross-validated by the SMT suite above) | the toolchain is unreachable, and this was closed out properly this round: release assets fail at TLS on `release-assets.githubusercontent.com` under four separate routes (release URL, API asset id, ranged request, API-by-id); `codeload` works so `lean4` v4.9.0 **source** was fetched (22,768,229 B), but Lean is self-hosted and the stage-0 binary lives on the blocked host; `leanprover/lean4-stage0` does not exist; the whole PyPI simple index was scanned and no package ships the toolchain; the npm `lean4` package has zero versions. |
| `incentive_compatibility` | **admitted, and false in general** | needs Mathlib `MeasureTheory`; and the statement fails outside the unlevered-underwriter assumption (death vector 6.1(d)). |
| `continuous_liveness` | **not attempted** | needs the reals + topology + an ODE comparison lemma. Discrete shadow is proved and executed. |

Because the Lean file could not be compiled, it was written under a self-imposed
constraint: **core Lean 4 only, no Mathlib, `Int` arithmetic only, and `omega` as
the only load-bearing tactic.** The proof terms are deliberately small and every
rewrite names its lemma (`Int.sub_mul`, `Int.mul_sub`, `Int.mul_pos`,
`Int.mul_nonneg`, `Int.mul_lt_mul_of_pos_left`, `Int.one_mul`). This maximises the
chance that it checks on first contact with a toolchain; it does not substitute
for running one.

Known risk points if a compiler reports errors, in the order I would expect them:

1. `Int.mul_lt_mul_of_pos_left` argument order — if it errors, replace the proof
   of `rent_falls_with_shortage` with `have h := Int.mul_neg eta z` plus `omega`.
2. `simpa` in `rent_falls_with_shortage` — replace with `rw [Int.mul_zero] at h`.
3. `show` statements in `delever_preserves_buffer` / `rent_preserves_buffer` — if
   the `show` term does not match, delete it and let `unfold … <;> omega` work.
4. `omega` availability — it is core in recent Lean 4; on an old toolchain
   replace the linear goals with explicit `Int.sub_le_sub_right` / `Int.le_add_of_sub_le`
   chains.

## Reproduce

```bash
cd research/continuum/verify
npm i --no-audit solc@0.8.24 hardhat@^2 @nomicfoundation/hardhat-ethers@^3 ethers@^6
mkdir -p lib && curl -sSL https://codeload.github.com/foundry-rs/forge-std/tar.gz/refs/tags/v1.9.7 \
  | tar xz -C lib && mv lib/forge-std-1.9.7 lib/forge-std

node compile.mjs          # compile all of src/ and test/
npx hardhat run run.cjs   # the five mechanism campaigns
npx hardhat run audit.cjs  # B1-B7 regressions
npx hardhat run aave.cjs   # buffer vs liquidation, on Aave v4's arithmetic
npx hardhat run protocol.cjs  # the shipping market: 5 campaigns, invariants + tail
```

With a real Foundry install instead:

```bash
cd research/continuum
forge install foundry-rs/forge-std
forge test -vv            # fuzz (2048 runs) + invariant (256 runs × depth 64)
```

## Claims in README.md that are argument, not proof

- No-cascade: the flow removes forced selling, which removes the amplification
  channel. Argued from the mechanism's shape; **not** proved, and it needs a
  market-impact model to be proved.
- The manipulation-cost argument in §6.2: derived from the flow being `O(dt)`.
  The algebra is right; the empirical part (that 16 hours of sustained
  manipulation is implausible) is a judgement.
- Every DeFiLlama figure. Read live on 2026-11-12; `data/defillama-2026-11-12.md`
  is the snapshot.
