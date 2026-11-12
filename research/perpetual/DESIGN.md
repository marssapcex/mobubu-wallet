# Perpetual options with a real funding law

Third screen. The instrument is not mine — White & Bankman-Fried (2021),
"Everlasting Options", Paradigm — and the paper solves the *pricing*. What it
does not solve is everything needed to put it on a chain, and the paper says so
itself in Future Work: *"what are appropriate liquidation criteria for those
trading on margin?"*

Running the pipeline honestly, the interesting result is not a mechanism. It is
where the mechanism structurally cannot stand, measured.

## Phase 1 — the discrete events in an options market

| # | event | what eliminating it means | state |
|---|---|---|---|
| O1 | **expiry / delivery** | the position never settles | solved by the 2021 paper |
| O2 | **roll** (sell expiring, buy new) | no spreads, no execution risk at roll | solved by the same paper |
| O3 | **funding instant** | no moment when a lump payment changes the value | **the paper keeps it, and warns about it** |
| O4 | **margin call / liquidation of the writer** | no liquidatable writer state | **open — the paper's own Future Work** |
| O5 | **price discovery of the strip** (each rung's vanilla price) | no oracle for `REGPRICE_{t_i}` | **open on-chain — no term structure exists** |

O1, O2 are the paper's contribution. O3, O4, O5 are what shipping it requires.

## The paper's result, exactly

With `F` funding payments per period of length `P`, `q = F/(F+1)`:

- **Funding per payment** (Appendix A.2): `(MARK − PAYOFF)/F`, paid by longs to
  shorts.
- **Price** (Appendix B.1): `V = (1/F) Σ_{i≥1} q^i · REGPRICE_{t_i}`, weights
  summing to 1 — for daily funding, 1/2 expiring today, 1/4 tomorrow, 1/8 the
  day after.

So the instrument *is* a finite ladder of vanillas with geometric weights. The
infinite tail is truncated: `V = (1/F) Σ_{i=1}^{N} q^i REGPRICE_{t_i} + O(q^N)`.
That is the whole implementation, and it is O(N).

In the continuous limit `F → ∞` the weights become `λe^{−λu}du` and the price is
`V = λ∫_0^∞ e^{−λu} C(u) du`, which satisfies, by integration by parts on
`C_u = ½σ²S²C_SS`,

```
½σ²S²V_SS = λ(V − PAYOFF)          (r = 0)
```

i.e. Black–Scholes with a source term equal to `λ` × the time value. This is the
funding law written as a PDE rather than as a payment schedule: **the holder pays
`λ` × time value per unit time, continuously.**

## Measured (S = K = 3000, σ = 0.6, P = 1 day)

`verify.cjs`, no dependencies:

| F (payments/period) | ladder value | error vs exact | as bp of notional |
|---|---|---|---|
| 1 (daily) | 50.6342 | +17.3264 | 57.8 bp |
| 2 | 42.9949 | +9.6871 | 32.3 bp |
| 24 (hourly) | 34.2816 | +0.9738 | 3.25 bp |
| 144 (10 min) | 33.4775 | +0.1697 | 0.57 bp |
| 1440 (per block, 1 min) | 33.3258 | +0.0180 | 0.060 bp |
| 8640 | 33.3115 | +0.0037 | 0.012 bp |

Exact exponential strip: **33.3078**. A one-day vanilla is 37.5855 — **12.8%
higher**. The paper says an everlasting funded "twice daily" behaves "almost
exactly like a regular expiring option... expiring in one day"; measured, the
everlasting is worth a vanilla with **T = 0.785 days**, and at F = 2 it is 32 bp
of notional *above* the exact limit. The paper's claim is loose in both
directions, and the correct statement is the one above.

The PDE identity checks to ≤ 0.1% away from the strike; at `S = K` the residual
is ~1.8%, which is the finite-difference error across the integrable `1/√u`
singularity of `V_SS`, not a failure of the identity.

## What the paper leaves, and the three additions

### O3 — the funding instant is farmable, and continuity kills the prize

The paper is explicit: *"Reasoning about funding-fee-based perpetuals is tricky
because their pricing contains a natural discontinuity... a rational trader
should short the perpetual a microsecond before expiry, collect the payment, and
then buy to close their short a microsecond after expiry."*

The prize is the payment landing in one block:

| F | instant payment | bp of notional | annualised if farmed each period |
|---|---|---|---|
| 1 | 33.31 | 111 bp | 40,524 bp |
| 24 | 1.39 | 4.63 bp | 1,689 bp |
| 1440 | 0.0231 | 0.077 bp | 28 bp |
| **continuous** | **0** | **0** | **0** |

Accrue the funding as a **rate per second** and the prize is identically zero: a
trader present for `ε` receives `ε·rate` and bears `ε` of the risk. That is the
first addition, and it is measurable rather than rhetorical — the table above is
the entire argument.

### O4 — full collateralisation, so no liquidation criterion is needed

The paper's open question is what liquidation criterion to use. The answer that
avoids the question: **the writer is never levered.** Each rung is cash-secured
(a put holds `K` per unit) or asset-secured (a call holds the underlying per
unit). Then:

- the writer's maximum liability on each rung is covered by construction;
- there is no margin call, no liquidation, no bad debt — the same property
  Continuum gets from its buffer, reached by a much blunter route;
- the cost is capital: ~`K` per written put, which is the honest price of the
  guarantee.

### O5 — and here it dies

The paper's no-arbitrage argument requires `REGPRICE_{t_i}` to be **market
prices** — arbitrageurs must be able to trade each rung against the everlasting.
On a chain there is no vanilla term structure to trade against: Deribit is
off-chain, and no on-chain venue carries a maturity ladder deep enough to
arbitrage a 1/2, 1/4, 1/8 ladder.

So the implementation has exactly two shapes:

1. **Price the strip from a model.** One `σ` parameter, chosen by whoever deploys.
   The price is then a convention, not a no-arbitrage value, and the funding is
   derived from the convention. Set `σ` too low and the funding undercharges —
   the writer bleeds exactly like Continuum's underwriter bleeds when rent is
   underpriced; set it too high and nobody trades. There is no observable that
   disciplines the parameter.
2. **Price the strip from a live market** — which means the protocol must first
   *be* an options venue with a real ladder. Then the everlasting option is a
   derivative on your own book, and the mechanism is the venue, not the
   instrument.

Panoptic chose neither: their paper says everlasting options "rely on oracles and
the constant rebalancing may be expensive to execute on-chain", so they priced a
**different, observable cash flow** — Uniswap LP fees ("streamia") — and gave up
being this instrument.

> **Correction (see `ERRATA.md`).** An earlier version of this file said the 2021
> object "is still unshipped". That is false: Deri shipped it in 2021 with
> per-second funding, Everstrike shipped a CLOB variant in 2023 with a floating
> strike, Panoptic ships streamia, and AmPO (SIAM J. Financial Math 17(3), 2026)
> prices a different claim. Also, continuous funding — presented below as my first
> addition — was proposed by Deri in 2021. What remains mine is the measurement
> and the O4 argument, not the continuous accrual.

## The three death vectors

1. **Mark-to-model.** With no rung market, `σ` is an unobservable free parameter.
   Funding derived from it is arbitrary, and a persistent bias in either
   direction is a slow, invisible transfer — the same shape as Continuum's
   underpriced rent, and here there is no counterparty to bid it back.
2. **Capital charge.** Full collateralisation costs ~`K` per put. The writer's
   expected P&L is zero *plus* their spread, on `K` of locked capital, so the
   return on capital is the spread divided by the strike — thin, and only
   tolerable for writers whose capital is already committed (covered-call
   vaults). This is why naked perpetual option writing does not exist.
3. **Ladder truncation vs funding frequency.** Cheap funding frequencies (F small)
   carry 3–58 bp of pricing error and a farmable instant; fine ones (F ≥ 1440)
   cost one storage refresh per block per book. The window is real but narrow,
   and it is the only one of the three that is pure engineering.

## Code shape (not committed as Solidity here, deliberately)

```
struct Rung { uint64 expiry; uint256 weightWad; uint256 notionalWad; }
// funding accrues per second:  f = lambda * (mark - payoff)
//   mark    = sum_i weight_i * interiorPrice(sigma, expiry_i)   // or auction print
//   payoff  = max(S - K, 0)
// renewal: at expiry, rung 1 pays off, its weight re-mints at the far end;
//          no trade happens, only a shift of the weight vector.
```

The renewal is a *bookkeeping* shift, which is the paper's "no spreads, no
execution risk" made literal. That part is genuinely cheap on-chain and the
"constant rebalancing is expensive" objection does not apply to a writer who
mints its own rungs.

## Verdict

**FAIL** — as a standalone protocol, and the failure is O5, not the math. The
2021 instrument is correctly priced only against a vanilla term structure that
does not exist on-chain; without it, the funding law has a free parameter and
therefore no discipline — and the four deployments in `ERRATA.md` show each team
escaping that same problem by giving up the law, the maturity, or the volume. Two of my three additions (continuous accrual, full
collateralisation) are real, cheap, and worth shipping **inside an options venue
that already has a ladder** — where they would be the first liquidation-free
perpetual option. Building the venue first and the instrument second is a
different, much larger project, and it is not a mechanism — it is a market.

What would flip this to DEPLOY: a venue with ≥ 3 traded maturities per strike
and enough volume that a rung is arbitrageable. Then O5 closes, `σ` stops being
a parameter, and the instrument becomes what the paper says it is.
