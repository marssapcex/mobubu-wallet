# Pre-audit gap list — what to build before paying for a top-tier audit

Read end-to-end against `ContinuumMarket.sol` at 13,736 B. The question this file
answers: *if a firm like Spearbit or Trail of Bits received this today, what
would they return it for?*

**Short answer.** As a mechanism, it is a lending market: it takes deposits,
lends against collateral, charges a rate, repays, marks to market, and realises
losses. As a *launchable* market it is missing four things that any auditor will
refuse to work around — a stale specification, no way to stop the thing, an
oracle with a single point of failure, and an irreversible loss switch anyone can
pull. None of them is research; all of them are days of work.

---

## 1. What is actually done — do not rebuild these

| feature | where | state |
|---|---|---|
| Supply / withdraw, share accounting, virtual offset against inflation | `deposit`, `withdraw`, `previewDeposit` | done (`(supply+1)/(assets+1)`) |
| Collateral in/out with buffer-line gate | `depositCollateral`, `withdrawCollateral` | done |
| Borrow against the *target* line, idle-floor and both caps | `borrow`, `_borrowGates` | done |
| Continuous accrual: rent on debt, capitalised, capped at the buffer line | `_chargeRent` | done |
| Repair flow: debt at par for collateral at `c` discount | `_deleverage` | done |
| Two-sided rent clearing with a bid book | `setBid`, `updateRho`, 64 buckets | done |
| Loss realisation | `writeOff` | done, but see F15 |
| Fee-on-transfer rejection, reentrancy guards, own ERC20, own math | `SafeTransferLib`, `nonReentrant` | done |
| Chainlink adapter with staleness + `answeredInRound` + decimals | `oracle/Oracles.sol` | done |
| Rotation of risk admin, caps, borrow freeze | `setRiskParams`, `setRiskAdmin` | partially |

That is a real skeleton. The rest of this file is what sits on top.

---

## 2. P0 — an auditor returns the engagement without these

### P0-1. The specification is out of date with the code

`assets()` has four terms in code and three in the whitepaper; the whitepaper
predates `rateDebt`, `pendingRent`, `_adjustRates`, and F9's fix. The Lean model
and the SMT encoding describe the pre-F9 transition relation.

An auditor's first step is to diff the model against the implementation. Handing
over a spec that no longer matches means either they audit the wrong system, or
they bill two weeks to reconcile. **Effort: 2 days** (rebuild PDF, update Lean
`Step`, re-run SMT, re-run the four harnesses). **This is the cheapest item on
the list and the one that costs the most if skipped.**

### P0-2. Nothing can be stopped

There is no pause and no shutdown. `borrowFrozen` blocks new borrows and nothing
else: `poke`, `pokeMany`, `updateRho`, `_deleverage` and `writeOff` all keep
running against whatever the oracle says. If the feed is wrong, the flow will
happily buy collateral at a discount derived from a wrong price and `writeOff`
will realise losses at it.

Needed: a `guardian` role that can (a) freeze borrowing, (b) freeze the flow,
(c) freeze write-off — separately, because they have different failure modes.
Must **not** be able to touch principal or block `repay`. Must **not** be able to
stop `withdraw` of idle cash. **Effort: 0.5 day**, plus the transition-relation
update.

### P0-3. The oracle is a single point of failure by construction

`ChainlinkOracleAdapter` checks answer sign, `answeredInRound`, and staleness —
better than most. Still missing:

- **sequencer uptime feed** if deployed on any L2 (Arbitrum/Base/OP): a stale
  answer during sequencer downtime is indistinguishable from a quiet market;
- **deviation guard**: no comparison against a second source, so a single feed
  compromise is a single write to `price()`;
- **no fallback**: a reverting feed reverts `poke`, which stops repair *and*
  stops rent accrual — the market freezes quietly rather than loudly.

Needed: a median-of-two or feed-plus-TWAP adapter, a deviation circuit breaker
that freezes the flow (P0-2), and a documented "oracle down" runbook. **Effort: 1
day.**

### P0-4. `writeOff` is an irreversible switch anyone can pull (F15)

One call at a bad print converts a repairable position into a realised loss for
every lender, and destroys the borrower's recovery option at the same time.
Fix: flow-first + a breach grace denominated in blocks. **Effort: 0.5 day code +
1 day spec/proofs.** See `FINDINGS.md` F15.

### P0-5. No loss waterfall, no reserve

`writeOff` socialises 100% of the shortfall into the share price instantly.
There is no reserve to absorb it, no ordering (reserve → lenders), no disclosure
of `totalWrittenOff` in the UI contract. Auditors treat "loss accounting is one
line" as an unfinished design. **Effort: 1 day** (a `badDebtReserve` fed by a
share of rent, plus a documented waterfall).

### P0-6. Token assumptions are unchecked

- `safeTransferIn` rejects fee-on-transfer — good, but the check itself must be
  documented as a *deployment constraint*;
- rebasing collateral (stETH and friends) breaks `p.coll` accounting silently;
- `10 ** decimals()` overflows above 77 and the value scaling assumes the two
  tokens are sane relative to each other; no `require(decimals <= 18)`.

Needed: constructor assertions + an explicit supported-token list in the docs.
**Effort: 0.25 day.**

### P0-7. No exposure limits per position

`borrowCap` is global. One address can open a position equal to the entire book,
which defeats every diversification argument the pool makes to lenders. Needed:
a per-position cap and a minimum-size floor. **Effort: 0.25 day.**

---

## 3. P1 — needed to call it a product, can ride in the same audit

8. **`repayFor(who, amount)`** — nobody can rescue a position they do not own.
   Also `depositCollateralFor`.
9. **Withdrawal fairness.** `withdraw` reverts on `InsufficientCash` and nothing
   queues: first-come-first-served during a run. Either document it loudly or add
   a queue. Auditors will ask which.
10. **Idle cash earns nothing.** True by design (rent only accrues on borrowed
    debt) — but a lender comparing against Aave needs it in the docs, and the
    `idleFloor` makes ~20% of deposits permanently unlent.
11. **No `rescueTokens`.** Tokens sent to the wrong address are stuck forever.
    A guarded rescue that cannot touch accounted balances.
12. **No `permit` / EIP-2612** on shares. UX only.
13. **No cap ramping.** Launching with a hard `depositCap` and raising it by
    governance is the standard practice; currently a single instant admin call.

---

## 4. P2 — the audit pack itself

Top firms quote against what you hand them. Cheap to prepare, expensive to omit:

14. **Threat model**, written adversarially (who profits from what), not a list
    of features.
15. **Invariant list in executable form** — Foundry `invariant_*` handlers with
    5+ actors and a bounded action set. Right now the invariants live in
    JavaScript campaigns, which is fine for research and is not what an auditor
    will accept as evidence.
16. **Coverage report** and a gas snapshot per entry point.
17. **Known-issues file** — F9–F15 with status. Auditors price a disclosed issue
    at zero; discovering the same thing costs you the finding.
18. **Deployment runbook + monitoring spec**: what an operator watches (oracle
    age, `imbalance`, `totalWrittenOff`, cash/idle-floor breach) and what they do.
19. **Dependency review** — none, which is a genuine selling point; say it.

---

## 5. The two questions that are economics, not code

**a) The rent is not anchored to the risk being sold.** The clearing rent is
~1%/yr against a position 2% out of the money; a put with that strike is worth
several percent. Nothing in the mechanism forces the rent up to the break-even of
the underwriter, so the market clears at whatever borrowers will pay until the
tail arrives (campaign E: a gap to mark 600 takes 100% of NAV). Fixing this is a
pricing/model study, not a patch — and no auditor will do it for you.

**b) The rent cap is a free option for distressed borrowers.** `rentCap` stops
the rent exactly when the position approaches the buffer line, so the borrower
pays nothing at the moment the protection is most valuable. This is a deliberate
choice to protect the invariant — but it must be priced, or the pool's revenue is
anti-correlated with its risk.

Both belong in the whitepaper as stated limitations **before** the audit, not
after.

---

## 6. Suggested order

| batch | contents | est. |
|---|---|---|
| 1 | P0-1 spec resync (whitepaper, Lean, SMT, harnesses) | 2 d |
| 2 | P0-2 guardian, P0-4 F15 fix, P0-6 token guards, P0-7 per-position cap | 1.5 d |
| 3 | P0-3 oracle hardening, P0-5 loss waterfall | 2 d |
| 4 | P1 items 8–13 | 2 d |
| 5 | P2 audit pack incl. Foundry invariant handlers | 3 d |

~10 working days to a handover that does not waste the first week of a paid
engagement. After that the code is auditable; the economics still need the
pricing study in §5, which no amount of engineering replaces.
