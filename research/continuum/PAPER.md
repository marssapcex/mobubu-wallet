# Continuum: Deleting the Liquidation Event

**A mechanism note with machine-checked proofs**

Draft — 2026-11-12. Companion to `README.md` (mechanism + red team) and `VERIFICATION-STATUS.md` (what is checked by what).

---

## 0. Abstract

A collateralised loan position contains one discrete, indivisible, adversarially-timed event: the liquidation. We show that the event is not economically necessary. Decomposing a position into a *buffer line* `L = cD` and a *buffer surplus* `S = V − L` yields the identity `h = V/D = c + S/D`, from which it follows that a transfer of collateral priced at `c` per unit of debt retired is **exactly buffer-neutral** while strictly reducing debt. Health is therefore a function of `D` alone once `S` is fixed, and a proportional flow on the distress gap is a negative feedback loop with a closed-form solution. Under the invariant `S ≥ 0` the predicate `V < D` is unsatisfiable, so liquidation has an empty domain rather than an unfavourable price.

The mechanism prices the buffer continuously (a two-sided tâtonnement on a rent `ρ`), pays underwriters a discovered spread instead of a keeper bonus, and requires no auction, no settlement and no privileged caller. Nineteen statements — the algebraic core, the stability bounds, and the WAD-scaled integer refinement — are machine-checked by two independent SMT solvers (Z3 5.4.1 `nlsat`, cvc5 1.4.2) plus an exhaustive 122,760-state integer check. Two of those statements were **false as first written**; the solver produced counterexamples and the statements below are the corrected ones. That correction is reported, not hidden (§5.2, §6.4).

---

## 1. Model

### 1.1 State

A position is a triple `(V, D, c) ∈ ℝ³` — collateral value, debt, buffer-line
multiplier — together with a mark `P` that is exogenous to the mechanism.

```
buffer line      L  = c·D                       c = 1 + ε,  ε > 0
buffer surplus   S  = V − L
health           h  = V/D
distress gap     g  = tgt·D − V                 tgt > c
```

The implementation carries these as WAD-scaled integers (1e18), and every
division is truncating. §6 closes that gap formally rather than by tolerance.

### 1.2 Transitions

Two flows, both linear in elapsed time `dt`, and three user actions.

```
payRent(r)   : (V, D) ↦ (V − r, D)              r ≤ S         [rent, flow 1]
delever(x)   : (V, D) ↦ (V − c·x, D − x)        x ≤ D         [absorb, flow 2]
borrow(y)    : (V, D) ↦ (V, D + y)              c·y ≤ S       [user]
repay(y)     : (V, D) ↦ (V, D − y)              y ≤ D         [user]
price(P→P')  : V ↦ V·P'/P                                     [exogenous]
```

The flow rate is state feedback, not a parameter:

```
x/|dt|  =  k · g / tgt          (flow 2;  capped by D and by underwriter cash)
r/|dt|  =  ρ · D                (flow 1;  capped by S)
ρ'      =  clip[0, ρ_max]( ρ + η·(Demand(ρ) − Supply(ρ)) )
```

`Demand: ℝ → ℝ≥0` is non-increasing (borrowers drop out as the rent rises),
`Supply` is non-decreasing, so `z(ρ) = Demand(ρ) − Supply(ρ)` is non-increasing
and the crossing `ρ*` is unique when it exists.

---

## 2. The accounting identity

**Definition 2.1 (buffer neutrality).** `delever` is buffer-neutral if
`S(delever(x)) = S` for all `x`.

**Lemma 2.2.** `delever` is buffer-neutral.

*Proof.*
`S' = (V − cx) − c(D − x) = V − cx − cD + cx = V − cD = S`. ∎
*Machine-checked:* **T1** (Z3 + cvc5, both `unsat`).

**Corollary 2.3 (the health identity).** `S` is a conserved quantity of the flow,
and health depends on `D` only through the buffer:

```
h = c + S/D                                                        (2.1)
```

*Proof.* `c + S/D = (cD + S)/D = (cD + V − cD)/D = V/D`. ∎
*Machine-checked:* **T10**.

Equation (2.1) is the whole mechanism. Every design decision follows from it:
a flow that reduces `D` at fixed `S` raises `h` *monotonically and without
bound*. The mechanism does not need a threshold because health is a continuous,
strictly decreasing function of `D` and nothing else.

---

## 3. Safety

### 3.1 Solvency of the flow

**Theorem 3.1 (no bad debt).** For `c > 0`, `x ≤ D` and `cD ≤ V`:

```
c·(D − x) ≤ V − c·x
```

*Proof.* `c(D−x) = cD − cx ≤ V − cx`. ∎ *Machine-checked:* **T2**.

The content: a unit of debt retired at a collateral price of `c` leaves the
*residual* position at least as over-collateralised as the original. The
underwriter cannot create bad debt inside the surface, at any mark, for any
size. This is what makes the underwriter's participation incentive-compatible
in the residual sense — and it is the assumption that §8.1 shows is fatal to
violate on the underwriter's own book.

### 3.2 The event has an empty domain

**Theorem 3.2 (no liquidatable state).** For `c > 1`, `D > 0`, `cD ≤ V`:

```
V > D
```

*Proof.* `V = cD + S > D + S ≥ D` since `c > 1`, `D > 0`, `S ≥ 0`. ∎
*Machine-checked:* **T5**. Corresponding Lean statement: `no_liquidation_predicate`.

Standard lending defines the event by the predicate `h < 1`. Theorem 3.2 says
that predicate is **unsatisfiable on the reachable set**. This is the precise
sense in which the mechanism *deletes* the event rather than re-pricing it: a
resized liquidation (Aave v4's ramped bonus, target-HF sizing) still has a
satisfiable trigger, so its event set is non-empty. Here it is empty.

### 3.3 The inductive invariant

**Theorem 3.3 (invariant preservation).** Let `S ≥ 0`. Then

1. `delever(x)` preserves it exactly, for all `x` (Lemma 2.2);
2. `payRent(r)` preserves it for all `r ≤ S` (rent is capped at `S`);
3. `borrow(y)` preserves it for all `c·y ≤ S`;
4. `repay(y)` increases it.

Hence by induction `S ≥ 0` holds on every reachable state.

*Machine-checked:* T1, T9, **I4** for the integer version including truncating
division. Note that `payRent` *decreases* `S` — rent is a drag, not a
preservation — which is exactly why it needs its own bound and why §5 derives
the region in which the flow outruns it.

**Remark 3.4 (a correction the machine forced).** The first statement of the
strict monotonicity lemma used `S ≥ 0` and was **false**: Z3 returned
`c = 2, V = 2, D = 1, x1 = 0, x2 = ½`, for which `h(x1) = h(x2) = 2` because
`S = 0` makes the gain vanish identically. The true pair is a *weak* monotonicity
under `S ≥ 0` and a *strict* one under `S > 0`:

**Lemma 3.5.** For `c > 1`, `0 ≤ x₁ ≤ x₂ < D` and `cD ≤ V`:
`h(x₁) ≤ h(x₂)`. Under `cD < V` and `x₁ < x₂` the inequality is strict.

*Proof.* `h(x₂) − h(x₁) = (x₂ − x₁)(V − cD) / ((D−x₁)(D−x₂))`, and both factors
of the denominator are positive. ∎ *Machine-checked:* **T3** (weak), **T3b**
(strict). The Lean file's `no_liquidation_predicate` was unaffected: it never
used strictness.

### 3.4 The spiral boundary

**Theorem 3.6 (when protection becomes predation).** For `x > 0`, `x < D` and
`V < cD`, deleveraging *lowers* health:

```
(V − c·x)·D < V·(D − x)
```

*Proof.* The difference is `x(V − cD) < 0`. ∎ *Machine-checked:* **T4**.

Together with Lemma 3.5 this is an equivalence at the level of sign: the flow
is stabilising **iff** `V > cD`, i.e. **iff `ε < b`** where `b` is the borrower's
relative buffer. There is no intermediate regime. This is death vector 1(a) in
`README.md`, and it is why `c` is immutable in the implementation.

---

## 4. The gap dynamics

**Theorem 4.1 (strict contraction of the distress gap).** For `x > 0`, `tgt > c`:

```
g' = tgt·(D − x) − (V − c·x) = g − x·(tgt − c) < g
```

*Proof.* Expand. ∎ *Machine-checked:* **T6**.

The gap closes at a rate proportional to `x`, and the proportionality constant
`tgt − c` is the design's *repair wedge*: the distance between the trigger and
the underwriter's cost. If `tgt → c` the flow loses all authority; this is the
quantitative reason the trigger must sit strictly above the line.

### 4.1 Continuous-time limit

Passing to continuous time with a persistent adverse drift `V̇ = −vV`:

```
ġ = tgt·Ḋ − V̇ = −k·g + v·V                                    (4.1)
```

**Proposition 4.2 (closed form).** With `g(0) = g₀` and `V(t) = V₀e^{−vt}`,

```
g(t) = [ V₀v·e^{kt} + (−V₀v + g₀k − g₀v)·e^{vt} ] · e^{−t(k+v)} / (k − v)
```

and `lim_{t→∞} g(t) = 0` for all `k, v > 0`, `k ≠ v`. The homogeneous
eigenvalue is `−k`.

*Verified symbolically* with `sympy.dsolve` and `sympy.limit` (`verify/ode_study.py`).

**Corollary 4.3.** The control loop has **no unstable parameter region**. Unlike
the discrete rent interaction (§5.2) and the accounting boundary (§3.4), the
flow itself is unconditionally stable for `k > 0`. This is a structural
consequence of feeding back on the *denominator* `D` rather than on a price.

**Corollary 4.4 (quasi-steady health under sustained drift).** Setting `ġ = 0`:

```
k·g = v·V,   g = tgt·D − V   ⟹   h* = tgt / (1 + v/k)          (4.2)
```

*Machine-checked (algebraic core):* **T12** (`tgt·D·k = V·(k+v)`).

With `tgt = 1.20`, `k = 365/yr`:

| sustained drawdown `v` | equilibrium health `h*` | deficit vs trigger |
|---|---|---|
| 0.5 /yr | 1.1984 | 0.14% |
| 1.0 /yr | 1.1967 | 0.27% |
| 2.0 /yr | 1.1935 | 0.54% |
| 5.0 /yr | 1.1838 | 1.35% |
| 20 /yr | 1.1377 | 5.19% |

A 2000%/yr sustained collapse still holds health within 5.2% of target. The flow
converts a cliff into a *lag*, and equation (4.2) is the size of the lag.

---

## 5. The rent law

### 5.1 The update is a proportional controller on a measured imbalance

```
ρ' = clip[0, ρ_max](ρ + η·z(ρ)),     z non-increasing,  z(ρ*) = 0     (5.1)
```

**Lemma 5.1 (sign).** For `η > 0`: `z > 0 ⟹ ρ < ρ'` and `z < 0 ⟹ ρ' < ρ`.
*Machine-checked:* **T8** (the composed step), plus the sign algebra in the Lean
file (`rent_rises_with_excess`, `rent_falls_with_shortage`).

**Theorem 5.2 (contraction bound).** For `0 < ηL < 2` with `L = −z'`, the
linearised map is a contraction: `−1 < 1 − ηL < 1`.

*Machine-checked:* **T7**, **T7b**. Hence `ηL < 2` is the stability bound and
`ηL = 1` is deadbeat.

**Lemma 5.3 (no overshoot).** From `ρ ≤ ρ*`, `z(ρ) ≥ 0` and
`ρ + η·z(ρ) ≤ ρ*`, one step satisfies `ρ ≤ ρ' ≤ ρ*`.
*Machine-checked:* **T8**; Lean: `tatonnement_no_overshoot`.

### 5.2 Where the loop is net-negative

One accrual changes health by the repair minus the rent drag. To first order in
`dt`, with `δ = f·tgt·D` and `S = s·D`:

```
Δh ≈ dt·[ k·f·s / tgt  −  ρ ]                                  (5.2)
```

so the loop is net-negative iff

```
ρ  <  k·f·s / tgt                                              (★)
```

Define the **margin** `M = k·f·s/(tgt·ρ_max)`. With `k = 365/yr`,
`tgt = 1.20`, `ρ_max = 0.10/yr`:

| `s` \ `f` | 0.005 | 0.02 | 0.05 | 0.20 | 0.50 |
|---|---|---|---|---|---|
| 0.005 | **0.11** | 0.44 | 1.10 | 4.38 | 10.95 |
| 0.010 | 0.22 | 0.88 | 2.19 | 8.76 | 21.90 |
| 0.050 | 1.10 | 4.38 | 10.95 | 43.80 | 109.50 |
| 0.150 | 3.29 | 13.14 | 32.85 | 131.40 | 328.50 |

**Proposition 5.4 (spiral onset).** The position is pushed *deeper* into distress
by its own protection when

```
f < f* = ρ_max·tgt / (k·s)     ⟺     ρ ≥ k·f·s/tgt
```

Numerically, for `s = 0.15`: `f* = 0.18%` at `ρ_max = 0.10/yr`, `0.91%` at
`0.50/yr`, `1.83%` at `1.0/yr` (as a fraction of the trigger value).

**Design rule.** `ρ_max` must be calibrated from the **smallest** `(f·s)` corner
the protocol admits — barely-distressed positions with the thinnest permitted
buffer — not from the stressed ones. The margin table's top-left is the only
part of the table that matters, and it is the part that looks safe if you
calibrate on the bottom-right. This is the most consequential quantitative
finding in this note, and it is not visible without writing (5.2) down.

---

## 6. Refinement to WAD-scaled integers

Everything above is over ℝ. The contract truncates. A truncated division can
only *reduce* a positive quantity, so the intuition is that rounding is safe; the
following makes that exact, with no epsilon, for the two code paths in `_accrue`.

**Lemma 6.1 (single floor).** For `a ≥ 0`, `W ≥ 1`: `(a ÷ W)·W ≤ a`.
*Machine-checked:* **I1**.

**Lemma 6.2 (rent path).** With `burn = (r·W) ÷ P` and `rem = (burn·P) ÷ W`, for
`r ≥ 0`, `W ≥ 1`, `P ≥ 1`: `rem ≤ r`.
*Machine-checked:* **I2**. This is the value actually removed from collateral;
the lemma says the borrower is never charged more rent than the flow computed.

**Lemma 6.3 (absorb path).** With `cx = c·x`, `sv = cx ÷ W`, `su = (sv·W) ÷ P`,
`vr = (su·P) ÷ W`: `vr ≤ c·x`.
*Machine-checked:* **I3**. The value released to the underwriter never exceeds
`c·x`, i.e. rounding always favours the buffer line.

**Theorem 6.4 (integer invariant, exactly).** For `c > 0`, `x ≤ D`, `cD ≤ V`,
`r ≤ V − cD`, and any `W, P ≥ 1`:

```
c·(D − x)  ≤  (V − rem) − vr
```

*Machine-checked:* **I4** (Z3 + cvc5). *Independently exhaustively checked* over
122,760 integer states with the exact truncating semantics of the Solidity
(`verify/proofs.py:grid_check`) — zero violations.

**Remark 6.5 (a second correction the machine forced).** I4 as first stated
omitted `r ≤ V − cD`, and Z3 returned `c=1, D=1, V=1, r=2, x=0`: a rent of 2 on
a position with `S = 0`. The contract caps rent at `S`, so the counterexample is
outside the code's domain — but the *statement* was wrong, and a statement that
relies on an unstated precondition is exactly the kind of theorem that produces
false confidence. The corrected I4 carries the cap as a hypothesis that matches
the `if (rentDue > s) rentDue = s;` line.

**Corollary 6.6 (the chain is closed).** Theorems 3.1–3.3 hold over ℝ; Lemmas
6.1–6.3 plus I4 show that the integer implementation's per-step transition
satisfies the same inequality. Since the invariant is inductive (§3.3), the
integer contract preserves `S ≥ 0` on every reachable state, for any sequence of
operations — not up to a wei, but exactly.

---

## 7. What is proved, by what

| # | statement | method | status |
|---|---|---|---|
| T1 | buffer neutrality | Z3 + cvc5 (QF_NRA, complete) | **proved** |
| T2 | no bad debt under the flow | Z3 + cvc5 | **proved** |
| T3 / T3b | health weak / strict monotone | Z3 + cvc5 | **proved** (corrected, §3.4) |
| T4 | spiral below the buffer line | Z3 + cvc5 | **proved** |
| T5 | liquidation predicate unsatisfiable | Z3 + cvc5; Lean `no_liquidation_predicate` | **proved** |
| T6 | distress gap strictly shrinks | Z3 + cvc5 | **proved** |
| T7 / T7b | tâtonnement contraction bound | Z3 + cvc5 | **proved** |
| T8 | no overshoot | Z3 + cvc5; Lean `tatonnement_no_overshoot` | **proved** |
| T9 | rent conservation | Z3 + cvc5; Lean `rent_preserves_buffer` | **proved** |
| T10 | `h = c + S/D` | Z3 + cvc5 | **proved** |
| T11 | flow never adds debt | Z3 + cvc5 | **proved** |
| T12 | drift equilibrium algebra | Z3 + cvc5 | **proved** |
| I1–I3 | floor-rounding bounds | Z3 + cvc5 | **proved** |
| I4 | integer per-step invariant | Z3 + cvc5 + 122,760-state exhaustive | **proved** |
| P4.2 | closed form of the ODE | sympy `dsolve` + `limit` | **verified symbolically** |
| — | invariant on 1,490 EVM steps | Hardhat/EDR execution | **holds** |
| IC | underwriter expected profit ≥ 0 | — | **admitted** (§8.1) |
| — | no-cascade | — | **argument, not proof** (§8.2) |

The Lean file (`lean/Continuum.lean`) states the same theorems in core Lean 4 and
was **not compiled** — there is no Lean toolchain in this environment. It is kept
because it is the artefact you would want in a proof assistant; the SMT suite is
the machine-checked one.

---

## 8. Assumptions ledger

Explicit, because a theorem is only as strong as the hypotheses you did not write.

**8.1 The underwriter is unlevered.** Theorems 3.1 and 3.2 give the underwriter a
non-negative residual claim *inside* the surface. If the underwriter pool is
itself a levered position on the same collateral class, it has its own buffer
line and its own flow, and a large enough shock makes it deleverage into the fall
it is meant to cushion. This is not a rounding error in the model; it is the
model's central assumption, and it must be enforced at the pool, not at the
integration.

**8.2 No cascade.** The mechanism removes *forced* selling. It does not remove
the underwriter's *voluntary* selling, and it does not remove the price impact of
that selling. The no-cascade claim is an argument from the shape of the
transition, not a theorem; a proper treatment needs a market-impact model and a
multi-agent equilibrium, neither of which is in this note. (The empirical
literature on cascades reports first-order transitions and branching ratios
below criticality, arXiv:2608.03616 — abstract only, cited as context.)

**8.3 The mark is exogenous and honest.** §3–§6 assume `V` is given. The rent is
oracle-free; the *distress measure* is not. A manipulated mark moves `V` and
therefore `g`, and §6 of `README.md` quantifies what that buys an attacker: the
extractable amount is `O(dt)`, so the profit-to-cost ratio vanishes with block
time. That is a mitigation, not an elimination.

**8.4 Rent demand is truthful.** Lemma 5.3 requires bids to be committed. The
contract enforces a `MIN_BID_LOCK`; a *long* lock is a cost the borrower bears,
and the optimal lock length is a mechanism-design question this note does not
answer.

**8.5 Capacity.** Flow 2 is bounded by underwriter cash. With an empty book the
position is *solvent but distressed* — the mechanism degrades to patience, not to
a cliff, which is the property that matters, but it is a degradation.

---

## 9. References

Cited only for claims I actually used, with what I read.

- Milionis, Moallemi, Roughgarden, Zhang, *Automated Market Making and
  Loss-Versus-Rebalancing*, arXiv:2208.06046 (v6). Read: abstract, §1. Used for
  `dLVR = (σ²/8)V dt` and for §1's statement that a delta-hedged LP position is a
  generalised variance swap — the reason LVR is hedgeable and therefore
  disqualified as a candidate in `README.md` Phase 2.
- White & Bankman-Fried, *Everlasting Options* (2021). Cited only as prior art
  that disqualifies the options-expiry candidate on novelty.
- SSRN 6668879, *BALI* (2026). Abstract only. Cited as evidence that "continuous
  liquidation" is an existing research baseline, i.e. as a constraint on novelty.
- arXiv:2608.03616 (2026). Abstract only. Cited for the first-order transition and
  branching-ratio framing in §8.2.
- Aave governance: *Aave v4: New Features and Risk Parameter Analysis*; *[ARFC]
  Aave V4 Activation*. Read: liquidation sections. Source of the v4 parameter
  claims (`liquidationBonusFactor`, `healthFactorForMaxBonus`,
  `targetHealthFactor`).
- DeFiLlama category table and protocol index, read 2026-11-12
  (`data/defillama-2026-11-12.md`).
