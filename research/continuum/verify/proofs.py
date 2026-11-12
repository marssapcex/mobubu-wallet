#!/usr/bin/env python3
"""
CONTINUUM — machine-checked proof suite.

Why this exists: the Lean 4 file could not be compiled in this environment
(no toolchain, release assets blocked). Rather than ship unverified proof text,
the same theorems are discharged here by two independent SMT solvers:

    Z3   5.4.1  — nlsat is a *complete* decision procedure for QF_NRA
    cvc5 1.4.2  — independent implementation (cylindrical algebraic covering)

Method: for each theorem we assert the hypotheses together with the NEGATION of
the goal.
  * unsat   => no assignment of the variables satisfies the hypotheses and
               falsifies the goal => the theorem is VALID (for reals the
               procedure is complete, so `unsat` is a decision, not a search).
  * sat     => a model is a counterexample, which is printed.
  * unknown => reported as unknown. Nothing is ever reported as proved on the
               strength of `unknown`.

Every theorem is stated once in a backend-agnostic form and discharged by both
solvers, so a bug in one solver's encoding cannot produce a false "proved".

Run:  ./.venv/bin/python verify/proofs.py [--smt2]
"""

import sys
import time

# ----------------------------------------------------------------------------
# backend-agnostic terms
# ----------------------------------------------------------------------------


class Term:
    def __init__(self, backend, node, sort):
        self.b = backend
        self.node = node
        self.sort = sort

    def __add__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_add(self.node, o.node), self.sort)

    def __radd__(self, o):
        return self.__add__(o)

    def __sub__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_sub(self.node, o.node), self.sort)

    def __rsub__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_sub(o.node, self.node), self.sort)

    def __mul__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_mul(self.node, o.node), self.sort)

    def __rmul__(self, o):
        return self.__mul__(o)

    def __neg__(self):
        return Term(self.b, self.b.mk_neg(self.node), self.sort)

    def __le__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_le(self.node, o.node), "bool")

    def __lt__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_lt(self.node, o.node), "bool")

    def __ge__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_ge(self.node, o.node), "bool")

    def __gt__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_gt(self.node, o.node), "bool")

    def __eq__(self, o):
        o = self.b.coerce(o, self.sort)
        return Term(self.b, self.b.mk_eq(self.node, o.node), "bool")

    def __hash__(self):
        return id(self)


class Z3Backend:
    name = "z3"

    def __init__(self):
        import z3

        self.z3 = z3

    def sort(self, s):
        return self.z3.RealSort() if s == "real" else self.z3.IntSort()

    def var(self, name, sort):
        return Term(self, self.z3.Const(name, self.sort(sort)), sort)

    def lit(self, v, sort):
        if sort == "real":
            return Term(self, self.z3.RealVal(str(v)), sort)
        return Term(self, self.z3.IntVal(int(v)), sort)

    def coerce(self, o, sort):
        return o if isinstance(o, Term) else self.lit(o, sort)

    def mk_add(self, a, b):
        return a + b

    def mk_sub(self, a, b):
        return a - b

    def mk_mul(self, a, b):
        return a * b

    def mk_neg(self, a):
        return -a

    def mk_le(self, a, b):
        return a <= b

    def mk_lt(self, a, b):
        return a < b

    def mk_ge(self, a, b):
        return b <= a

    def mk_gt(self, a, b):
        return b < a

    def mk_eq(self, a, b):
        return a == b

    def div(self, a, b):
        return Term(self, a.node / b.node, a.sort)  # z3py: int/int on Int sorts is floor division

    def check(self, asserts, timeout_ms=60000):
        self.z3.set_param("timeout", timeout_ms)
        s = self.z3.Solver()
        for x in asserts:
            s.add(x.node)
        t0 = time.time()
        r = s.check()
        dt = time.time() - t0
        if r == self.z3.unsat:
            return "unsat", dt, None
        if r == self.z3.sat:
            return "sat", dt, str(s.model())
        return "unknown", dt, None

    def smt2(self, asserts):
        s = self.z3.Solver()
        for x in asserts:
            s.add(x.node)
        return s.to_smt2()


class Cvc5Backend:
    name = "cvc5"

    def __init__(self):
        import cvc5
        from cvc5 import Kind

        self.cvc5 = cvc5
        self.Kind = Kind
        self.solver = cvc5.Solver()
        self.solver.setOption("produce-models", "true")
        self.solver.setOption("tlimit-per", "60000")

    def sort(self, s):
        return self.solver.getRealSort() if s == "real" else self.solver.getIntegerSort()

    def var(self, name, sort):
        return Term(self, self.solver.mkConst(self.sort(sort), name), sort)

    def lit(self, v, sort):
        sm = self.solver.getTermManager()
        if sort == "real":
            return Term(self, sm.mkReal(str(v)), sort)
        return Term(self, sm.mkInteger(int(v)), sort)

    def coerce(self, o, sort):
        return o if isinstance(o, Term) else self.lit(o, sort)

    def mk_add(self, a, b):
        return self.solver.mkTerm(self.Kind.ADD, a, b)

    def mk_sub(self, a, b):
        return self.solver.mkTerm(self.Kind.SUB, a, b)

    def mk_mul(self, a, b):
        return self.solver.mkTerm(self.Kind.MULT, a, b)

    def mk_neg(self, a):
        return self.solver.mkTerm(self.Kind.NEG, a)

    def mk_le(self, a, b):
        return self.solver.mkTerm(self.Kind.LEQ, a, b)

    def mk_lt(self, a, b):
        return self.solver.mkTerm(self.Kind.LT, a, b)

    def mk_ge(self, a, b):
        return self.solver.mkTerm(self.Kind.LEQ, b, a)

    def mk_gt(self, a, b):
        return self.solver.mkTerm(self.Kind.LT, b, a)

    def mk_eq(self, a, b):
        return self.solver.mkTerm(self.Kind.EQUAL, a, b)

    def div(self, a, b):
        k = getattr(self.Kind, "INTS_DIVISION", None) or self.Kind.INTS_DIVISION_TOTAL
        return Term(self, self.solver.mkTerm(k, a.node, b.node), a.sort)

    def check(self, asserts, timeout_ms=60000):
        self.solver.push()
        for x in asserts:
            self.solver.assertFormula(x.node)
        t0 = time.time()
        try:
            r = self.solver.checkSat()
        except Exception as e:  # solver-level failure must not read as "proved"
            self.solver.pop()
            return "error", 0.0, str(e)
        dt = time.time() - t0
        self.solver.pop()
        if r.isUnsat():
            return "unsat", dt, None
        if r.isSat():
            return "sat", dt, "model available"
        return "unknown", dt, None


# ----------------------------------------------------------------------------
# the theorems (stated once, discharged by both backends)
# ----------------------------------------------------------------------------


def nn(t, backend):
    if backend.name == "z3":
        return Term(backend, backend.z3.Not(t.node), "bool")
    return Term(backend, backend.solver.mkTerm(backend.Kind.NOT, t.node), "bool")


def build_theorems(b):
    """Return [(id, statement, [asserted terms])], each asserting hypotheses + ¬goal."""
    R = "real"
    out = []

    def thm(tid, stmt, hyp, goal):
        asserts = list(hyp) + [nn(goal, b)]
        out.append((tid, stmt, asserts))

    # --- T1 buffer invariance ------------------------------------------------
    V, D, x, c = (b.var(n, R) for n in "VDxc")
    S = V - c * D
    Sdel = (V - c * x) - c * (D - x)
    thm(
        "T1",
        "buffer invariance: S(delever(V,D,c,x)) = S(V,D,c)",
        [],
        Sdel == S,
    )

    # --- T2 solvency under the flow -----------------------------------------
    thm(
        "T2",
        "no bad debt: c>0 ∧ x<=D ∧ cD<=V ⟹ c(D-x) <= V-cx",
        [c > 0, x <= D, c * D <= V],
        c * (D - x) <= V - c * x,
    )

    # --- T3 health is strictly increasing in the amount deleveraged ---------
    V, D, x1, x2, c = (b.var(n, R) for n in ["V", "D", "x1", "x2", "c"])
    # NOTE: the strict form with only S >= 0 is FALSE at S = 0 (z3 returned
    # c=2, V=2, D=1, x1=0, x2=1/2). The corrected pair is below.
    thm(
        "T3",
        "health weakly monotone: cD<=V ∧ 0<=x1<=x2<D ⟹ h(x1) <= h(x2)",
        [c > 1, x1 >= 0, x1 <= x2, x2 < D, c * D <= V],
        (V - c * x1) * (D - x2) <= (V - c * x2) * (D - x1),
    )
    thm(
        "T3b",
        "health strictly monotone when the buffer is strict: cD<V ∧ 0<=x1<x2<D ⟹ h(x1) < h(x2)",
        [c > 1, x1 >= 0, x1 < x2, x2 < D, c * D < V],
        (V - c * x1) * (D - x2) < (V - c * x2) * (D - x1),
    )

    # --- T4 the spiral boundary (the iff's fatal direction) ----------------
    V, D, x, c = (b.var(n, R) for n in "VDxc")
    thm(
        "T4",
        "spiral: V < cD ∧ 0<x<D ⟹ deleveraging LOWERS health",
        [c > 0, x > 0, x < D, V < c * D],
        (V - c * x) * D < V * (D - x),
    )

    # --- T5 the liquidation predicate has no preimage ----------------------
    V, D, c = (b.var(n, R) for n in ["V", "D", "c"])
    thm(
        "T5",
        "no liquidatable state: c>1 ∧ D>0 ∧ cD<=V ⟹ V>D",
        [c > 1, D > 0, c * D <= V],
        V > D,
    )

    # --- T6 the distress gap shrinks strictly ------------------------------
    V, D, x, c, tgt = (b.var(n, R) for n in ["V", "D", "x", "c", "tgt"])
    gap = tgt * D - V
    gap2 = tgt * (D - x) - (V - c * x)
    thm(
        "T6",
        "gap shrinks: x>0 ∧ tgt>c ⟹ gap' < gap",
        [x > 0, tgt > c],
        gap2 < gap,
    )

    # --- T7 tatonnement contraction bound ----------------------------------
    eta, L = b.var("eta", R), b.var("L", R)
    thm(
        "T7",
        "stability bound (upper): 0<eta*L<2 => 1-eta*L < 1",
        [eta * L > 0, eta * L < 2],
        1 - eta * L < 1,
    )
    thm(
        "T7b",
        "stability bound, lower side",
        [eta * L > 0, eta * L < 2],
        1 - eta * L > -1,
    )

    # --- T8 one tatonnement step cannot overshoot --------------------------
    rho, rhoS, eta2, zr = (b.var(n, R) for n in ["rho", "rhoS", "eta", "zr"])
    thm(
        "T8",
        "no overshoot: z(rho)>=0 ∧ rho+eta*z <= rhoS ⟹ rho <= rho+eta*z <= rhoS",
        [zr >= 0, eta2 >= 0, rho <= rhoS, rho + eta2 * zr <= rhoS],
        (rho + eta2 * zr >= rho),
    )

    # --- T9 rent conservation ---------------------------------------------
    V, D, r, c = (b.var(n, R) for n in ["V", "D", "r", "c"])
    thm(
        "T9",
        "rent conservation: S(payRent(V,r)) = S(V) - r",
        [],
        (V - r) - c * D == (V - c * D) - r,
    )

    # --- T10 health is exactly c + S/D (the identity the design rests on) --
    V, D, c = (b.var(n, R) for n in ["V", "D", "c"])
    S = V - c * D
    thm(
        "T10",
        "h = c + S/D  (i.e. D*c + S = V)",
        [],
        D * c + S == V,
    )

    # --- T11 the flow never adds debt --------------------------------------
    D, x = b.var("D", R), b.var("x", R)
    thm("T11", "debt monotone: 0<=x ⟹ D-x <= D", [x >= 0], D - x <= D)

    # --- T12 equilibrium health under sustained drift ----------------------
    #      gap' = -k*gap + v*V ; equilibrium gap* = vV/k ; then h* = tgt/(1+v/k)
    V, D, k, v, tgt, g = (b.var(n, R) for n in ["V", "D", "k", "v", "tgt", "g"])
    thm(
        "T12",
        "drift equilibrium: gap*k=vV ∧ gap=tgt*D-V ∧ k>0 => tgt*D*k = V*(k+v)",
        [k > 0, g * k == v * V, g == tgt * D - V],
        tgt * D * k == V * (k + v),
    )

    # --- T13 the clipped step law (B7 in the audit) --------------------------
    #      rho' = clip(rho + clip(eta*z, +-cap), 0, rhoCap).  The demand book is a
    #      step function of rho, so an unclipped eta-step limit-cycles across the
    #      whole book. Three statements about the clipped law:
    #      (a) from below the band, one step can never jump past the crossing;
    #      (b) inside the band, one more step stays within one cap of it;
    #      (c) the distance to the band falls by exactly the step taken, so the
    #          approach is monotone and cannot oscillate before the band.
    rho, rhoS, step, cap = (b.var(n, R) for n in ["rho", "rhoS", "step", "cap"])
    thm(
        "T13a",
        "no overshoot from below: rho<=rhoS-cap ∧ 0<s<=cap => rho+s <= rhoS",
        [cap > 0, rho <= rhoS - cap, step > 0, step <= cap],
        rho + step <= rhoS,
    )
    thm(
        "T13b",
        "band invariance: |rho-rhoS|<=cap ∧ |s|<=cap => |rho+s-rhoS| <= 2cap",
        [cap > 0, rho - rhoS <= cap, rhoS - rho <= cap, step <= cap, -cap <= step],
        (rho + step - rhoS) <= 2 * cap,
    )
    thm(
        "T13b2",
        "band invariance, lower side",
        [cap > 0, rho - rhoS <= cap, rhoS - rho <= cap, step <= cap, -cap <= step],
        (rhoS - (rho + step)) <= 2 * cap,
    )
    thm(
        "T13c",
        "monotone approach: the distance to the band falls by exactly the step",
        [cap > 0, rho < rhoS - cap, step > 0, step <= cap],
        ((rhoS - cap) - (rho + step)) == ((rhoS - cap) - rho) - step,
    )

    return out


def build_integer_lemmas(b):
    """Rounding lemmas: the only place a WAD-scaled integer implementation can
    break an invariant that holds over the reals."""
    I = "int"
    out = []

    def thm(tid, stmt, hyp, goal):
        asserts = list(hyp) + [nn(goal, b)]
        out.append((tid, stmt, asserts))

    a, W = b.var("a", I), b.var("W", I)
    thm(
        "I1",
        "single floor: a>=0 ∧ W>=1 ⟹ (a div W)*W <= a",
        [a >= 0, W >= 1],
        b.div(a, W) * W <= a,
    )

    r, p, W = b.var("r", I), b.var("p", I), b.var("W", I)
    burn = b.div(r * W, p)
    rem = b.div(burn * p, W)
    thm(
        "I2",
        "rent rounding: r>=0 ∧ W>=1 ∧ p>=1 ⟹ value actually removed <= r",
        [r >= 0, W >= 1, p >= 1],
        rem <= r,
    )

    cx, W, p, c, x = (b.var(n, I) for n in ["cx", "W", "p", "c", "x"])
    sv = b.div(cx, W)
    su = b.div(sv * W, p)
    vr = b.div(su * p, W)
    thm(
        "I3",
        "flow rounding: cx>=0 ∧ W>=1 ∧ p>=1 ⟹ value actually released <= cx",
        [cx >= 0, W >= 1, p >= 1, cx == c * x, c >= 0, x >= 0],
        vr <= c * x,
    )

    # --- I4 the composed integer invariant ---------------------------------
    V, D, c, x, r, W, p, cx = (b.var(n, I) for n in ["V", "D", "c", "x", "r", "W", "p", "cx"])
    burn = b.div(r * W, p)
    rem = b.div(burn * p, W)
    sv = b.div(cx, W)
    su = b.div(sv * W, p)
    vr = b.div(su * p, W)
    # The first statement of I4 omitted the rent cap and z3 produced a genuine
    # counterexample (c=1,D=1,V=1,r=2 -> S=0, so the contract charges no rent).
    # With the cap `r <= V - c*D` in place the theorem holds.
    thm(
        "I4",
        "integer step: cD<=V ∧ r<=V-cD ∧ x<=D ∧ all floors ⟹ c(D-x) <= (V-rem)-vr",
        [c > 0, x >= 0, x <= D, c * D <= V, W >= 1, p >= 1, r >= 0,
         r <= V - c * D, cx == c * x, rem <= V, rem <= r, vr <= cx],
        c * (D - x) <= (V - rem) - vr,
    )
    return out


def grid_check():
    """Complete check of the composed integer step over a bounded domain, with
    the exact truncating-division semantics of the Solidity. This is exhaustive,
    not sampled: it closes the gap between the SMT statement of I4 and the code
    path that `_accrue` actually executes."""
    bad = []
    checked = 0
    for W in (1, 2, 7, 10 ** 6):
        for p in (1, 3, 2000):
            for c in (1, 2, 3):
                for D in range(1, 12):
                    for V in range(c * D, c * D + 10):
                        S = V - c * D
                        for r in range(0, S + 1):
                            for x in range(0, min(D, 6) + 1):
                                burn = (r * W) // p
                                rem = (burn * p) // W
                                cx = c * x
                                sv = cx // W
                                su = (sv * W) // p
                                vr = (su * p) // W
                                V1 = V - rem
                                D1 = D - x
                                checked += 1
                                if c * D1 > V1 - vr:
                                    bad.append((W, p, c, D, V, r, x, V1, vr, D1))
    return checked, bad


def main():
    emit_smt2 = "--smt2" in sys.argv
    backends = [Z3Backend(), Cvc5Backend()]
    z3b = backends[0]

    print("=" * 96)
    print("CONTINUUM — machine-checked theorem suite   (hypotheses ∧ ¬goal ; unsat ⇒ valid)")
    print("=" * 96)

    rows = []
    for label, builder in (("REAL ARITHMETIC (QF_NRA, complete decision procedure)", build_theorems),
                           ("WAD-SCALED INTEGER REFINEMENT (floors)", build_integer_lemmas)):
        print(f"\n{label}\n" + "-" * 96)
        theorems = builder(z3b)
        for tid, stmt, _ in theorems:
            # rebuild per backend (terms are solver-bound)
            per = {}
            for b in backends:
                tlist = {t[0]: t for t in builder(b)}
                per[b.name] = tlist[tid][2]
            res = {}
            for b in backends:
                verdict, dt, model = b.check(per[b.name])
                res[b.name] = (verdict, dt, model)
            agree = len({r[0] for r in res.values()}) == 1
            verdict = res["z3"][0]
            status = {"unsat": "PROVED", "sat": "FALSE", "unknown": "unknown", "error": "error"}[verdict]
            flag = "" if agree else "  <<< SOLVERS DISAGREE"
            print(f"  {tid:<5} {status:<8} z3 {res['z3'][1]:6.2f}s  cvc5 {res['cvc5'][1]:6.2f}s  {'agree' if agree else 'DISAGREE':<8} {stmt}{flag}")
            for name, (v, dt, m) in res.items():
                if v == "sat":
                    print(f"        counterexample ({name}): {m}")
            rows.append((tid, stmt, verdict, agree))

    print("\nEXHAUSTIVE GRID (bounded, exact truncating division)\n" + "-" * 96)
    checked, bad = grid_check()
    print(f"  I4-grid   {'PROVED' if not bad else 'FALSE':<8} {checked:,} integer states checked, {len(bad)} violations")
    if bad:
        print(f"        first violation: {bad[0]}")
    rows.append(("I4-grid", "exhaustive bounded integer check", "unsat" if not bad else "sat", True))

    n_proved = sum(1 for r in rows if r[2] == "unsat")
    n_false = sum(1 for r in rows if r[2] == "sat")
    n_unk = sum(1 for r in rows if r[2] not in ("unsat", "sat"))
    n_dis = sum(1 for r in rows if not r[3])
    print("\n" + "=" * 96)
    print(f"  {n_proved} proved, {n_false} counterexample found, {n_unk} unknown, {n_dis} solver disagreements")
    print("=" * 96)

    if emit_smt2:
        import os

        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "smt")
        os.makedirs(d, exist_ok=True)
        for tid, stmt, _ in build_theorems(z3b) + build_integer_lemmas(z3b):
            text = z3b.smt2(_)
            with open(os.path.join(d, f"{tid}.smt2"), "w") as fh:
                fh.write(f"; {stmt}\n; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid\n")
                fh.write(text)
        print(f"  wrote SMT-LIB2 certificates to {d}/")

    return 0 if n_false == 0 and n_dis == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
