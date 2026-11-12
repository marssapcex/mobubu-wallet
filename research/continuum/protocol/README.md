# ContinuumMarket — a lending market with no liquidation function

One collateral asset, one debt asset, one mechanism: **borrowers rent their
buffer instead of insuring it against a penalty that fires on a threshold.**

This is the shipping contract set, not the prototype in `../src/Continuum.sol`.
The prototype exists to make the paper's theorems testable; this exists to be
deployed, audited and attacked.

```
protocol/
  src/
    ContinuumMarket.sol     the market: positions, pool, rent law, flow
    ContinuumShares.sol     lender shares (ERC20, mint/burn restricted to the market)
    lib/BufferMath.sol      every inequality in one place, with its rounding
    lib/SafeTransferLib.sol token movement that cannot silently fail
    oracle/Oracles.sol      IOracle, FixedOracle, Chainlink adapter
    token/ERC20.sol         minimal ERC20, no extensions
  test/
    ContinuumMarket.t.sol   fuzz + unit suite (forge-std)
    mocks/                  MockToken, PokeProbe
  script/Deploy.sol         deployment, parameterised
  audit/                    scope, findings, and what to attack first
```

## The three structural decisions

**1. The penalty became a rent.** There is no bonus, no close factor, no
liquidation fee, and no one is paid to call anything. A borrower pays
`min(rho, bid) × D × dt` continuously; it capitalises into the debt, which is
exactly where the lenders' yield comes from. The rent is capped at
`BufferMath.rentCap` so it can never eat the buffer line.

**2. There is no keeper.** `_materialise` is a pure function of
`(elapsed time, price, rent)`. `poke` pays nothing, so no one races for it, and
two pokes in one transaction produce the same state as one — measured, not
asserted (`PokeProbe`). The protocol owes the borrower the same state whether a
bot shows up or not.

**3. The invariant is the safety mechanism.** `S = V − c·D ≥ 0`, computed on one
numerator (`V·WAD` against `c·D`) so no rounding can fake it. With `c > 1`,
`S ≥ 0` implies `V > D`: the liquidatable predicate has no preimage. This is
maintained by the market's own transitions — `depositCollateral`,
`withdrawCollateral`, `borrow`, `repay`, `poke`, `updateRho` — and the only thing
that can break it is a price gap, which `writeOff` books immediately.

## Accounting identities

```
assets()     = cash + loans + inventoryValue() + pendingRent()
pendingRent() = unbookedRent + rateDebt()*elapsed/YEAR     <- keeps NAV honest with no keeper
shares.price = assets() / shares.totalSupply()
S(position)  = V*WAD - c*debt                              (exact, WAD-scaled)
```

`pendingRent` exists because the rent is accrued lazily per position: without it,
`assets()` would understate what borrowers owe, and a depositor arriving after a
long silence could buy in cheaply and capture other people's rent (finding F9).
It is maintained in O(1) as `A + rho·M` — buckets below the rent are fixed at
their edge, buckets above contribute the rent — so a rent move reclassifies at
most one bucket.

`loans` grows by rent (lender yield) and shrinks by repayment and deleverage.
`inventory` grows only through deleverage, where the pool buys collateral at
`1/c` of the mark and sells it at the mark via `buyInventory` — that spread, not
a liquidation fee, is what the pool is paid for holding spot risk.

## Parameters

| parameter | meaning | sensible value |
|---|---|---|
| `c` | buffer discount; the pool buys collateral at `1/c` of the mark | `1.02` (2%) |
| `target` | flow switches on below `target·D` | `1.20` (83% LTV) |
| `k` | flow speed, fraction of the gap closed per year | `365` (full gap in a year) |
| `rhoCap` | ceiling on the rent | `0.10` (10%/yr) |
| `eta` | gain per `updateRho` call | `0.02` |
| `minBid` | floor on a borrower's bid, and the floor on `rho` | `0.01` |
| `idleFloor` | fraction of debt that must stay idle | `0.20` |

`idleFloor` is load-bearing: the flow can only repair what it can pay for. At
`target = 1.20` and `c = 1.02`, a fall to the buffer line costs about
`(1 − c/target) ≈ 15%` of the debt, so 20% idle cash is what makes the protection
real rather than advertised. **Utilisation above `1 − idleFloor` is refused.**

## What this market does not do

- It does not pause accrual. A pause would break decision 3, so there is no
  pause switch; `borrowFrozen` can only stop *new* borrowing.
- It does not promise redemption on demand. `withdraw` is limited by idle cash;
  when the pool is fully lent out, redemption queues behind repayment. The
  alternative — a guaranteed redemption — is how lending markets become banks
  that cannot pay.
- It does not socialise bad debt through a token or a backstop. `writeOff` books
  the shortfall against `loans` immediately, so the share price tells the truth
  the same block it becomes false.
- It does not claim the oracle is safe. See `audit/SCOPE.md` §4.

## Build, test, execute

```bash
# compile everything (solc 0.8.24, no forge required)
cd ../verify && node compile.mjs

# the shipping market, executed on a real EVM: five campaigns
npx hardhat run protocol.cjs

# the Foundry suite (requires a forge binary, which this sandbox cannot fetch)
forge test -vv --match-path 'protocol/test/*'
```

Verified status of each artefact is in `../VERIFICATION-STATUS.md`; the audit
pack is in `audit/`.
