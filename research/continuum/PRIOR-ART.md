# Prior art, and what is actually left to claim

Written after the mechanism was built, not before — which is the wrong order,
and this file exists to fix the consequence. Every citation below was checked
before it was used; the three that do the most damage to the novelty claim are
first.

## 1. Zero-Liquidation Loans — Sardon, Oct 2021 (arXiv:2110.13533)

The prior art that matters most, and the one the whitepaper should have cited.

**What it does.** The borrower has the right to repay a loan in stablecoin *or*
by delivering the pledged collateral. There is no liquidation event at all: if
the LTV is breached the lender simply receives the collateral at the strike. The
paper is explicit that the interest is the premium of the put the borrower has
sold to the lender — its own figure caption says so.

**Overlap with Continuum: dishonest to deny.** "The liquidation event is
eliminated, and the borrower pays a continuous-ish fee instead of a contingent
penalty" is a 2021 idea, published, with an options-pricing interpretation. Any
claim of the form "we were the first to remove the liquidation cliff in a lending
market" is dead.

**What is not in it.** The settlement is a terminal choice at a strike, not a
flow; the lender's claim jumps to collateral ownership at the threshold, which is
a discrete transfer of an option even though it is not called a liquidation; the
premium is fixed at origination rather than cleared in a market; and there is no
invariant of the form "this transition cannot reach the predicate".

## 2. Curve LLAMMA / crvUSD — 2023

**What it does.** Collateral is spread over price bands and converted to crvUSD
as the price falls, reversing when it recovers. Confirmed from Curve's own
documentation: soft liquidation is continuous, but **a position at 0% health is
still hard-liquidated** — the event is smoothed, not removed. Conversion happens
at the band's AMM price, and every round trip through the bands costs the
borrower.

**Overlap.** Gradual conversion instead of one block of forced selling.

**What is not in it.** The hard liquidation stays. There is no buffer invariant:
LLAMMA's health is a valuation of the bands, and rebalancing losses erode it —
which is why "a price that hovers in your range bleeds you" is the documented
user experience. No rent market, no underwriter layer, and the conversion price
is market-determined rather than fixed against debt.

## 3. Everlasting Options — White & Bankman-Fried, 2021

The structural analogy, not a lending mechanism: replace an expiry with a
funding flow so the instrument has no terminal event. Continuum borrows this
*shape* — a discrete event replaced by a flow priced by a two-sided rate — and
nothing else. The same shape is what a perpetual swap does to a futures roll,
which is the analogy the paper opens with.

## 4. Fair Interest Rates Are Impossible for Lending Pools — arXiv:2410.11053

Lending pools replicate barrier options, and no closed-form "fair" interest rate
exists. This is uncomfortable for Continuum in a useful way: it means the rent
cannot be defended as a *fair price* of the protection. It is a market-clearing
price and nothing more, which is exactly how it is implemented (a tâtonnement
over a bid book), and exactly how it is described in the audit pack — but the
whitepaper's language is sometimes looser than that.

---

## What is left to claim, narrowly

After the four above, the defensible claim is not "no liquidation" and not
"continuous instead of discrete". It is:

> a lending market whose deleverage **buys collateral at a price fixed per unit
> of debt rather than at the market price**, which makes `S = V − c·D` invariant
> under the flow, so the transition relation has no liquidatable preimage; with
> rent charged **only against the surplus** — never against the buffer line — and
> cleared by a two-sided tâtonnement over borrower bids.

Three components, each of which has to survive on its own:

1. **The debt-denominated purchase price.** This is the load-bearing one. LLAMMA
   converts at the AMM price; Aave liquidates at the oracle price plus a bonus;
   Sardon settles at a strike fixed in collateral terms. Pricing the purchase as
   `c × debt` is what turns the margin function into an invariant.
2. **Rent charged against the surplus only.** Without the cap, the fee erodes the
   buffer and the invariant dies in a different way (this is theorem T9's
   premiss, and it is the reason `rentCap` exists in the code).
3. **The emptiness result, machine-checked.** Not the idea, the proof: 23 SMT
   theorems, two solvers, plus the integer refinement and the 122,760-state grid.

If someone produces a continuous scheme with a debt-denominated purchase price
and an invariant surplus, component 1 goes and the rest is scaffolding.

## The economic hole this file exposes

If the protection is a put sold by the pool — and Sardon shows that is exactly
what it is — then the clearing rent must be comparable to that put's premium.
In the fixtures, `rho` settles near **1%/yr** (floor 1%, cap 10%) against a
position that is 2% out of the money. A one-year, 2%-OTM put on a 60%-vol asset
is worth on the order of 20% of notional, and even a one-month version is worth
several percent. The rent is not in that range.

So the market as implemented will clear at a price that does **not** pay for the
put the underwriters are writing — until they are wiped out by the tail, which
is precisely what campaign E shows: a gap to mark 600 removes 100% of NAV. The
tâtonnement finds the price at which *borrowers* are willing to borrow, not the
price at which *underwriters* break even, because nothing in the mechanism
anchors the rent to the loss distribution. That is the honest weakest point of
the design, it is not a bug, and it is what a professional audit should be asked
to price.
