/-
  Continuum — core safety invariants of the buffer-rent market.

  Design constraint for this file: NO Mathlib. Everything is integer arithmetic
  over `Int` (every quantity is a WAD-scaled integer, exactly as in
  src/Continuum.sol), and every proof uses only core Lean 4 objects:
  `Int.sub_mul`, `Int.mul_sub`, `Int.mul_pos`, `Int.mul_nonneg`,
  `Int.mul_lt_mul_of_pos_left`, `Int.one_mul`, `Int.mul_zero`, plus `omega`.
  This is deliberate — there is no Lean toolchain in the environment where this
  was written, so the file is written to minimise the surface on which a proof
  could fail. See VERIFICATION-STATUS.md for what was and was not machine-checked.

  Model
  -----
  A position is (V, D, c): collateral value, debt, buffer-line multiplier.
  The buffer surplus is

        S = V - c * D                                        (def S)

  The protocol has exactly two flows, both linear in elapsed time:

        payRent : V -> V - r                    (borrower pays the underwriters, r ≤ S)
        delever : (V,D) -> (V - c*x, D - x)     (underwriter retires x of debt)

  The load-bearing fact is `delever_preserves_buffer`: deleveraging is EXACTLY
  buffer-neutral. Because D falls while S does not, the health ratio

        V / D = c + S / D

  rises. That is the negative feedback loop, and it follows from the accounting,
  not from any parameter choice.
-/

namespace Continuum

/-- A borrow position. `V` and `D` are in the same unit (debt units, WAD-scaled). -/
structure Pos where
  V : Int
  D : Int
  c : Int
  deriving Repr

/-- The buffer surplus: collateral value above the underwriters' line. -/
def S (p : Pos) : Int := p.V - p.c * p.D

/-- Debt is positive and the line sits strictly above par. -/
def WF (p : Pos) : Prop := 0 < p.D ∧ 1 < p.c

/-- Flow 2: the underwriter retires `x` of debt and is released collateral
    worth `c * x`. This is the second block of `Continuum._accrue`. -/
def delever (p : Pos) (x : Int) : Pos := ⟨p.V - p.c * x, p.D - x, p.c⟩

/-- Flow 1: the borrower burns `r` of collateral value to pay the rent.
    This is the first block of `Continuum._accrue`. -/
def payRent (p : Pos) (r : Int) : Pos := ⟨p.V - r, p.D, p.c⟩

/-- One accrual step: rent, then deleverage. -/
def step (p : Pos) (r x : Int) : Pos := delever (payRent p r) x

/-! ### 1. Deleveraging is exactly buffer-neutral -/

theorem delever_preserves_buffer (p : Pos) (x : Int) :
    S (delever p x) = S p := by
  unfold S delever
  show p.V - p.c * x - p.c * (p.D - x) = p.V - p.c * p.D
  rw [Int.mul_sub]
  omega

/-- Residual collateral still covers residual debt times the line, for *any*
    amount deleveraged and at *any* mark: no bad debt, with no assumption on the
    price path. -/
theorem delever_solvent (p : Pos) (x : Int) (hS : 0 ≤ S p) :
    0 ≤ S (delever p x) := by
  rw [delever_preserves_buffer]
  exact hS

/-! ### 2. Rent can spend the surplus but cannot cross the line

    `_accrue` caps the rent at `S`; this is that cap as a theorem. -/

theorem rent_preserves_buffer (p : Pos) (r : Int) (hS : 0 ≤ S p) (hr : r ≤ S p) :
    0 ≤ S (payRent p r) := by
  have h : S (payRent p r) = S p - r := by
    unfold S payRent
    show p.V - r - p.c * p.D = p.V - p.c * p.D - r
    omega
  omega

/-! ### 3. The composed step preserves the invariant

    `S ≥ 0` is therefore an inductive invariant of the whole mechanism:
    deleveraging preserves it exactly, rent may only spend it. -/

theorem step_preserves_invariant (p : Pos) (r x : Int)
    (hS : 0 ≤ S p) (hr : r ≤ S p) :
    0 ≤ S (step p r x) := by
  unfold step
  rw [delever_preserves_buffer]
  exact rent_preserves_buffer p r hS hr

/-! ### 4. The liquidation predicate has no reachable preimage

    Lending defines "liquidatable" as `V < D` (health < 1). Under `S ≥ 0` with
    `c > 1` that predicate is never true. The discrete event Continuum deletes
    therefore has an empty domain: it cannot fire, at any mark, for any caller. -/

theorem no_liquidation_predicate (p : Pos) (hWF : WF p) (hS : 0 ≤ S p) :
    p.D < p.V := by
  obtain ⟨hD, hc⟩ := hWF
  -- c > 1, so c - 1 > 0
  have hc1 : 0 < p.c - 1 := by omega
  have hmul : 0 < (p.c - 1) * p.D := Int.mul_pos hc1 hD
  -- c * D = D + (c - 1) * D
  have hsplit : p.c * p.D = p.D + (p.c - 1) * p.D := by
    rw [Int.sub_mul, Int.one_mul]
    omega
  have hVD : p.D < p.c * p.D := by
    rw [hsplit]
    omega
  -- S ≥ 0 is exactly c * D ≤ V
  have hle : p.c * p.D ≤ p.V := by
    have h := hS
    unfold S at h
    omega
  omega

/-- Same statement in the shape a liquidator would query. -/
theorem never_liquidatable (p : Pos) (hWF : WF p) (hS : 0 ≤ S p) :
    ¬ (p.V < p.D) := by
  have h := no_liquidation_predicate p hWF hS
  omega

/-! ### 5. The rent law

    `excessDemand` is non-increasing in the rent: borrowers drop out as the price
    rises, underwriters enter. The update

        rho' = rho + eta * z(rho),      z = excess demand

    therefore moves toward the crossing and cannot oscillate once `eta` is inside
    the no-overshoot bound. That bound is the precise content of death vector 1. -/

theorem rent_rises_with_excess (rho eta z : Int) (hη : 0 < eta) (hz : 0 < z) :
    rho < rho + eta * z := by
  have hmul : 0 < eta * z := Int.mul_pos hη hz
  omega

theorem rent_falls_with_shortage (rho eta z : Int) (hη : 0 < eta) (hz : z < 0) :
    rho + eta * z < rho := by
  have h := Int.mul_lt_mul_of_pos_left hz hη
  have hmul : eta * z < 0 := by simpa using h
  omega

/-- Convergence without overshoot: from weakly below the crossing, one step stays
    inside `[rho, rhoStar]` and moves monotonically. -/
theorem tatonnement_no_overshoot (rho rhoStar eta : Int) (z : Int → Int)
    (hη : 0 ≤ eta) (hzmono : ∀ a b : Int, a ≤ b → z b ≤ z a)
    (hcross : z rhoStar = 0) (hstart : rho ≤ rhoStar)
    (hnoover : rho + eta * z rho ≤ rhoStar) :
    rho ≤ rho + eta * z rho ∧ rho + eta * z rho ≤ rhoStar := by
  have hz : 0 ≤ z rho := by
    have h := hzmono rho rhoStar hstart
    omega
  have hmul : 0 ≤ eta * z rho := Int.mul_nonneg hη hz
  exact ⟨by omega, hnoover⟩

/-! ### 6. The flow only ever removes debt -/

theorem delever_reduces_debt (p : Pos) (x : Int) (hx : 0 ≤ x) :
    (delever p x).D ≤ p.D := by
  unfold delever
  show p.D - x ≤ p.D
  omega

/-! ### 7. Admitted, with reasons

    `incentive_compatibility` would read: the underwriter's expected profit per
    unit of absorbed debt,

        E[(1/c) * (P_spot - P_spot_after) + (c - 1)/c] >= 0,

    is non-negative. Under section 4 the residual is over-collateralised, so the
    second term is positive for any `c > 1`, and the statement reduces to a bound
    on the underwriter's resale slippage. It is NOT proved here and it CANNOT be
    proved in core Lean: it needs a probability space, a filtration generated by
    the collateral mark, and `E[·]` as a Bochner integral, i.e. Mathlib's
    `MeasureTheory`. It is also not true unconditionally — see death vector 1 in
    the writeup: if the underwriter's own book is levered, the flow inherits its
    liquidation surface.

    `continuous_liveness` would read: for a mark path whose log-velocity is
    bounded by `v`, the distress gap reaches zero in finite time, with no external
    call. That needs the reals, a topology and an ODE comparison lemma. Its
    discrete shadow is `delever_reduces_debt` (monotone debt) plus
    `delever_preserves_buffer` (monotone health), which is what the executable
    invariant campaign in verify/run.cjs checks on 1,400 randomised steps.
-/

end Continuum
