# DeFiLlama snapshot — 2026-11-12

Source: `defillama.com/categories` (table) and `api.llama.fi/protocols` (index), read live.
TVL is combined TVL as displayed by DeFiLlama; "24h revenue" is the category row's
24h revenue column. Treat as a snapshot: these numbers move every day.

| category | protocols | combined TVL | 24h TVL Δ | 30d Δ | 24h revenue |
|---|---|---|---|---|---|
| Bridge | 179 | $58.524b | -1.46% | +0.42% | $122,622 |
| Lending | 665 | $48.470b | +0.21% | -9.35% | $690,315 |
| Liquid Staking | 302 | $46.977b | -0.93% | -14.76% | $305,222 |
| Staking Pool | 80 | $12.624b | -0.67% | -13.26% | $65,219 |
| DEXs | 2,169 | $12.115b | +0.52% | -11.35% | $1.54m |
| Canonical Bridge | 103 | $11.691b | +0.08% | -13.69% | $8,517 |
| Risk Curators | 100 | $9.876b | +0.37% | +2.70% | $53,468 |
| Onchain Capital Allocator | 88 | $8.804b | +0.33% | -5.19% | $45,233 |
| Restaking | 15 | $8.476b | -0.72% | -14.83% | $516.87 |
| Basis Trading | 44 | $7.810b | -0.63% | +1.57% | $3,392 |
| CDP | 234 | $5.777b | -0.45% | -26.72% | $504,069 |
| Yield | 691 | $4.064b | -0.40% | -16.26% | $272,444 |
| RWA | 190 | $3.620b | +0.45% | -13.89% | $640,412 |
| Derivatives | 463 | $1.795b | +0.11% | -9.20% | $3.28m |
| Liquid Restaking | 29 | $0.990b | -1.24% | -22.82% | $10,021 |
| Privacy | 55 | $0.928b | -1.00% | -0.43% | $57,989 |
| Prediction Market | 141 | $0.351b | +0.81% | -10.20% | $796,790 |
| **Options** | 82 | $0.189b | -3.07% | +43.03% | $9,324 |
| **Insurance** | 33 | $0.151b | -0.60% | -19.64% | $2,368 |
| **Liquidations** | **3** | **$0.0008b** | -0.15% | -2.29% | **$0** |
| Interest Rate Derivatives | 3 | $0.0079b | -0.32% | -2.39% | $2,549 |

## The two facts this design is built on

1. **$48.47b is lent against $812,253 of pre-committed liquidation capital.**
   The "Liquidations" category has 3 protocols and less TVL than a mid-cap NFT
   collection, yet 2025-10-10 saw $19.3b of forced liquidations in 24 hours across
   1.62m accounts. Liquidation is a large forced *transfer* with almost no
   pre-committed capital market behind it — i.e. it is an event, not a market.

2. **$9.88b across 100 "Risk Curators."** Manual, committee-set risk pricing is
   now a ten-billion-dollar sector. That is the strongest available evidence that
   continuous risk pricing either does not exist or has not been mechanised.

## Why the design targets lending and not the two biggest rows

Bridge ($58.5b) and Liquid Staking ($47.0b) are larger, and both were audited in
Phase 1 (items 5, 6, 10, 11) and rejected on constraint C: value has to be
delivered on an independent ledger, and/or ETH has to leave the beacon chain.
Those are consensus and settlement constraints, not pricing constraints. No
economic mechanism deletes them.
