# CONTINUUM — the buffer-rent market

> **Novelty, stated narrowly:** see [`PRIOR-ART.md`](PRIOR-ART.md). Zero-liquidation
> lending exists since Sardon (2021) and soft liquidation since LLAMMA (2023);
> what is left to claim here is the debt-denominated purchase price, the rent
> charged against the surplus only, and the machine-checked emptiness result.
>
> **Shipping code:** [`protocol/`](protocol/README.md) is the deployable market —
> `ContinuumMarket.sol`, lender shares, oracle adapters, a deploy script and an
> audit pack. Everything below documents the *research* prototype: the mechanism,
> the proofs, and the prototype that made them testable. The prototype is not for
> deployment; `protocol/` is.

**A mechanism that deletes the liquidation event by turning it into a funding rate.**

📄 **Whitepaper (PDF, 14 pages, academic format): [`whitepaper/Continuum-Whitepaper.pdf`](whitepaper/Continuum-Whitepaper.pdf)**
· source: [`whitepaper/build.py`](whitepaper/build.py) · deep treatment: [`PAPER.md`](PAPER.md)

| output item | result |
|---|---|
| **1. Discrete event eliminated** | The liquidation: the moment a health threshold is crossed and an indivisible block of collateral is seized by whoever wins the gas race. |
| **2. Feedback law** | `ρ_{n+1} = clip[0,ρ_max]( ρ_n + η · (D(ρ_n) − S(ρ_n)) / N )` with `S = V − cD`, `x/t = k·(target·D − V)⁺ / target` |
| **3. Formal** | **18 theorems machine-checked by two independent SMT solvers** (Z3 5.4.1 `nlsat` + cvc5 1.4.2), **plus a 122,760-state exhaustive integer check**: buffer neutrality, no-bad-debt, health monotonicity, the spiral boundary, empty liquidation domain, gap contraction, tâtonnement stability, and the WAD-integer refinement. Lean 4 file included for the reader who wants a proof assistant, **not compiled here**. `incentive_compatibility` **admitted** — see §4 |
| **4. Foundry** | `src/Continuum.sol` (5,187 bytes), `test/Continuum.t.sol` — compiles under solc 0.8.24; 5 property campaigns executed on a live EVM: 0 violations across 1,490 accrued steps |
| **5. Death vectors** | (i) `c ≥ 1+b` turns the loop positive; (ii) underwriter mark-down + slow-flow arbitrage; (iii) it is a credit default swap, so it dies in the EU retail perimeter first |
| **6. Verdict** | **DEPLOY** — with the caliber caveat at the bottom, which you should read before you deploy anything |

---

## Phase 0 — Method, and what the DeFiLlama scan actually showed

I pulled the live category table (`defillama.com/categories`) and the protocol index (`api.llama.fi/protocols`) on 2026-11-12. The rows that matter for this design:

| category | protocols | TVL | 24h revenue |
|---|---|---|---|
| Bridge | 179 | $58.52b | $122,622 |
| **Lending** | **665** | **$48.47b** | **$690,315** |
| Liquid Staking | 302 | $46.98b | $305,222 |
| DEXs | 2,169 | $12.12b | $1.54m |
| **Risk Curators** | **100** | **$9.88b** | $53,468 |
| Restaking | 15 | $8.48b | $517 |
| Basis Trading | 44 | $7.81b | $3,392 |
| Derivatives | 463 | $1.80b | $3.28m |
| Insurance | 33 | $150.76m | $2,368 |
| **Liquidations** | **3** | **$812,253** | **$0** |

Two numbers in that table are the entire argument for this document.

**$48.47b sits in lending, and the market that is supposed to absorb its failures holds $812,253.** There are three protocols in the "Liquidations" category and they collectively hold less than a single mid-cap NFT collection. That is not because liquidation is unprofitable — it is the opposite. On 2025-10-10 a single macro headline produced **$19.3 billion of liquidations in 24 hours across 1.62 million accounts**, roughly nine times the previous record, with Binance alone consuming $188m of insurance fund and several venues firing auto-deleveraging. A 5–10% liquidation bonus on that flow is $1–2 billion *transferred in one day*, and almost none of it was pre-committed capital earning a spread. It was won by whoever was fastest to a block.

That is the structurally interesting fact. Liquidation is the largest forced transfer in crypto and it is not a market. It is an **event with a latency race attached**, and the rent is captured by the participant who is best at being early rather than the participant who is best at holding risk.

The second number is `Risk Curators: $9.88b across 100 protocols`. That is nearly ten billion dollars whose risk parameters are set by a human committee. In BitMEX terms, it is the "exchange decides the contract spec" regime.

### The BitMEX deconstruction, applied as a filter

A perpetual swap deleted rollover. It did so by noticing that the thing being rolled — the basis — is not a stock, it is a **flow that can be charged continuously and priced locally**. Funding is `f(perp − index)`, the index is an observable the mechanism does not control, and no delivery ever happens.

Applying the same move to the list below, exactly one item survives: the liquidation. Not because liquidation is the most *expensive* item (cross-chain settlement and LVR are plausibly larger in annual value), but because it is the only one where all three of the following hold at once: the event can be **deleted** rather than resized, the replacement can be **self-priced by a local loop with no governor**, and the replacement requires **no delivery, no auction and no custodian**.

Everything else in Phase 1 fails on at least one of those, and the failures are structural, not engineering.

---

## Phase 1 — Exhaustive audit of discrete, lumpy, unhedgeable events

Format: **(a)** the discrete event, **(b)** who loses money, **(c)** operational infrastructure it forces into existence, **(d)** why it has not been eliminated.

**1. Liquidation threshold crossing** *(Lending, $48.47b across 665 protocols)*
(a) Health factor crosses 1.0; an indivisible chunk of collateral is seized at a fixed bonus.
(b) The borrower: 5–15% of the seized notional, and typically far more than the deficit, because the close factor is sized to restore a target health factor rather than to repair the shortfall. Also lenders, whenever the auction clears below the debt (bad debt socialised).
(c) Keeper bots with latency-optimised RPC, gas auctions, private mempools; insurance funds; ADL engines; bad-debt backstops; a governance process that re-tunes bonus and close factor after every incident.
(d) Because the *pricing of the seizure* is a parameter, not a market. Aave v4 improves this (bonus now ramps linearly with health, liquidation sized to a target HF) but the trigger, the caller and the parameter remain. The event is resized, not deleted.

**2. Liquidation auction clearing** *(CDP: $5.78b; Liquity, Ajna, MakerDAO collateral auctions)*
(a) A Dutch or batch auction runs over minutes to hours and clears at whatever the book gives.
(b) The borrower (clears below fair value in a thin book) and the protocol (residual bad debt if the auction fails entirely — see the rsETH/KelpDAO episode reported in April 2026 at up to ~$200m of bad debt).
(c) Auction contracts, price decay curves, keeper capital, restart/fallback logic, and a governance process for the decay parameters.
(d) The auction exists *because* the seizure is lumpy. Delete the lump and the auction has nothing to clear.

**3. LP rebalancing / LVR** *(DEXs: $12.12b)*
(a) Every block in which the external price moved, an arbitrageur trades the AMM back to the mark and pockets the difference: `dLVR = (σ²/8)·V·dt` for a constant-product pool.
(b) LPs. The order of 5–7% of liquidity per year at typical volatilities; hundreds of millions annually.
(c) Searcher infrastructure, builder relationships, private orderflow, and (on the LP side) active range management.
(d) The discrete thing is the *block*. LVR is the price of the AMM's stale quote; making it continuous requires continuous block arrival and a lower-latency mark than the searchers have. That is a consensus property, not a mechanism property. LVR can be *hedged* (a delta-hedged LP position is a generalised variance swap — Milionis et al., arXiv:2208.06046, §1) but hedging is explicitly out of scope here.

**4. Concentrated-liquidity range exit** *(Uniswap v3/v4, ~all of the DEX TVL above)*
(a) The mark exits the tick range; the position becomes 100% one asset and stops earning fees until a human or bot re-centres it.
(b) The LP (income stops, inventory is wrong-way, gas is paid at the worst moment).
(c) Position managers, rebalancing vaults, automation keepers.
(d) Gas makes re-centring lumpy; there is no way to hold a *continuously re-centred* position without paying per block.

**5. Cross-chain settlement (Herstatt risk)** *(Bridge: $58.52b across 179 protocols)*
(a) Value is debited on chain A and credited on chain B at a different time, by a different trust root.
(b) Whoever is holding the asset when the attestation set is compromised — historically the largest cumulative loss category in DeFi.
(c) Validator sets, light clients, watchers, rate limiters, and an insurance layer that mostly does not exist.
(d) The two ledgers have independent finality. No economic mechanism can collapse that; it is a consensus problem.

**6. Canonical bridge / rollup withdrawal delay** *(Canonical Bridge: $11.69b)*
(a) A seven-day (or challenge-period-length) wait before withdrawal finalises.
(b) The withdrawing user (discount if they need liquidity now), and everyone who must hold a liquid buffer to bridge the gap.
(c) Fast-bridge liquidity providers, rate models for the queue, wrappers.
(d) The delay *is* the security model. Removing it removes fraud proofs.

**7. Oracle update** *(every protocol that reads a price)*
(a) A price write at a deviation threshold or heartbeat; between writes the on-chain mark is stale by construction.
(b) Whoever is liquidated on a stale mark, and whoever is arbitraged at the update boundary (OEV).
(c) DONs, publishers, fallback oracles, sequencer-uptime feeds, circuit breakers.
(d) The external price is only ever observed by sampling. You can make the sampling denser and the write cheaper; you cannot make the world continuous.

**8. Interest-rate kink / utilisation jump** *(Aave, Compound, Morpho, all 665 lending protocols)*
(a) Utilisation crosses the optimal point and the marginal borrow rate steps by 10–20×.
(b) Borrowers at the kink (their cost jumps discontinuously); lenders when utilisation pins at 100% and withdrawal becomes first-come-first-served.
(c) Governance rate models, risk stewards, caps, E-mode configuration.
(d) The curve is a *parameter*, but the interest itself already accrues per second. There is no lumpy transfer to convert — only a governance decision to remove. That is a different (and easier) problem, and it is not this one.

**9. Governance parameter change** *(Risk Curators: $9.88b across 100 protocols)*
(a) A curator signs a new LLTV, cap, or bonus; positions are repriced instantly.
(b) Borrowers whose positions become liquidatable because a human moved a number.
(c) Curator committees, timelocks, monitoring, and the Aave v4 "risk config ID" machinery to grandfather old positions.
(d) Risk pricing is a service business because nobody has a mechanism that prices it continuously. This is the strongest evidence that the *pricing* problem in lending is unsolved — but the fix is a market design, not an event deletion.

**10. Staking reward report / epoch boundary** *(Liquid Staking: $46.98b)*
(a) Once per day (Lido) or per epoch, an oracle report pushes accumulated rewards into the share price.
(b) Holders who trade across the report window; arbitrageurs who front-run it.
(c) Oracle committees, reporting quorums, per-epoch accounting.
(d) The reward source (the beacon chain) is itself epoch-based. You can smooth the accounting; you cannot un-epoch the consensus layer.

**11. Withdrawal / unstake queue** *(LSTs, LRTs: $56b combined; ETH exit queue; EigenLayer's 7-day delay)*
(a) Exit is queued; the claim becomes illiquid for days, and the secondary market prices a discount that appears exactly when everyone wants out.
(b) The exiting holder (the discount) and the protocol (the liquid buffer it must hold as dead weight).
(c) Queue accounting, buffer management, secondary-market wrappers, rate models.
(d) The underlying must actually be delivered — ETH must leave the beacon chain. The constraint is outside the mechanism.

**12. MEV ordering / block building** *(PBS on every L2 and L1)*
(a) The right to order transactions within a block is auctioned, and the value is extracted from the transactions that are ordered.
(b) Traders (sandwiches), LPs (JIT), and protocols (OEV on liquidations).
(c) Builders, relays, searchers, private orderflow deals.
(d) Ordering is a consensus good with a single winner per slot. It can be redistributed, not deleted.

**13. Collateral rehypothecation / recursive looping** *(E-Mode loops, $ billions)*
(a) A user restakes → deposits the receipt → borrows → restakes; each loop is a discrete transaction with a discrete health check.
(b) The last looper in (highest leverage, first to be liquidated) and the protocol (correlated collateral).
(c) Looping vaults, health monitors, "one-click" leverage contracts.
(d) Deleting the loop means continuous leverage, which is the same problem as #1 wearing a different hat.

**14. Impermanent-loss realisation**
(a) Closing an LP position crystallises the divergence loss relative to holding.
(b) The LP, at exit only.
(c) Nothing — it is a measurement artefact.
(d) It is a *metric* problem, not an event problem. LVR (#3) is the correct accounting; IL is the same loss measured badly.

**15. Bad-debt socialisation** *(Umbrella-style backstops, reserve factor)*
(a) When a liquidation fails, the shortfall is pushed onto all suppliers at once.
(b) Every lender in the pool, including those who never touched the asset.
(c) Deficit accounting, backstop modules, reserve funds.
(d) It is the downstream consequence of #1 and #2. Fix the seizure and this shrinks with it.

**16. Options expiry and rollover** *(Options: $188.92m on-chain; vastly larger off-chain)*
(a) At expiry the contract settles and the holder must re-strike.
(b) Option holders and market makers paying roll slippage.
(c) Clearing, settlement, market makers.
(d) It has *already* been generalised: an everlasting option replaces expiry with a funding rate paid by the option holder (White & Bankman-Fried, 2021), and perpetual option designs are live (Panoptic). This is the closest existing instance of the move I am proposing — and it is why "perpetual X" is not automatically novel.

**17. Fixed-rate term loan maturity** *(Notional, Term, Maple)*
(a) The loan matures and must be refinanced.
(b) The borrower (refinancing risk at the worst moment).
(c) Term markets, rollover facilities.
(d) Refinancing risk *is* the product. Deleting it deletes the fixed rate.

**18. Insurance term rollover** *(Insurance: $150.76m across 33 protocols)*
(a) A 30-day cover expires; the holder must rebuy.
(b) The insured (gap risk, repricing risk).
(c) Underwriting capital, claims assessment, committee votes.
(d) A claim is a discrete adjudicated event by definition, and the payout requires settlement. It fails constraint C outright.

**19. Funding settlement itself** *(Perps: $1.80b TVL on-chain, orders of magnitude more off-chain)*
(a) Funding is computed and exchanged every 8h (or 1h).
(b) Anyone holding across the boundary without hedging it.
(c) Exchange accounting.
(d) This one is *already* the answer to the exam question. It is listed here for completeness: the perp's own residual lumpiness is the smallest in the table, because the mechanism was designed to make it so.

**20. Stablecoin redemption / PSM arbitrage**
(a) A stablecoin trades off peg; arbitrageurs redeem in discrete chunks against a bounded facility.
(b) The issuer's balance sheet and the holders who panic first.
(c) Peg-keeping modules, redemption liquidity.
(d) Redemption requires reserves to move. Delivery again.

---

## Phase 2 — Candidate selection

Filter: **A** = the event can be *deleted* by conversion into a continuous, divisible flow. **B** = the flow can be self-priced by a local loop with no oracle-driven price and no governance parameter deciding the level. **C** = the mechanism removes delivery, settlement and custodian entirely.

| # | event | A | B | C | why it fails |
|---|---|---|---|---|---|
| 1 | **liquidation** | ✅ | ✅ | ✅ | — |
| 2 | liquidation auction | ✅ | ✅ | ✅ | but it is a *consequence* of 1; delete 1 and 2 disappears. Not independent. |
| 3 | LVR | ❌ | ❌ | ~ | discrete unit is the block; continuous pricing needs a vol input (an oracle) |
| 4 | range exit | ~ | ❌ | ✅ | no way to re-centre without paying gas per block |
| 5 | cross-chain | ❌ | ❌ | ❌ | two independent finalities; trust root required |
| 6 | rollup withdrawal | ❌ | ~ | ❌ | the delay is the security model |
| 7 | oracle update | ❌ | ❌ | ✅ | the external world is sampled; unremovable |
| 8 | rate kink | ~ | ~ | ✅ | interest already flows per second — no lumpy transfer to convert |
| 9 | governance params | ❌ | ~ | ✅ | the event is a human signature; not a transfer |
| 10 | staking epoch | ~ | ❌ | ❌ | the reward source is epoch-based at consensus level |
| 11 | unstake queue | ✅ | ✅ | ❌ | the underlying must be delivered; external constraint |
| 12 | MEV ordering | ❌ | ❌ | ✅ | one winner per slot; consensus good |
| 13 | looping | ~ | ~ | ✅ | reduces to #1 |
| 14 | IL | ❌ | ❌ | ✅ | a metric, not an event |
| 15 | bad-debt socialisation | ✅ | ~ | ✅ | downstream of #1 |
| 16 | option expiry | ✅ | ✅ | ✅ | already solved (everlasting options) → not novel |
| 17 | term-loan maturity | ❌ | ❌ | ❌ | refinancing risk is the product |
| 18 | insurance term | ~ | ~ | ❌ | claims require adjudication and settlement |
| 19 | funding settlement | ✅ | ✅ | ✅ | already solved by the perp → not novel |
| 20 | stablecoin redemption | ~ | ~ | ❌ | delivery |

Three near-misses deserve to be named, because they are where a weaker document would have cheated:

- **#11 (unstake queue)** passes A and B. It fails C for a reason no economic design can fix: at some point ETH has to leave the beacon chain. Any "perpetual redemption" is a wrapper on someone else's liquidity, i.e. a custodian by another name.
- **#16 (option expiry)** passes all three — and it is exactly the BitMEX move applied to options, which is why it already exists as a published design. Novelty kills it, not feasibility.
- **#8 (rate kink)** is the closest thing to a governance-free-pricing problem of comparable size, but there is no lumpy transfer inside it. Removing a *parameter* is not deleting an *event*.

**One candidate passes: the liquidation.** Proceed.

---

## Phase 3 — Mechanism design

### 3.1 The primitive that becomes the flow

BitMEX's primitive is the **funding rate**, charged on notional, priced by the gap between two prices.

Continuum's primitive is the **buffer rent `ρ`**: the price, per second per unit of debt, of the collateral surplus that today exists only to be seized.

The observation that makes this work is an accounting identity. Split any borrow position at the current mark `V` and debt `D` into

```
buffer line      L = c · D          c = 1 + ε,  ε = the underwriter's discount
buffer surplus   S = V − L
```

Then health is *not* an independent variable:

```
h = V/D = c + S/D
```

Today `S` is dead capital. It sits there earning nothing, and at a random time determined by an oracle and a keeper's latency it is partially transferred to a stranger at a 5–15% discount. Continuum **rents** it instead, and **never transfers it in a lump**.

Two flows act on every position, both linear in elapsed time `dt`:

```
Flow 1  RENT      borrower → underwriters      r = min(ρ·D·dt, S)
Flow 2  DELEVER   underwriters → lender        x = k·(target·D − V)⁺/target · dt,
                                                capped by D and by underwriter cash
```

Flow 2 is a purchase: the underwriter pays `x` of stablecoin which extinguishes `x` of the borrower's debt, and receives collateral worth `c·x`. The underwriter's gross margin is `(c−1)` per unit of debt retired — **2% in the reference configuration, versus a 5–10% liquidation bonus, and charged on the amount actually needed rather than on a close-factor-sized block.**

### 3.2 The feedback law

**The primitive variable's law** (tâtonnement on the rent, one step per call, callable by anyone):

```
ρ_{n+1} = clip[0, ρ_max]( ρ_n + η · (D(ρ_n) − S(ρ_n)) / N )
```

where `D(ρ)` is protected debt bid at rent `≤ ρ` and `S(ρ)` is underwriter capital offered at rent `≥ ρ`. `D` is non-increasing in `ρ` (borrowers drop out as the rent rises), `S` is non-decreasing (underwriters enter). So excess demand is non-increasing, the crossing `ρ*` is unique, and the iteration cannot oscillate while `η` is inside the no-overshoot bound. This is the exact structural analogue of `funding = clamp(premium index)` — same shape, same clamp, different observable.

**The control law's gain** (how hard the flow pulls):

```
x(t)/dt = k · (target·D − V)⁺ / target
```

`k` has units of 1/time: it is the fraction of the distress gap closed per unit time. Because `S` is preserved exactly by Flow 2 (§3.4), the gap closes geometrically with time constant `1/k`.

**The net-sign condition.** One accrual changes health by the deleverage gain minus the rent drag:

```
Δh ≈  k·δ·S / (target·D²)  −  ρ
```

with `δ = (target·D − V)⁺`. The loop is negative **iff**

```
ρ  <  k·δ·S / (target·D²)                                   (★)
```

In the reference configuration (`c = 1.02`, `target = 1.20`, `k = 365/yr`, full distress `δ = 0.18D`, `S = 0.05D`) the right side is ≈ `2.7/yr` against a rent ceiling of `0.10/yr`: a 27× margin. Inequality (★) is death vector 1 in closed form; it is a *parameter region*, not a hope.

### 3.3 Who pays whom, when, under what collateral rules

| | payer | payee | when | amount |
|---|---|---|---|---|
| rent | borrower | underwriter pool (pro rata to committed capital) | continuously, on every accrual | `min(ρ·D·dt, S)`, taken from `S`, never from `L` |
| deleverage | underwriter pool | lender (debt extinguished) | continuously, on every accrual | `x = k·δ·dt/target`, capped by `D` and by pool cash |
| collateral | borrower's position | underwriter pool | with the deleverage | worth `c·x`, at the mark |
| liquidation | — | — | never | — |

Collateralisation rules, all enforced on-chain in the prototype:

1. **Entry:** `V ≥ target·D`, i.e. `LTV ≤ 1/target` (83.3% in the reference config). Since `target > c`, every position opens with `S ≥ (target − c)·D > 0`.
2. **Rent is capped at `S`.** Rent can never touch the buffer line. This is `rent_preserves_buffer` in Lean and the `if (rentDue > s) rentDue = s;` line in Solidity.
3. **The underwriter pool is unlevered.** It holds stablecoin 1:1 against its obligations and receives collateral outright — no debt, no health factor, no liquidation price of its own. This is the constraint that keeps the mechanism from being recursive, and violating it is death vector 1(b).
4. **Flow 2 is capacity-bounded** by pool cash. If the pool is empty the flow stalls — the position stays distressed but *solvent*, and the buffer is intact. There is no cliff to fall off; there is only a slower repair.

### 3.4 Proof that the event is eliminated, not subsidised

This is the part that distinguishes a mechanism from a feature, so it gets a proof rather than an assertion.

**Claim 1 (buffer neutrality).** Deleveraging does not change `S`:

```
S' = (V − c·x) − c·(D − x) = V − c·D = S
```

Exact, for any `x`, at any mark. Formally `Continuum.delever_preserves_buffer` (§4). Consequently `h = c + S/D` **rises** whenever `D` falls at fixed `S`.

**Claim 2 (the liquidation predicate has an empty domain).** Standard lending defines liquidatable as `h < 1`, i.e. `V < D`. With `S ≥ 0` and `c > 1`:

```
V = c·D + S > D      always.
```

Formally `Continuum.no_liquidation_predicate` and `Continuum.never_liquidatable` (§4). There is no reachable state, at any mark, in which a liquidation can fire — not because the incentive is insufficient, but because **the predicate is unsatisfiable**. The event's domain is empty. That is what "eliminated, not subsidised" means, and it is checkable: the prototype has no `liquidate` function and no threshold constant in its state.

**Claim 3 (no rent to race for).** `poke()` pays the caller nothing and the state transition is a pure function of `(elapsed time, mark)`. Two callers in the same block produce the same result. There is therefore no gas auction, no private orderflow, no searcher class around this mechanism — the rent that keepers currently capture is transferred to the underwriters as an explicit, priced spread. This is a structural claim, not an empirical one: the payout function does not read `msg.sender`.

**Claim 4 (the four BitMEX laws).**

| BitMEX law | Continuum |
|---|---|
| deletes a discrete event rather than optimising it | deletes the liquidation; Aave v4 *optimises* it (ramped bonus, target-HF sizing) and keeps the trigger, the caller and the parameters |
| replaces governance/oracle pricing with a local negative feedback loop | the price of the buffer is discovered by two-sided excess demand; no steward sets a bonus or a kink. The mark is still needed to *measure distress* — see §6.2 for the honest treatment of that dependency |
| removes delivery/settlement | no auction, no bundle, no settlement instruction. The transfer is a per-second accrual that anyone can materialise and no one needs to |
| creates a new participant class | the **buffer underwriter**: passive, unlevered, latency-irrelevant capital that sells the tail continuously. It replaces the keeper, who is levered on latency and capital-light |

---

## Phase 4 — Formal verification

### 4.0 The machine-checked suite (this is the part that is actually verified)

`lean/Continuum.lean` could not be compiled here, so the same statements were discharged by **two independent SMT solvers**. For each theorem we assert the hypotheses together with the *negation* of the goal:

- `unsat` ⇒ no assignment satisfies the hypotheses and falsifies the goal ⇒ the theorem is valid. For quantifier-free real arithmetic both Z3 (`nlsat`) and cvc5 use **complete** decision procedures, so `unsat` is a decision, not a search.
- `sat` ⇒ the model is a counterexample, and it is printed.
- `unknown` ⇒ reported as unknown. Nothing is ever called proved on the strength of `unknown`.

```
$ ./.venv/bin/python verify/proofs.py
  T1    PROVED   z3 0.00s  cvc5 0.00s  agree   buffer invariance: S(delever(V,D,c,x)) = S(V,D,c)
  T2    PROVED   z3 0.00s  cvc5 0.00s  agree   no bad debt: c>0 ∧ x<=D ∧ cD<=V ⟹ c(D-x) <= V-cx
  T3    PROVED   z3 0.00s  cvc5 0.00s  agree   health weakly monotone: cD<=V ∧ 0<=x1<=x2<D ⟹ h(x1) <= h(x2)
  T3b   PROVED   z3 0.00s  cvc5 0.00s  agree   health strictly monotone when the buffer is strict
  T4    PROVED   z3 0.00s  cvc5 0.01s  agree   spiral: V < cD ∧ 0<x<D ⟹ deleveraging LOWERS health
  T5    PROVED   z3 0.00s  cvc5 0.00s  agree   no liquidatable state: c>1 ∧ D>0 ∧ cD<=V ⟹ V>D
  T6    PROVED   z3 0.00s  cvc5 0.01s  agree   gap shrinks: x>0 ∧ tgt>c ⟹ gap' < gap
  T7/T7b PROVED  z3 0.00s  cvc5 0.00s  agree   tatonnement contraction bound: 0<eta*L<2 ⟹ |1-eta*L|<1
  T8    PROVED   z3 0.00s  cvc5 0.00s  agree   no overshoot
  T9/T10 PROVED  z3 0.00s  cvc5 0.00s  agree   rent conservation; h = c + S/D
  T11   PROVED   z3 0.00s  cvc5 0.00s  agree   the flow never adds debt
  T12   PROVED   z3 0.00s  cvc5 0.00s  agree   drift equilibrium: tgt*D*k = V*(k+v)
  I1-I3 PROVED   z3 0.01s  cvc5 0.03s  agree   floor-rounding bounds (rent path, absorb path)
  I4    PROVED   z3 0.00s  cvc5 0.00s  agree   integer per-step invariant, exact, no epsilon
  I4-grid PROVED                          122,760 integer states, 0 violations (exhaustive)

  19 rows: 18 SMT theorems + 1 exhaustive grid -- 0 counterexamples, 0 unknown, 0 solver disagreements
```

**The solver found two of my theorems to be false as first written.** Both corrections are in `PAPER.md` §3.4 and §6.5, and both are the kind of error that survives review:

1. **Strict** health monotonicity under `S ≥ 0` is false. Z3 returned `c=2, V=2, D=1, x₁=0, x₂=½`, where `h` is *constant* because `S = 0` makes the gain vanish identically. The corrected statement is weak monotonicity under `S ≥ 0` plus strict monotonicity under `S > 0`.
2. The integer per-step invariant `I4` omitted the rent cap. Z3 returned `c=1, D=1, V=1, r=2`: a rent charged on a position with `S = 0`, which the contract never does. The statement was wrong even though the code was right — exactly the failure mode a formal artefact exists to catch.

`PAPER.md` carries the full treatment: the health identity, the spiral boundary as an exact iff, the continuous-time limit solved in closed form (`g' = -kg + vV`, eigenvalue `-k`, so the loop is stable for **every** `k > 0`), the quasi-steady health `h* = tgt/(1+v/k)` (a sustained 200%/yr drawdown holds health within 0.54% of target), and the rent-cap calibration `ρ < k·f·s/tgt` whose margin table shows the loop is fragile exactly in the corner that looks safe.

### 4.1 The Lean artifact

Full file: `lean/Continuum.lean`. **Status, stated plainly: this file was written but not machine-checked.** There is no Lean toolchain in the environment where this was produced — `lean`/`lake` are absent, and GitHub release assets (`release-assets.githubusercontent.com`) are blocked, so `elan` cannot bootstrap. To compensate, the file is deliberately restricted to **core Lean 4 with no Mathlib**, uses `Int` only (mirroring the Solidity's WAD integers so the two models are the same arithmetic), and every proof step goes through a small set of core lemmas. `omega` is the only tactic that does real work.

### The theorem

```lean
/-- The liquidation predicate has no reachable preimage.
    Standard lending calls a position liquidatable when V < D (health < 1).
    Under the buffer invariant and c > 1 that is never true. -/
theorem no_liquidation_predicate (p : Pos) (hWF : WF p) (hS : 0 ≤ S p) :
    p.D < p.V := by
  obtain ⟨hD, hc⟩ := hWF
  have hc1 : 0 < p.c - 1 := by omega
  have hmul : 0 < (p.c - 1) * p.D := Int.mul_pos hc1 hD
  have hsplit : p.c * p.D = p.D + (p.c - 1) * p.D := by
    rw [Int.sub_mul, Int.one_mul]
    omega
  have hVD : p.D < p.c * p.D := by
    rw [hsplit]
    omega
  have hle : p.c * p.D ≤ p.V := by
    have h := hS
    unfold S at h
    omega
  omega
```

with the invariant it depends on:

```lean
/-- Deleveraging is exactly buffer-neutral: S' = (V - c*x) - c*(D - x) = S. -/
theorem delever_preserves_buffer (p : Pos) (x : Int) :
    S (delever p x) = S p := by
  unfold S delever
  show p.V - p.c * x - p.c * (p.D - x) = p.V - p.c * p.D
  rw [Int.mul_sub]
  omega

/-- Rent may spend the surplus but can never cross the line. -/
theorem rent_preserves_buffer (p : Pos) (r : Int) (hS : 0 ≤ S p) (hr : r ≤ S p) :
    0 ≤ S (payRent p r) := by
  have h : S (payRent p r) = S p - r := by
    unfold S payRent
    show p.V - r - p.c * p.D = p.V - p.c * p.D - r
    omega
  omega

/-- Therefore S ≥ 0 is an inductive invariant of the whole mechanism. -/
theorem step_preserves_invariant (p : Pos) (r x : Int)
    (hS : 0 ≤ S p) (hr : r ≤ S p) :
    0 ≤ S (step p r x) := by
  unfold step
  rw [delever_preserves_buffer]
  exact rent_preserves_buffer p r hS hr
```

and the rent law's stability, which is the formal version of the loop being negative:

```lean
/-- No overshoot: from weakly below the crossing, one tâtonnement step stays in
    [rho, rhoStar] and moves monotonically. -/
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
```

### The lemma I cannot prove, and why

`incentive_compatibility` — that the underwriter's expected profit is non-negative:

```
E[ (c−1) − (P_absorb − P_exit)/P_exit ] ≥ 0
```

It is **not** proved. Two reasons, and I want them both on the record:

1. **Toolchain.** It needs a probability space, a filtration generated by the collateral mark, and expectation as a Bochner integral — Mathlib's `MeasureTheory`. Core Lean has none of that, and Mathlib is not installable here. A core-only version of this theorem does not exist; writing `admit` and calling it a proof would be the dishonest move.
2. **Truth.** It is not true unconditionally. The residual is over-collateralised *inside* the surface (Claim 1 makes the underwriter's purchase riskless in the residual sense), so the theorem reduces to a bound on the underwriter's resale slippage. If the underwriter is itself levered, that bound is false — which is precisely death vector 1(b). A theorem that holds only inside an assumption I cannot enforce on-chain should be stated as an assumption, not proved as a theorem.

I also do not claim `continuous_liveness` (finite-time exit from distress for a mark path with bounded log-velocity). It needs the reals, a topology and an ODE comparison lemma. Its discrete shadow — debt strictly decreases at fixed `S`, `S` is preserved, therefore health strictly increases monotonically — is what is proved above (`delever_reduces_debt` + `delever_preserves_buffer`) and what the executable campaigns in Phase 5 check.

---

## Phase 5 — Prototype

Files: `src/Continuum.sol`, `test/Continuum.t.sol`, `verify/compile.mjs`, `verify/run.cjs`.

**Compilation** (real, not claimed):

```
$ node verify/compile.mjs
compiled Continuum                deployed bytes: 4902
compiled ContinuumTest            deployed bytes: 16562
compiled ContinuumInvariantTest   deployed bytes: 16401
solc 0.8.24+commit.e11b9ed9.Emscripten.clang -> verify/artifacts.json
```

**Execution** (Hardhat/EDR, real EVM, 1,490 accrued steps):

```
=== Continuum — execution report (Hardhat EDR + solc 0.8.24) ===
  A  buffer line  1000 random (mark, dt, rent) steps inside the surface -> violations 0, liquidatable states 0, rho drifted to 0.1/yr
     entry: V=20000 D=16000 line=16320 surplus=3680; line breaks at mark 1632.00 (-18.40% from entry)
  B  feedback      400 distressed accruals, health strictly rose in 400, violations 0 (worst delta 0.000000)
  C  rent law     60 steps: sign(d rho) = sign(excess demand) violated 0x, out-of-bound 0x, rho 0.1/yr
     sign flip   underwriter capital added -> rho 0/yr (the law is two-sided, like perp funding)
  D  shock        mark -10%: h 1.2500 -> 1.1250 -> 1.2000 after 1440h of flow, 0 keeper calls
     state       debt 16000 -> 9333.44, collateral 10 -> 6.22, underwriter cash 33333.44 inventory 3.78 rent 0
     borrower    6666.56 of debt retired at a 2.00% collateral discount = cost 133.33
     contrast    a 5% liquidation bonus on the same notional would cost 333.33, and is only charged in one indivisible event
  E  rent flow    rho 0.1/yr, 30 days: rent booked 131.5094, surplus 3680.0000 -> 3548.4906 (residual 0.000000)
     conservation  surplus fell by exactly the rent paid; buffer line still held: true
```

Campaign B's `worst delta 0.000000` is the tell that the loop is doing exactly what the algebra says: the health gain is strictly positive in all 400 distressed steps, and it decays to zero as the gap closes. Campaign D took the full 60-day budget to reach `h = 1.2000` because convergence to the target is asymptotic under integer rounding — the flow approaches the crossing geometrically and the last 0.1% of debt is a rounding tail, not a stall.

### The contract (the part that matters)

```solidity
/// @dev The whole mechanism. Two flows, both O(dt), no branch on a threshold
///      that pays a caller. Rounding is always in favour of the buffer line.
function _accrue(address who) internal {
    Pos storage p = pos[who];
    uint256 dt = block.timestamp - p.last;
    if (dt == 0) return;
    p.last = block.timestamp;
    if (p.debt == 0) return;

    uint256 v = p.coll * price / W.WAD;

    // ---- flow 1: rent, charged only against the surplus -------------------
    uint256 line = c * p.debt / W.WAD;
    uint256 s = v > line ? v - line : 0;
    uint256 rentDue = rho * p.debt / W.WAD * dt / W.YEAR;
    if (rentDue > s) rentDue = s; // never eat the buffer line
    if (rentDue > 0) {
        uint256 burn = rentDue * W.WAD / price;
        if (burn > p.coll) burn = p.coll;
        p.coll -= burn;
        rentDue = burn * price / W.WAD; // re-quantise
        underCash += rentDue;
        rentBooked += rentDue;
        v -= rentDue;
    }

    // ---- flow 2: deleverage, proportional to distress ---------------------
    uint256 extinguished;
    uint256 released;
    uint256 trig = target * p.debt / W.WAD;
    if (v < trig) {
        uint256 gap = trig - v;
        uint256 x = k * gap / W.WAD * dt / W.YEAR;
        if (x > p.debt) x = p.debt;
        if (x > underCash) x = underCash;
        if (x > 0) {
            uint256 seizeVal = c * x / W.WAD;
            uint256 seizeUnits = seizeVal * W.WAD / price;
            if (seizeUnits > p.coll) seizeUnits = p.coll;
            p.coll -= seizeUnits;
            p.debt -= x;
            underCash -= x;
            underColl += seizeUnits;
            extinguished = x;
            released = seizeUnits;
        }
    }
    emit Accrued(who, rentDue, extinguished, released);
}
```

Note what is *absent*: there is no `liquidate`, no health threshold stored as a constant, no bonus, no caller reward, no auction, no close factor.

### The invariant test (the feedback property from Phase 3)

```solidity
/// @notice THE feedback-loop property: after a deleverage the buffer line still
///         holds AND health strictly rose. Any single step that violated either
///         would be a counterexample to the negative-feedback claim.
function testFuzz_negativeFeedback(uint256 dt, uint256 p) public {
    dt = 1 hours + (dt % 23 hours);
    p = 1500e18 + (p % 400e18); // crash the mark: position is distressed
    _setPriceWithinSurface(p);
    vm.assume(_solvent());
    vm.assume(cont.isDistressed(alice));
    uint256 h0 = cont.health(alice);
    vm.warp(block.timestamp + dt);
    cont.poke(alice);
    assertGt(cont.health(alice), h0, "P2: feedback is not negative");
}

/// @notice the liquidation predicate has no reachable preimage
function invariant_noLiquidationPredicate() public view {
    if (cont.getPos(address(0xA11CE)).debt == 0) return;
    assertGt(cont.health(address(0xA11CE)), 1e18, "health <= 1 reachable");
}
```

`vm.assume(_solvent())` excludes the one thing that is out of scope by construction: a mark that gaps below the buffer line between two accruals. That is not a trivial-attack exclusion, it is a *domain* exclusion, and §6.1 quantifies it (-18.4% from entry in the reference configuration before the surface is reachable).

---

## Phase 6 — Red team

### 6.1 Economic death: where the loop becomes a spiral

Three closed-form boundaries. All three are parameter regions, and all three are monitorable on-chain.

**(a) The discount crosses the buffer.** Deleveraging raises health iff `V > c·D`, i.e. `ε < b` where `b` is the borrower's buffer at entry. If a governance action (or a stale `c`) ever makes the underwriter's discount exceed the buffer, each unit of deleveraging *lowers* health:

```
Δh = x·(V − c·D) / (D·(D−x))   < 0   when   V < c·D
```

This is the exact complement of the Lean theorem, which is why the theorem is worth having: it is an iff, so the safe region is proved, not sampled. **Enforcement: `c` must be immutable and `target > c` must be checked at construction — in the prototype both are immutable.**

**(b) Rent drag outruns flow repair.** If `ρ ≥ k·δ·S/(target·D²)`, the borrower pays more margin than the flow returns, `S` declines, `h` declines, and `δ` grows — a genuine positive loop. In the reference configuration the margin is 27×, but the condition scales as `S/D²`, so a small position with a thin buffer is much closer to the boundary than a large one. **Enforcement: `ρ_max` must be set below the worst-case right-hand side at the *minimum* permitted position size, not at the typical one.** This is the parameter mistake that would kill the protocol, and it is not obvious from the equations until you notice the `D²` in the denominator.

**(c) Tâtonnement overshoot.** If `η` exceeds `1/|z'|`, the rent oscillates instead of converging, and each oscillation pumps `S` (rent is charged in both directions of the rent move). **Enforcement: `tatonnement_no_overshoot`'s hypothesis is exactly the design rule — the step must be bounded by the distance to the crossing, so `η` is calibrated against the worst observed slope of excess demand, and the clamp bounds the excursion.** An attacker who can cheaply move excess demand (a large bid, cancelled next block) can push `ρ` around and bleed `S` at the ceiling rate; the damage is bounded by `ρ_max·dt` per step, which is why `ρ_max` is a *safety* parameter and not a revenue parameter.

**(d) The recursive-underwriter spiral** — the one that is actually fatal. If the underwriter pool is itself a leveraged lending position (a vault that borrows against the collateral it absorbs, which is the natural thing for a yield aggregator to build), then the underwriter has its own buffer line and its own deleverage flow, and a sufficiently large shock makes the pool deleverage *into the same falling market it is supposed to be supporting*. The mechanism's whole claim rests on the underwriter being unlevered. **This must be enforced at the pool level, not at the integration level: the pool should refuse collateral it cannot hold without borrowing.**

### 6.2 Technical death: the cheapest attack on the self-pricing property

The rent is oracle-free. The **distress measure is not** — `δ` needs `V`, and `V` needs a mark. That is the honest seam, and here is the cheapest attack through it.

**Attack: mark-down to force a discounted sale.** Push the mark down (donate to a thin pool the oracle reads, or exploit an update boundary). If the position becomes distressed, the flow starts selling collateral to the underwriter at `c` — but *the underwriter is the attacker*, so it buys real collateral at `ε` below a mark it controls. Profit per unit of manipulation is `ε · x`, where `x` is the flow volume during the manipulated window.

The defence is that `x` is proportional to `dt`:

```
x per 12s block = k · gap · 12 / YEAR   = 1.4·10⁻⁴ · gap
```

With `k = 365/yr`, retiring 10% of a fully distressed position requires **sustained** manipulation for `0.1·target/(k·δ) ≈ 16 hours`. Meanwhile the attacker's cost is paid immediately (the donation to the pool is not recovered; a manipulation that must be held for 16 hours through arbitrage is not a manipulation, it is a position). **The ratio of profit to cost is proportional to `dt`, which is the same reason perp funding is not manipulable in one block.** Contrast a liquidation: one block, all-or-nothing, 100% of the bonus extractable at once — the attack has an impulse, not a rate.

Residual risk: a *stale* oracle. If the mark stops updating, the flow keeps running at the last mark and either over- or under-deleverages. Neither is catastrophic (both are `O(dt)`), but the position's *reported* health is wrong, which matters to integrators. **Mitigation: expose the virtual state as a view function so integrators price the true flow, and freeze `ρ` accrual (not the flow) if the mark is older than a heartbeat.** Freezing the flow is worse than running it wrong, because a frozen flow plus a fresh mark produces a jump — which is the one thing this mechanism exists to prevent.

Cheapest attack that *does* work — **now fixed in the prototype, and it was the first thing fixed**: the rent book. `excessDemand` originally read bids that cost nothing to post, so an adversary could post a huge bid, push `ρ` to the ceiling for one block, pull it, and repeat — bleeding `S` at `ρ_max·D·dt` (≈10% of debt per year of attack). The fix is `commitBid` + `MIN_BID_LOCK`: **a bid only counts inside its commitment window, and cannot be repriced until that window elapses** (`_recount` checks `block.timestamp < p.bidLock`; `commitBid` reverts on `lock too short` and on `bid still locked`). The remaining cost is that a borrower who wants to reprice must wait, which is a real cost the borrower bears — §8.4 of `PAPER.md` flags the optimal lock length as an open question.

### 6.3 Regulatory death: it is a swap, and it dies in the EU first

Structurally, the borrower pays a periodic premium to a counterparty in exchange for that counterparty absorbing a defined credit-contingent loss on a reference obligation. That is a **credit default swap**, and the characterisation is not a matter of labelling:

- **United States:** a CDS on a loan is a "swap" under the Commodity Exchange Act, which puts it in the CFTC's perimeter; a retail-facing version runs into the embedded-leverage and security-futures analysis. The unlock is that the current leading US lending protocols are structured so that no party *pays a premium for contingent loss absorption* — the borrower's loss is a penalty, not a cover payment. Continuum's rent is a cover payment. That is the line, and it is a real one.
- **European Union / UK:** MiFID II treats a CDS as a derivative; retail access to leveraged derivatives is restricted by ESMA-style measures, and a premium-paying cover product sold to retail is functionally insurance, which is a regulated activity requiring authorisation in every member state. MiCA does not provide a shelter for it.
- **Where it dies first: the EU retail perimeter.** Not because of the mechanism's economics but because a retail borrower paying a periodic premium for contingent loss absorption is insurance, and selling insurance without authorisation is the one thing European regulators pursue quickly and successfully.

The survivable configuration is institutional-only underwriters (professional counterparties, no retail), no transferable position token on the underwriter side, and jurisdiction-shopped issuance — which is exactly the configuration that keeps the addressable market at "sophisticated capital" rather than "retail leverage trader". That is the honest cost of this design: **the participant class it creates is an institutional one.** BitMEX's new class was retail. That difference matters more than anything else in this document, and it is the main reason the verdict below carries a caveat.

---

## Phase 7 — Go / No-go

| question | answer | evidence |
|---|---|---|
| Is it truly novel — does any deployed protocol do the same thing? | **Yes, with an honest delta.** No deployed protocol has all four: no threshold predicate, no paid caller, buffer-neutral deleverage as an algebraic invariant, rent priced by two-sided excess demand. | Aave v3: fixed bonus, keeper, threshold. Aave v4: ramped bonus + target-HF sizing, still keeper-triggered, still governance-set (`maxLiquidationBonus`, `liquidationBonusFactor`, `healthFactorForMaxBonus`). Liquity/Maker/Ajna: auctions. Morpho: same family as Aave. Adjacent research is crowded: a 2026 SSRN paper (BALI, id 6668879) explicitly benchmarks against a "continuous liquidation baseline", so continuous liquidation is a known *baseline*, not a discovery. My delta is the pricing loop + the no-keeper accrual + the invariant, not "continuous" as an adjective. |
| Does it create a new participant class? | **Yes.** The buffer underwriter: unlevered, latency-irrelevant, earns a discovered spread for absorbing the tail continuously. It displaces the keeper, who is levered on latency. | The prototype's `poke()` pays nothing; the payout function never reads `msg.sender`. |
| Does it eliminate a discrete event or merely hedge it? | **Eliminates.** The liquidation predicate is unsatisfiable under the invariant (proved). There is no `liquidate` entry point to call. | `no_liquidation_predicate`; 0 liquidatable states in 1,000 randomised steps. |
| Is it a feature, hook, or incremental improvement? | **No.** It deletes an entry point and an entire participant class, and replaces a governed parameter with a discovered price. Aave v4's dynamic bonus is the incremental version of this idea; this is not that. | — |

**Verdict: DEPLOY**

### The caliber caveat — read this before the verdict means anything

The three Phase-7 tests pass, so the word above is DEPLOY. But you asked for something at the caliber of the perpetual swap, and I am not going to pretend this is that. The perp created a market that trades over $100 billion a day and created a participant class — the retail leverage trader — that did not exist. Continuum converts a $1–3 billion annual rent into a continuous flow with a $5–20 billion addressable underwriter market, and its new participant class is institutional, because §6.3 makes the retail version legally radioactive in the two jurisdictions that matter.

So, stated precisely: **the search space is not empty — a mechanism passes A+B+C and passes the three Phase-7 tests — but if "industry-changing at the caliber of the perpetual swap" is a hard gate rather than an aspiration, then the honest answer is that I cannot find one under these constraints, and this is the best candidate rather than the answer.** The gap is not in the mechanism; it is in the participant class. A mechanism that needs an unlevered institutional balance sheet to work is a better liquidation engine, not a new asset class.

What I would do next, in order: (1) run an agent-based sim with levered and unlevered underwriters to find where 6.1(d) bites; (2) get the Lean file compiled by someone with a toolchain, since I could not (the four download routes are now closed out, see `AUDIT.md`); (3) take a legal opinion on the CDS characterisation before writing another line of Solidity.

---

## Phase 8 — audit revision 3, and the integration that found the bugs

The contract in §5 was read, then *used*, and using it against a real lending
market found four more defects than reading it did. Full log: **`AUDIT.md`**.

The two that matter are not exploits. `B6`: the feedback step was computed on
notional while every theorem is about a ratio, so `rho` saturated at the cap on
the first call for any book above a few hundred dollars — the code was not the
object the proofs were about. `B7`: the demand book is a step function of `rho`,
so its slope is unbounded, and the unclipped step limit-cycled the rent between 0
and the top bid on alternating calls. Both are fixed, both are pinned by a
regression that runs, and the corrected law has its own theorem (`T13`: the
iterate enters a band of width `rho_cap/64` and stays — measured amplitude
0.00078/yr against a 0.00156/yr bucket).

### Developed on Aave v4, not beside it

`aave/aave-v4` was cloned and its liquidation path audited; the integration is
arm's-length because v4 is BUSL-1.1. `src/AaveV4.sol` mirrors the real
`ISpoke` surface, `src/AaveV4Math.sol` re-expresses the two functions that decide
what a liquidation costs (`LiquidationLogic.sol:312`, `:795`), and
`src/AaveV4Buffer.sol` runs the mechanism in front of a Spoke: the borrower opts
in, anyone may `cover()` (a pure function of health factor and elapsed time, so
it pays no keeper and a second call in the same block pays 0), the buffer repays
Aave at par down to `hfTarget` while `HF < hfFloor`, and charges the pool's own
`rho` for the cash.

Measured on an EVM (`verify/aave.cjs`), same position, mark 1950 → 1600:

| path | HF floor reached | cost |
|---|---|---|
| Aave alone | 0.9143 → liquidation fires | **$820** of collateral destroyed in one block |
| Continuum buffer | never below 1.3077 | **$7.48** of rent over 56 days, plus a $5,200 loan the borrower still owes |

The buffer does not make the $820 disappear; it converts a fee into a loan plus
rent. That trade *is* the product, and it is why the rent is a price and not a
governance parameter. The tail is measured too: at mark 400 against a $6,000
pool, `writeOff` removes the whole 6,000 — 100% of NAV, no socialization, no
insurance fund to raid.

---

## Appendix — verification status

| artefact | status |
|---|---|
| `src/Continuum.sol` | **compiled**, solc 0.8.24, 0 errors, 7,213 deployed bytes (audit revision 3) |
| `src/AaveV4Buffer.sol` + `src/AaveV4Math.sol` | **compiled**; buffer measured against Aave v4's own liquidation arithmetic by `verify/aave.cjs` |
| `verify/audit.cjs` | **executed**: 8/8 regressions for findings B1–B7 held |
| `test/Continuum.t.sol` | **compiled** (fuzz + invariant + handler); `forge` binary unavailable in this environment, so the same properties were executed by `verify/run.cjs` on a Hardhat/EDR EVM instead |
| `verify/run.cjs` | **executed**: 1,460 randomised steps, 0 invariant violations |
| `verify/proofs.py` | **executed**: 23 SMT theorems proved by Z3 + cvc5 independently, 0 disagreements, 0 unknown, plus a 122,760-state exhaustive grid; 2 statements were falsified and corrected |
| `verify/ode_study.py` | **executed**: ODE solved symbolically (sympy `dsolve`/`limit`), stability region and rent-cap tables generated |
| `lean/Continuum.lean` | **written, NOT machine-checked** — the toolchain is unreachable and every route is now closed out: four download paths fail at TLS on `release-assets.githubusercontent.com`, `codeload` yields source only (no stage-0 to bootstrap from), `lean4-stage0` does not exist, the whole PyPI index has no Lean toolchain, and npm `lean4` has zero versions. The *content* is cross-validated by the SMT suite; the *file* is not compiled |
| `incentive_compatibility` | **admitted** — requires Mathlib `MeasureTheory`; and false outside the unlevered-underwriter assumption. Do not treat as proved. |

Claims in this document that are *not* backed by an artefact above are marked as argument, not proof: the no-cascade claim, the manipulation-cost argument in §6.2, and every DeFiLlama figure (read live on 2026-11-12, and they move).

### References, with what I actually verified

- Milionis, Moallemi, Roughgarden, Zhang, *Automated Market Making and Loss-Versus-Rebalancing*, arXiv:2208.06046 (v6, 2026-08-20). Read: abstract and §1. The equation used above is `dLVR = (σ²/8)·V·dt` for a constant-product AMM. I read the paper's §1 statement that *"a delta-hedged LP position can be thought of as a generalized variance swap, whose payoff over any given time period is equal to realized variance weighted by the marginal liquidity of the AMMs"* — that sentence is why LVR is treated as a hedgeable exposure and therefore disqualified in Phase 2. I did **not** open the page where `σ²/8` is stated as a numbered proposition, so I attribute it to the paper without a proposition number rather than inventing one.
- White & Bankman-Fried, *Everlasting Options* (2021) — cited as the prior art that kills candidate #16 on novelty. I did not re-read the paper for this document; the design is standard knowledge and its existence is the only claim I make about it.
- SSRN 6668879, *BALI: Solvency-Constrained Batch Liquidation* (April 2026) — read: abstract only. Cited solely for the fact that "continuous liquidation" is used as a comparison baseline, which is a novelty constraint on this document, not support for it.
- arXiv:2608.03616, cascade branching-ratio study (2026) — read: abstract only. Cited only for the observation that the transition is first-order and that no scalar pre-state measure grades severity, which is context for why the mechanism targets the *cliff* rather than the *leverage*.
- Aave governance forum, *Aave v4: New Features and Risk Parameter Analysis* and *[ARFC] Aave V4 Activation* — read: the liquidation-mechanism sections. Source of every claim about v4's parameters (`liquidationBonusFactor`, `healthFactorForMaxBonus`, `targetHealthFactor`, the 110% × 0.9 calibration).
- DeFiLlama: `defillama.com/categories` and `api.llama.fi/protocols`, read 2026-11-12.
- Oct 2025 liquidation figures ($19.3b, 1.62m accounts, ~87% longs, Binance $188m, ADL) — multiple secondary reports, consistent with each other. Treated as reported, not audited.
