# Verification status — read before quoting anything in this folder

This file exists because the honest status of each artefact differs, and a
document about formal verification that blurs that distinction is worse than no
document.

## What is machine-checked

| artefact | check | result |
|---|---|---|
| `src/Continuum.sol` | `solc 0.8.24` via `verify/compile.mjs` | 0 errors, 0 warnings at error severity, **4,902** deployed bytes |
| `test/Continuum.t.sol` | same compiler, forge-std 1.9.7 | 0 errors; fuzz + handler + invariant suite compiles |
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
| `lean/Continuum.lean` | **written, never compiled** (content cross-validated by the SMT suite above) | no `lean`/`lake`/`elan` in the environment; `leanprover/lean4` and `elan` release assets are blocked at `release-assets.githubusercontent.com` (curl: `SSL_ERROR_SYSCALL`), so no toolchain could be bootstrapped. `npm` and `pypi` were tried and have no Lean 4 distribution. |
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

node compile.mjs          # compile both sources
npx hardhat run run.cjs   # execute the four property campaigns on a real EVM
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
