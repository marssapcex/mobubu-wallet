# Continuum — whitepaper

**[Continuum-Whitepaper.pdf](Continuum-Whitepaper.pdf)** — 14 pages, A4, typeset with
ReportLab; display equations rendered by matplotlib mathtext at 400 dpi; PDF outline
and table of contents built by multi-pass.

## Structure

| § | content |
|---|---|
| — | title page, abstract, keywords |
| 1 | introduction, what the borrower is actually buying, contributions, non-contributions |
| 2 | the audit: 20 discrete events, the A/B/C filter, DeFiLlama sector table |
| 3 | model: state, transitions, the accounting identity |
| 4 | safety: solvency, empty event domain, inductive invariant, spiral boundary, **a correction the machine forced** |
| 5 | dynamics: gap contraction, closed-form ODE, quasi-steady health |
| 6 | the rent law: controller, contraction bound, the net-negative region, design rule |
| 7 | refinement to fixed-point integers, **a second correction** |
| 8 | verification methodology: SMT protocol, executable invariants, threats to validity |
| 9 | economics: who pays whom, a participant class, implementation notes |
| 10 | red team: economic, technical and regulatory death |
| 11–13 | related work, conclusion, future work |
| A | reproducing every claim |

## Build

```bash
cd research/continuum
python3 -m venv .venv
./.venv/bin/pip install reportlab matplotlib pymupdf
./.venv/bin/python whitepaper/build.py
```

`build.py` is the single source: prose, theorem environments, tables and equations all
live in one file, so the PDF cannot drift away from the claims it makes. The rendered
equation PNGs in `eq/` are build artefacts and are not committed.

## What the paper does not claim

Two theorems were false as first written and the SMT solvers produced counterexamples
(§4.5, §7.4). The underwriter-incentive theorem is admitted, not proved. The
"no-cascade" claim is an argument, not a theorem. And the instrument is structurally a
credit default swap, which bounds the market to professional counterparties (§10.3).
