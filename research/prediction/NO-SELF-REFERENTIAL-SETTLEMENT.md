# Prediction markets — can the resolution event be eliminated?

Second screen, same three filters. This one was supposed to pass: the market is
enormous, the event is expensive, and the incumbents' own failures are public.

## Why the event is worth money

- Polymarket US traded **$14.77 b notional in October 2026**, up 266% from
  $4.04 b in June, with **annualised revenue above $1.8 b** (announced 10 Nov
  2026). Sports and parlay products are ~90% of it.
- Resolution is where it hurts. UMA disputes are ~1.0% of 18,427 markets
  (May 2025–May 2026) but **~$1 b of volume sits inside disputed markets**. In
  April 2026, ~230 contracts with >$1 b of volume entered dispute.
- The dispute vote is captured: **9 wallets hold ~50% of UMA voting power** out
  of 6,400+ voters, and sided with the winning outcome in nearly all disputes
  (Bloomberg, May 2026).
- A $80 m market on "did Strategy sell BTC by 31 May" resolved **No** after two
  rounds of dispute, despite a later disclosure of a 32 BTC sale.
- On the price side, a Stanford/SMU study found **hundreds of accounts** doing
  last-second manipulation of five-minute crypto contracts; Polymarket's fix was
  to settle on a 30-second Chainlink **TWAP** instead of a single print.

So: the terminal event is expensive, the fix everyone reached for was *time
averaging*, and nobody has taken it to its conclusion.

## The design that looks obvious, and dies

**Idea.** Remove resolution entirely: a share pays the *time average of the
market's own price* over its life, `S = (1/T)∫₀ᵀ p(t) dt`. No oracle, no UMA, no
dispute window, no capital lock. Manipulating a point print is cheap; you cannot
move an average with a five-second trick.

**Theorem (degeneracy).** Under no-arbitrage, this claim forces the price to be
constant, so the market cannot aggregate information at all.

*Proof.* Price equals expected payoff: `p_t = E_t[S]`. Split the integral at `t`:

  `p_t = (1/T)∫₀ᵗ p + (1/T) E_t[∫ₜᵀ p]`

If `p` is a martingale — which it is, being a price — then `E_t[p_s] = p_t`, so
`E_t[∫ₜᵀ p] = (T−t)·p_t`:

  `p_t = (1/T)∫₀ᵗ p + ((T−t)/T) p_t`

  `p_t·(t/T) = (1/T)∫₀ᵗ p`

  **`p_t = (1/t)∫₀ᵗ p`** — the price equals its own running average, for every
  `t`. A function equal to its own running average everywhere is constant.

∎

So the payoff rule is not merely "smooth": it is *inconsistent with any price
that responds to news*. The moment the price jumps on information, it separates
from its own running average, and the gap is a **deterministic arbitrage** —
buy the claim, wait for the average to catch up. The instrument becomes a
momentum machine whose price lags the truth by construction, and the lag is free
money for whoever is fastest.

The same argument kills every cousin:

| rule | what breaks |
|---|---|
| settle at own average | price ≡ running average ⇒ constant |
| settle at own price at a random time U ~ 𝒰(0,T) | same computation, same conclusion |
| settle at own price at a fixed T (the status quo) | one block decides; the five-second trick works |
| settle at an external TWAP (Polymarket's fix) | works, but it is an oracle again — and a TWAP is a 30-second average of an *external* price, which is precisely an Asian option on that price |

**Corollary.** Any settlement rule whose input is the market's own price is
either degenerate (time-averaged, self-referential) or manipulable (point-in-
time). There is no third option, because the two properties are the endpoints of
the same trade-off, and the self-referential version collapses the trade-off
completely.

This is worth writing down because Polymarket is walking straight at it: having
discovered that point prints are manipulated, the natural next step looks like
averaging the market's own price over the window, and that step is a trap.

## What actually survives

Settlement on an **external** observable that is itself time-averaged. That is
an Asian option on a price path — real, prior art in TradFi since the 1990s, and
it does not remove the oracle; it makes the oracle harder to move. It is an
improvement, not a mechanism, and it does not justify a protocol.

## Verdict

**FAIL.** The event is expensive and the incumbents are weak at it, but the
elimination that would remove the oracle is mathematically impossible without
destroying the thing the market is for (aggregating information into a price).
The realistic version of this business is "be a better oracle", which is a
different game with different incumbents (Chainlink, UMA) and no room for a
single elegant primitive.

---

## The criterion this failure and the previous one produce

Two domains, two attempts, two structural failures — and they failed for
*opposite* reasons, which is the useful part:

| domain | can the protocol hold the position? | is the state observable continuous? | result |
|---|---|---|---|
| lending (Continuum) | **yes** — it holds the collateral | **yes** — the price | worked |
| cross-chain swap | no — a bridge or a solver must hold it | yes | FAIL, no third holder |
| prediction markets | yes — it holds the shares | **no** — the event is binary and terminal, and the only continuous proxy is the market's own price | FAIL, degeneracy |

**Criterion.** A discrete event can be replaced by a flow only when (i) the
protocol itself can hold the position that the flow is pricing, and (ii) the
state of the world has a continuous, externally observable path. Miss (i) and
capital has to sit with someone else, so the mechanism becomes a credit market
for that someone. Miss (ii) and the flow must be priced off the protocol's own
quote, which is self-referential and degenerates.

Both conditions, or no mechanism. That is why lending was available and these
two are not, and it is the filter to apply before spending another week on a
candidate.
