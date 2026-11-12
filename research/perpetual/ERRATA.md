# Errata — three corrections to `DESIGN.md`, all of them mine

Written after the deployments were pointed out to me. Two of the claims in
`DESIGN.md` are false, and one of my "additions" is prior art from 2021.

## Correction 1 — continuous funding is not my contribution. Deri did it in 2021.

I presented "accrue the funding as a rate per second so the funding instant
disappears" as the first of three additions. Deri Protocol proposed and shipped
exactly that, and their account of the paper states the reasoning I thought I was
making: the Deri team proposed *"the continuous funding scenario, meaning the user
pays the funding fee continuously rather than once or twice a day. The latter
would not work on DeFi since transactions typically occur per block or per
second"* (Bitgramm, Sept 2021, describing Deri's extension of White–SBF).

Their documentation states the mechanics plainly: the funding fee accrues per
second — "a funding fee of (Funding Fee for 7 Day)/604800 is accrued every
second" — and, unlike perpetual futures, "theoretically the funding fee for
Everlasting Options is always positive".

So the idea is theirs, five years old, and shipped. What survives of my section
is only the *measurement*: the prize for farming one funding instant is `TV/F`,
which is 111 bp of notional at F=1, 0.077 bp at F=1440 and zero as a rate. That
table quantifies why Deri's choice was right; it does not originate it.

## Correction 2 — the object has shipped, four times, and I said it had not.

`DESIGN.md` says the 2021 instrument "is still unshipped". That is false.

| venue | when | what it actually is | funding law |
|---|---|---|---|
| **Deri** | 2021 | everlasting options, DPMM (AMM) pricing, positions as NFTs | paper's law, **per second**, always positive, settled on interaction |
| **Everstrike** | 2023 | CLOB perpetual options, **floating strike** pinned to EMA₁₀₀ × {0.90…1.10} | perp-style: premium = (Mark−Index)/Index, dampened, hourly, period 10 h, capped at 10 %/h |
| **Panoptic** | 2023→ | perpetual options on Uniswap v3/v4 liquidity | "streamia" — the LP fees the position would have earned |
| **AmPO** | 2025/26 | *not this instrument* — fungible continuous-**installment** options | implicit, via notional decay |

Three of these are real deployments of a perpetual option; only Deri implements
the paper's `(MARK − PAYOFF)/F`. Everstrike's is explicitly a different
structure, and its own documentation says so.

## Correction 3 — AmPO is real, and it is about a different flaw than the one I found

Feinstein, "Amortizing Perpetual Options", arXiv:2512.06505 (v2 Feb 2026),
published in *SIAM Journal on Financial Mathematics* 17(3), SC13–SC27, Sept 2026.
The result: replace explicit installment payments (which lapse, so units of
notional stop being identical) with **decay of the claimable notional**, and the
pricing problem reduces exactly to a **perpetual American option on a
dividend-paying asset**, with the amortization rate as the dividend yield. Closed
forms for the exercise boundary and the Greeks follow.

Two honest notes. First, the fungibility problem it solves is specific to
*installment* options — pay-as-you-go claims whose units differ once a holder
stops paying. White–SBF's object does not have that flaw: its funding is a
transfer between long and short, so units stay identical and tradeable. Second,
the reduction is worth knowing because it is adjacent to the PDE in `DESIGN.md`:
mine has a source term `λ(V − payoff)`, AmPO has a dividend yield `λ`. Same
letter, different operator, and the AmPO branch is the one with a published
closed form.

---

## What the four deployments do to my argument

My O5 said: the no-arbitrage price needs each rung to be tradeable against the
everlasting, and no on-chain vanilla term structure exists, so the law has no
discipline. I called that fatal.

The empirical record does not contradict it — **it confirms it, by showing four
independent escapes from exactly that problem**:

- **Deri** priced the strip with its own AMM (DPMM). That is the mark-to-model
  branch: the price is a formula, and the formula is the protocol's opinion.
- **Everstrike** kept a real order book but changed the *instrument* to dodge the
  problem: the strike floats with EMA₁₀₀, so there is no fixed payoff to fund
  against, and the funding becomes perp-style. Consequence, in their own words:
  funding interval 1 h "makes the gamma/vega profile similar to European-style
  0DTE options", and the equivalent vanilla expiry is roughly `TTNF × 20`.
- **Panoptic** kept a fixed payoff but replaced the *premium source* with LP fee
  revenue, giving up the paper's law.
- **AmPO** changed the *payment structure* to make units fungible, and prices a
  different claim entirely.

So the promised product — "always able to sell your ETH for $3000" — is still not
what exists. What exists is: a 0DTE-like gamma instrument (Everstrike), a
fee-revenue proxy (Panoptic), an AMM-priced long-dated claim (Deri, which never
grew), and a perpetual American option (AmPO, a paper).

That is a sharper conclusion than the one I wrote, and it is not mine to soften:
**the long-dated perpetual hedge has been attempted four times and every attempt
either gave up the law, gave up the maturity, or gave up the volume.**

## Revised verdict

The FAIL in `DESIGN.md` stands, but for a different and better-supported reason.
Not "unshipped" — **shipped, and the law degrades every time it meets a chain
without a vanilla term structure**. The one piece still unclaimed is O4: none of
the four is liquidationless. Deri and Everstrike margin and liquidate; Panoptic's
streamia consumes collateral and liquidates. That is the remaining gap, and it is
closed only by full collateralisation, whose cost (~`K` per put) is exactly why
nobody has closed it.
