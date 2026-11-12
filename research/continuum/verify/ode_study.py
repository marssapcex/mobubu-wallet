#!/usr/bin/env python3
"""
CONTINUUM — continuous-time analysis, done symbolically.

The flow's governing equation, with a persistent drawdown of the mark at rate v:

        g   = tgt*D - V                       (distress gap)
        D'  = -k*g/tgt                        (the flow: x/t = k*gap/tgt)
        V'  = -v*V                            (adverse drift)
  ==>   g'  = -k*g + v*V

This script solves it in closed form with sympy, takes the t -> infinity limit,
and prints the quantitative tables used in PAPER.md. Nothing here is sampled;
it is symbolic.

Run: ./.venv/bin/python verify/ode_study.py
"""

import sympy as sp


def closed_form():
    t, k, v, V0, g0, c, tgt = sp.symbols("t k v V_0 g_0 c tgt", positive=True)
    g = sp.Function("g")
    ode = sp.Eq(g(t).diff(t), -k * g(t) + v * V0 * sp.exp(-v * t))
    sol = sp.dsolve(ode, g(t), ics={g(0): g0})
    rhs = sp.simplify(sol.rhs)
    limit = sp.limit(rhs, t, sp.oo)
    return sol, rhs, sp.simplify(limit)


def quasi_steady_state():
    """Set g' = 0 in the quasi-static regime where V decays slowly: k*g = v*V."""
    k, v, V, D, tgt = sp.symbols("k v V D tgt", positive=True)
    g = v * V / k
    h = sp.solve(sp.Eq(g, tgt * D - V), V)[0] / D  # V/D
    return sp.simplify(h)


def spiral_onset(k, rho_max, s):
    """The rent drag beats the flow repair when f < rho_max/(k*s), where
    f = gap/(tgt*D) is the fractional distress and s = S/D the relative buffer.
    Margin M = k*f*s/rho_max."""
    return rho_max / (k * s)


def main():
    print("=" * 88)
    print("CONTINUUM — continuous-time analysis (sympy, symbolic)")
    print("=" * 88)

    sol, rhs, limit = closed_form()
    print("\n1. The flow ODE, solved in closed form")
    print("   g'(t) = -k*g(t) + v*V0*exp(-v*t),  g(0) = g0")
    print("   g(t)  =", sp.simplify(rhs))
    print("   lim t->inf g(t) =", limit)
    print("   => the homogeneous rate is -k, so the loop is stable for EVERY k > 0.")
    print("      Instability is not in this ODE; it is in the accounting (c > 1+b)")
    print("      and in the discrete rent interaction (the f < f* region below).")

    h = quasi_steady_state()
    print("\n2. Quasi-steady health under sustained drawdown v")
    print("   k*g = v*V and g = tgt*D - V  =>  V/D =", h)
    print("   i.e.  h* = tgt / (1 + v/k).  With tgt=1.20, k=365/yr:")
    for v in (0.5, 1.0, 2.0, 5.0, 20.0):
        hv = 1.20 / (1 + v / 365.0)
        print(f"      v = {v:5.1f}/yr  ->  h* = {hv:.4f}   (deficit {100 * (1.20 - hv) / 1.20:.2f}%)")

    print("\n3. Rent-cap calibration: margin M = k*f*s/rho_max")
    print("   f = gap/(tgt*D) (fractional distress), s = S/D (relative buffer)")
    k = 365.0
    rho = 0.10
    print(f"   k = {k:.0f}/yr, rho_max = {rho:.2f}/yr")
    fs = (0.005, 0.02, 0.05, 0.20, 0.50)
    ss = (0.005, 0.01, 0.05, 0.15)
    print("\n        s\\f " + "".join(f"{f:>10.3f}" for f in fs))
    for s in ss:
        row = "".join(f"{k * f * s / rho:>10.2f}" for f in fs)
        print(f"   {s:>8.3f} " + row)
    print("\n   Margin < 1 means the rent drag beats the deleverage repair: the")
    print("   position is pushed deeper into distress by its own protection.")
    fstar = rho / (k * ss[-1])
    print(f"   Spiral onset f* = rho_max/(k*s) at s={ss[-1]}: f* = {fstar:.5f}")
    print("   Design rule: rho_max must be set from the SMALLEST (f*s) corner the")
    print("   protocol allows, not from the stressed one. With rho_max = 1.0/yr")
    for r in (0.1, 0.5, 1.0):
        print(f"      rho_max={r:4.2f}/yr -> f* = {r / (k * 0.15):6.4f} of tgt*D "
              f"({100 * r / (k * 0.15):5.3f}% of the trigger value)")

    print("\n4. Time to close the gap (no drift)")
    print("   g(t) = g0*exp(-k*t)  =>  T(to reach eps) = ln(g0/eps)/k")
    for eps in (0.5, 0.1, 0.01):
        T = -sp.log(eps) / 365.0
        print(f"      gap -> {eps*100:5.1f}% of g0 takes {T*365*24:8.2f} hours (k=365/yr)")


if __name__ == "__main__":
    main()
