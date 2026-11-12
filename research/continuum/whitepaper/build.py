#!/usr/bin/env python3
"""
Builds the Continuum whitepaper as a typeset PDF.

Design goals, so that it reads like a research note rather than a pitch:
  * two-column-free, single-column A4 with Times body text (classical)
  * numbered sections/subsections, running head, page numbers, PDF outline
  * a real table of contents (built by multi-pass)
  * display equations typeset by matplotlib's mathtext ($...$), embedded at 400 dpi
  * theorem/lemma/proof environments, booktabs-style rules, no marketing language

Run:  ./.venv/bin/python whitepaper/build.py
Out:  whitepaper/Continuum-Whitepaper.pdf
"""

import os
import sys
import textwrap

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

from reportlab.lib import colors  # noqa: E402
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import ParagraphStyle  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.pdfbase import pdfmetrics  # noqa: E402
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether,  # noqa: E402
                                NextPageTemplate, PageBreak, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle)
from reportlab.pdfbase.ttfonts import TTFont  # noqa: E402
from reportlab.platypus.tableofcontents import TableOfContents  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# The base-14 Type1 fonts cover Greek, arrows and maths relations but not subscript
# digits, floor brackets, blackboard R or the tombstone. matplotlib ships DejaVu
# serif, which does, so it is registered as an inline fallback.
_DJ = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf",
                   "DejaVuSerif.ttf")
pdfmetrics.registerFont(TTFont("DejaVuSerif", _DJ))
FALLBACK = "DejaVuSerif"

_SUB = {"\u2080": "0", "\u2081": "1", "\u2082": "2", "\u2083": "3"}


def sanitize(t):
    """Replace glyphs the body font cannot draw with markup or an inline fallback.
    Applied to every string that reaches a Paragraph."""
    for ch, d in _SUB.items():
        t = t.replace(ch, "<sub>%s</sub>" % d)
    t = t.replace("\u230a", "<i>floor</i>(").replace("\u230b", ")")
    t = t.replace("\u211d", "<i>R</i>")
    t = t.replace("\u207b\u2074", "<super>&#8722;4</super>")
    t = t.replace("\u220e", '<font name="%s">&#8718;</font>' % FALLBACK)
    t = t.replace("\u2713", '<font name="%s">&#10003;</font>' % FALLBACK)
    return t
EQDIR = os.path.join(HERE, "eq")
os.makedirs(EQDIR, exist_ok=True)

PAGE_W, PAGE_H = A4
MARGIN_L = MARGIN_R = 24 * mm
MARGIN_T = 26 * mm
MARGIN_B = 22 * mm
FRAME_W = PAGE_W - MARGIN_L - MARGIN_R

INK = colors.HexColor("#111111")
SOFT = colors.HexColor("#555555")
RULE = colors.HexColor("#9a9a9a")
TINT = colors.HexColor("#f2f2f0")

# ----------------------------------------------------------------------------- styles
S = {}
S["body"] = ParagraphStyle(
    "body", fontName="Times-Roman", fontSize=10.4, leading=15.2, alignment=TA_JUSTIFY,
    spaceAfter=5.2, firstLineIndent=0, textColor=INK)
S["bodyi"] = ParagraphStyle("bodyi", parent=S["body"], firstLineIndent=14)
S["abstract"] = ParagraphStyle("abstract", parent=S["body"], fontSize=9.9, leading=14.4,
                               leftIndent=12 * mm, rightIndent=12 * mm, spaceAfter=4)
S["H1"] = ParagraphStyle("H1", fontName="Times-Bold", fontSize=13.6, leading=17,
                         spaceBefore=15, spaceAfter=6.5, textColor=INK)
S["H2"] = ParagraphStyle("H2", fontName="Times-Bold", fontSize=11.1, leading=14,
                         spaceBefore=10, spaceAfter=4, textColor=INK)
S["H3"] = ParagraphStyle("H3", fontName="Times-Italic", fontSize=10.4, leading=13,
                         spaceBefore=8, spaceAfter=3, textColor=INK)
S["title"] = ParagraphStyle("title", fontName="Times-Bold", fontSize=22, leading=27,
                            alignment=TA_CENTER, textColor=INK, spaceAfter=10)
S["subtitle"] = ParagraphStyle("subtitle", fontName="Times-Italic", fontSize=13, leading=18,
                               alignment=TA_CENTER, textColor=INK, spaceAfter=8)
S["author"] = ParagraphStyle("author", fontName="Times-Roman", fontSize=11.5, leading=15,
                             alignment=TA_CENTER, spaceAfter=2)
S["date"] = ParagraphStyle("date", fontName="Times-Roman", fontSize=10, leading=13,
                           alignment=TA_CENTER, textColor=SOFT)
S["thm"] = ParagraphStyle("thm", parent=S["body"], leftIndent=7 * mm, firstLineIndent=0,
                          spaceAfter=3, spaceBefore=2)
S["proof"] = ParagraphStyle("proof", parent=S["thm"], fontName="Times-Roman")
S["cap"] = ParagraphStyle("cap", fontName="Times-Roman", fontSize=8.9, leading=11.6,
                          alignment=TA_LEFT, textColor=SOFT, spaceBefore=3, spaceAfter=9)
S["caption_above"] = ParagraphStyle("capab", parent=S["cap"], spaceBefore=6, spaceAfter=3,
                                    textColor=INK, fontName="Times-Bold")
S["code"] = ParagraphStyle("code", fontName="Courier", fontSize=7.9, leading=10.2,
                           leftIndent=5 * mm, textColor=INK, spaceBefore=3, spaceAfter=6)
S["bullet"] = ParagraphStyle("bullet", parent=S["body"], leftIndent=9 * mm,
                             bulletIndent=3 * mm, spaceAfter=3.4)
S["ref"] = ParagraphStyle("ref", parent=S["body"], fontSize=9.4, leading=12.6,
                          leftIndent=9 * mm, firstLineIndent=-9 * mm, spaceAfter=4)
S["toc0"] = ParagraphStyle("toc0", fontName="Times-Bold", fontSize=10.2, leading=14,
                           textColor=INK)
S["toc1"] = ParagraphStyle("toc1", fontName="Times-Roman", fontSize=9.6, leading=12.6,
                           leftIndent=7 * mm, textColor=colors.HexColor("#333333"))


# ----------------------------------------------------------------------------- equations
_eq_cache = {}


def EQ(tex, fontsize=12.4, number=None):
    """Display equation, typeset by mathtext at 400 dpi and embedded as a flowable."""
    key = (tex, fontsize)
    png = os.path.join(EQDIR, "eq_%03d.png" % (abs(hash(key)) % 9999))
    if key not in _eq_cache:
        fig = plt.figure(figsize=(0.01, 0.01))
        fig.text(0, 0, "$%s$" % tex, fontsize=fontsize, color="#111111")
        try:
            fig.savefig(png, dpi=400, bbox_inches="tight", pad_inches=0.02, transparent=True)
        except Exception as exc:
            plt.close(fig)
            print("  !! mathtext failed, falling back to mono: %s\n     %s"
                  % (str(exc).splitlines()[-1][:120], tex[:110]))
            _eq_cache[key] = None
            return [Paragraph(tex.replace("\\", "&#92;"), S["code"])]
        plt.close(fig)
        _eq_cache[key] = png
    if _eq_cache[key] is None:
        return [Paragraph(tex, S["code"])]
    png = _eq_cache[key]
    iw, ih = PILImage.open(png).size
    w = iw / 400.0 * 72.0
    h = ih / 400.0 * 72.0
    if w > FRAME_W - 30 * mm:
        s = (FRAME_W - 30 * mm) / w
        w, h = w * s, h * s
    img = Image(png, width=w, height=h)
    img.hAlign = "CENTER"
    if number is None:
        out = [Spacer(1, 3), img, Spacer(1, 6)]
    else:
        t = Table([[img, Paragraph("(%s)" % number, S["body"])]],
                  colWidths=[FRAME_W - 22 * mm, 18 * mm])
        t.setStyle(TableStyle([
            ("ALIGN", (0, 0), (0, 0), "CENTER"),
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        out = [t]
    return out


# ----------------------------------------------------------------------------- blocks
STORY = []


def H1(t, pagebreak=False):
    if pagebreak:
        STORY.append(PageBreak())
    STORY.append(Paragraph(sanitize(t), S["H1"]))


def H2(t):
    STORY.append(Paragraph(sanitize(t), S["H2"]))


def H3(t):
    STORY.append(Paragraph(sanitize(t), S["H3"]))


def P(t, style="body"):
    st = style if isinstance(style, ParagraphStyle) else S[style]
    STORY.append(Paragraph(sanitize(t), st))


def THM(label, statement, proof=None):
    """Theorem environment: bold head, italic statement, indented proof, qed."""
    STORY.append(Paragraph(sanitize("<b>%s.</b> <i>%s</i>" % (label, statement)), S["thm"]))
    if proof:
        STORY.append(Paragraph(sanitize("<i>Proof.</i> %s &#8718;" % proof), S["proof"]))


def BL(items):
    for it in items:
        STORY.append(Paragraph(sanitize(it), S["bullet"], bulletText="\u2022"))


def CODE(txt):
    STORY.append(Paragraph(sanitize(txt).replace(" ", "&nbsp;").replace("\n", "<br/>"),
                           S["code"]))


def TABLE(caption, header, rows, widths=None, align=None, caption_above=False):
    data = [[Paragraph("<b>%s</b>" % h, ParagraphStyle("th", parent=S["body"], fontSize=8.9,
                                                       leading=11, alignment=TA_CENTER))
             for h in header]]
    for r in rows:
        data.append([Paragraph(sanitize(str(c)), ParagraphStyle("td", parent=S["body"], fontSize=8.9,
                                                     leading=11.2,
                                                     alignment=TA_LEFT))
                     for c in r])
    if widths is None:
        widths = [FRAME_W / len(header)] * len(header)
    t = Table(data, colWidths=widths, repeatRows=1)
    style = [
        ("LINEABOVE", (0, 0), (-1, 0), 0.9, INK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, INK),
        ("LINEBELOW", (0, -1), (-1, -1), 0.9, INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.2),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), TINT))
    t.setStyle(TableStyle(style))
    cap = Paragraph(sanitize(caption), S["caption_above"] if caption_above else S["cap"])
    if caption_above:
        STORY.append(KeepTogether([cap, t, Spacer(1, 6)]))
    else:
        STORY.append(KeepTogether([t, cap]))


def BOX(title, body_paras, tint=colors.HexColor("#f6f4ee")):
    inner = [Paragraph(sanitize("<b>%s</b>" % title),
                       ParagraphStyle("bt", parent=S["body"], fontSize=9.6, spaceAfter=3))]
    for p in body_paras:
        inner.append(Paragraph(sanitize(p), ParagraphStyle("bb", parent=S["body"], fontSize=9.3,
                                                 leading=13.2, spaceAfter=3)))
    t = Table([[inner]], colWidths=[FRAME_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), tint),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    STORY.append(t)
    STORY.append(Spacer(1, 8))


# ----------------------------------------------------------------------------- doc template
class Paper(BaseDocTemplate):
    def __init__(self, filename, **kw):
        BaseDocTemplate.__init__(self, filename, pagesize=A4,
                                 leftMargin=MARGIN_L, rightMargin=MARGIN_R,
                                 topMargin=MARGIN_T, bottomMargin=MARGIN_B,
                                 title="Continuum: Deleting the Liquidation Event",
                                 author="Mobubu Cypherpunk Lab",
                                 subject="Mechanism design and machine-checked safety proofs",
                                 creator="reportlab")
        cover_frame = Frame(MARGIN_L, MARGIN_B, FRAME_W, PAGE_H - MARGIN_T - MARGIN_B, id="cover")
        body_frame = Frame(MARGIN_L, MARGIN_B, FRAME_W, PAGE_H - MARGIN_T - MARGIN_B, id="body")
        self.addPageTemplates([
            PageTemplate(id="Cover", frames=[cover_frame], onPage=self._cover),
            PageTemplate(id="Body", frames=[body_frame], onPage=self._body_page),
        ])
        self._bm = 0

    def _cover(self, canv, doc):
        canv.saveState()
        canv.setStrokeColor(INK)
        canv.setLineWidth(0.8)
        canv.line(MARGIN_L, MARGIN_T - 6 * mm, PAGE_W - MARGIN_R, MARGIN_T - 6 * mm)
        canv.setFont("Times-Italic", 8.6)
        canv.setFillColor(SOFT)
        canv.drawString(MARGIN_L, MARGIN_T - 4.4 * mm, "Research note")
        canv.drawRightString(PAGE_W - MARGIN_R, MARGIN_T - 4.4 * mm, "November 2026")
        canv.restoreState()

    def _body_page(self, canv, doc):
        canv.saveState()
        canv.setFont("Times-Italic", 8.4)
        canv.setFillColor(SOFT)
        canv.drawString(MARGIN_L, PAGE_H - MARGIN_T + 9 * mm,
                        "Continuum \u2014 a buffer-rent market for credit")
        canv.drawRightString(PAGE_W - MARGIN_R, PAGE_H - MARGIN_T + 9 * mm, "November 2026")
        canv.setStrokeColor(RULE)
        canv.setLineWidth(0.4)
        canv.line(MARGIN_L, PAGE_H - MARGIN_T + 7.4 * mm, PAGE_W - MARGIN_R,
                  PAGE_H - MARGIN_T + 7.4 * mm)
        canv.line(MARGIN_L, MARGIN_B - 6 * mm, PAGE_W - MARGIN_R, MARGIN_B - 6 * mm)
        canv.setFont("Times-Roman", 8.6)
        canv.drawCentredString(PAGE_W / 2.0, MARGIN_B - 10.4 * mm, str(doc.page))
        canv.restoreState()

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        name = flowable.style.name
        if name not in ("H1", "H2"):
            return
        text = flowable.getPlainText()
        level = 0 if name == "H1" else 1
        self.notify("TOCEntry", (level, text, self.page))
        if level == 0:
            key = "sec%d" % self._bm
            self._bm += 1
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=0, closed=False)


# ============================================================================= CONTENT
def build_content():
    # ---------------------------------------------------------------- cover
    STORY.append(Spacer(1, 16 * mm))
    STORY.append(Paragraph("Continuum", S["title"]))
    STORY.append(Paragraph("Deleting the Liquidation Event", S["subtitle"]))
    STORY.append(Spacer(1, 2 * mm))
    STORY.append(Paragraph(
        "A buffer-rent market for collateralised credit, with machine-checked "
        "safety proofs", ParagraphStyle("t3", parent=S["subtitle"], fontSize=11.5)))
    STORY.append(Spacer(1, 14 * mm))
    STORY.append(Paragraph("Mobubu Cypherpunk Lab", S["author"]))
    STORY.append(Paragraph("Research note \u2014 November 2026", S["date"]))
    STORY.append(Spacer(1, 18 * mm))

    STORY.append(Paragraph("Abstract", ParagraphStyle(
        "abh", parent=S["H1"], alignment=TA_CENTER, spaceBefore=0, spaceAfter=5)))
    P("A collateralised loan position contains one discrete, indivisible, "
      "adversarially-timed event: the liquidation. On 10 October 2025 roughly "
      "19.3 billion USD of leveraged positions were liquidated in a single day "
      "across 1.62 million accounts, while the entire on-chain category that "
      "pre-commits capital to that transfer held under one million dollars. "
      "Liquidation is therefore not a market but an event with a latency race "
      "attached. We show the event is not economically necessary. Splitting a "
      "position into a <i>buffer line</i> <i>L</i> = <i>cD</i> and a <i>buffer surplus</i> "
      "<i>S</i> = <i>V</i> \u2212 <i>L</i> yields the identity <i>h</i> = <i>V/D</i> = "
      "<i>c</i> + <i>S/D</i>, from which it follows that a transfer of collateral priced "
      "at <i>c</i> per unit of debt retired is exactly buffer-neutral while strictly "
      "reducing debt. Health is then a function of debt alone at fixed surplus, a "
      "proportional flow on the distress gap is a negative feedback loop with a "
      "closed-form solution, and the predicate <i>V</i> &lt; <i>D</i> becomes unsatisfiable. "
      "The scheme prices the buffer by a two-sided t\u00e2tonnement instead of a "
      "governance parameter, pays underwriters a discovered spread instead of a "
      "keeper bonus, and requires no auction, no settlement and no privileged caller. "
      "Eighteen statements \u2014 the algebraic core, the control bounds, and the "
      "fixed-point integer refinement \u2014 are machine-checked by two independent SMT "
      "solvers plus a 122,760-state exhaustive integer campaign, and the invariants "
      "are executed against the contract on a live EVM. Two of the statements were "
      "false as first written; the solvers produced counterexamples and the corrected "
      "statements are reported in \u00a74.5 and \u00a77.4.", S["abstract"])
    STORY.append(Spacer(1, 5 * mm))
    P("<b>Keywords:</b> mechanism design, collateralised lending, liquidation, "
      "loss-versus-rebalancing, SMT verification, fixed-point refinement.",
      ParagraphStyle("kw", parent=S["abstract"], fontSize=9.3))

    # ---------------------------------------------------------------- TOC
    STORY.append(PageBreak())
    STORY.append(Paragraph("Contents", ParagraphStyle("toch", parent=S["H1"],
                                                      spaceBefore=0, spaceAfter=8)))
    toc = TableOfContents()
    toc.levelStyles = [S["toc0"], S["toc1"]]
    toc.dotsMinLevel = 0
    STORY.append(toc)
    STORY.append(NextPageTemplate("Body"))
    STORY.append(PageBreak())

    # ---------------------------------------------------------------- 1
    H1("1. Introduction")
    P("Every lending market has a moment when a position stops being a position and "
      "becomes a transfer. A number crosses a threshold; a bot that was built to be "
      "faster than other bots seizes an indivisible block of collateral at a discount; "
      "and the borrower's cost is set not by the value at risk but by the size of the "
      "block that happened to be seized. The mechanism literature has spent a decade "
      "optimising this moment. Bonuses ramped with health, close factors sized to a "
      "target health factor, Dutch auctions, batch auctions, partial liquidations. All "
      "of these resize the event. None of them remove it.")
    P("There is a useful contrast. The perpetual swap, introduced in 2016, did not "
      "resize the rollover of a futures contract; it deleted it. The observation was "
      "that the thing being rolled \u2014 the basis \u2014 is not a stock but a flow, and a flow "
      "can be charged continuously and priced locally as a function of two observable "
      "prices. No delivery, no expiry, no settlement instruction. This paper asks "
      "whether the same move is available for liquidation, and answers that it is, "
      "provided one is willing to change what the borrower is buying.")

    H2("1.1 What the borrower is actually buying")
    P("A borrower in an over-collateralised market holds an option: the right to walk "
      "away from the debt by surrendering the collateral. The option is valuable "
      "exactly in proportion to the surplus above the lender's claim, and today the "
      "borrower pays nothing for it until it is exercised \u2014 at which point the payment "
      "is a lump sum delivered at a random time to a stranger. The buffer between the "
      "collateral value and the debt is dead capital: it earns no return, and its only "
      "function is to absorb a seizure.")
    P("Continuum rents that buffer instead of seizing it. The borrower pays a "
      "continuously-accrued rent on the surplus; a standing class of unlevered "
      "underwriters receives the rent; and when the position drifts towards distress, "
      "the underwriters buy collateral <i>continuously</i> at a fixed discount, retiring "
      "debt as they go. Because the purchase price is chosen so that the transaction is "
      "exactly neutral in the surplus, the surplus is a conserved quantity of the flow "
      "and the health ratio rises monotonically as debt falls. The liquidation "
      "predicate is never satisfiable.")

    H2("1.2 Contributions")
    BL([
        "<b>A decomposition that makes the event unnecessary (\u00a73).</b> The buffer "
        "line/surplus split yields <i>h</i> = <i>c</i> + <i>S/D</i>; a purchase at price "
        "<i>c</i> per unit of debt is buffer-neutral, so the flow acts on the denominator "
        "of health and nothing else.",
        "<b>Safety as an inductive invariant rather than a parameter (\u00a74).</b> "
        "Solvency under the flow, unsatisfiability of the liquidation predicate, and the "
        "exact boundary at which the flow becomes a spiral, all as theorems.",
        "<b>Closed-form dynamics (\u00a75).</b> The gap obeys <i>\u0111</i> = \u2212<i>kg</i> + "
        "<i>vV</i>, which is stable for every <i>k</i> &gt; 0; the quasi-steady health "
        "under sustained drawdown is <i>h</i>* = <i>tgt</i>/(1+<i>v/k</i>).",
        "<b>A rent law with a quantified failure region (\u00a76).</b> The loop is "
        "net-negative iff \u03c1 &lt; <i>kfs</i>/<i>tgt</i>; the margin table shows the "
        "dangerous corner is the one that looks safe.",
        "<b>Refinement to fixed-point arithmetic (\u00a77).</b> Four rounding lemmas plus "
        "an exact integer invariant, with no epsilon, plus an exhaustive campaign.",
        "<b>An honest verification report (\u00a78).</b> What is proved, by which tool, "
        "and \u2014 in \u00a74.5 and \u00a77.4 \u2014 two theorems that the machine falsified.",
    ])

    H2("1.3 Non-contributions")
    P("We do not claim to have built a market comparable in scale to the perpetual "
      "swap. The instrument this paper describes converts an annual rent of order one "
      "to three billion dollars into a continuous flow, and its underwriter is an "
      "institutional balance sheet because of the legal characterisation in \u00a710.3. The "
      "perpetual swap created a retail participant class; this does not. We regard "
      "stating that plainly as part of the contribution.")

    # ---------------------------------------------------------------- 2
    H1("2. The audit: which discrete events can be deleted")
    P("The candidate was selected by an exhaustive audit of lumpy, operationally "
      "expensive events in DeFi, then filtered by three necessary conditions:")
    BL([
        "<b>A.</b> the event can be <i>deleted</i>, not resized, by conversion into a "
        "continuous and divisible flow;",
        "<b>B.</b> the replacement can be self-priced by a local negative feedback loop, "
        "with no governance parameter setting the level and no external price oracle "
        "pricing the flow;",
        "<b>C.</b> the replacement removes delivery, settlement and custodianship "
        "entirely.",
    ])
    P("Twenty events were audited, including LP rebalancing and loss-versus-rebalancing, "
      "concentrated-liquidity range exit, cross-chain settlement, rollup withdrawal "
      "delays, oracle updates, interest-rate kinks, governance parameter changes, "
      "staking epochs, unstake queues, MEV ordering, recursive looping, "
      "impermanent-loss realisation, bad-debt socialisation, option expiry, term-loan "
      "maturity, insurance terms, funding settlement and stablecoin redemption. "
      "Table\u00a01 gives the live sector data that motivated the ordering; Table\u00a02 gives "
      "the filter and the reasons for rejection.")

    TABLE("Table 1. Sector snapshot, DeFiLlama, 12 November 2026. Combined TVL as "
          "displayed by the aggregator.",
          ["Sector", "Protocols", "TVL", "24h revenue"],
          [["Bridge", "179", "$58.52b", "$122,622"],
           ["Lending", "665", "$48.47b", "$690,315"],
           ["Liquid staking", "302", "$46.98b", "$305,222"],
           ["DEXs", "2,169", "$12.12b", "$1.54m"],
           ["Risk curators", "100", "$9.88b", "$53,468"],
           ["Restaking", "15", "$8.48b", "$517"],
           ["Derivatives", "463", "$1.80b", "$3.28m"],
           ["Insurance", "33", "$150.76m", "$2,368"],
           ["Liquidations", "3", "$812,253", "$0"]],
          widths=[FRAME_W * .34, FRAME_W * .18, FRAME_W * .22, FRAME_W * .26])

    P("Two rows carry the argument. Forty-eight billion dollars is lent against "
      "eight hundred thousand dollars of pre-committed liquidation capital: the "
      "transfer is large and the market behind it is empty, because participation "
      "requires winning a race rather than holding risk. And ten billion dollars of "
      "risk is priced by a hundred committees, which is the cleanest available "
      "evidence that continuous risk pricing has not been mechanised.")

    TABLE("Table 2. The A/B/C filter. Only the liquidation survives all three.",
          ["Event", "A", "B", "C", "Obstruction"],
          [["Liquidation", "\u2713", "\u2713", "\u2713", "\u2014"],
           ["Liquidation auction", "\u2713", "\u2713", "\u2713",
            "a consequence of the first; not independent"],
           ["LVR / rebalancing", "\u00d7", "\u00d7", "~",
            "the discrete unit is the block; needs a volatility input"],
           ["Range exit", "~", "\u00d7", "\u2713", "re-centring costs gas per block"],
           ["Cross-chain settlement", "\u00d7", "\u00d7", "\u00d7",
            "two independent finalities"],
           ["Rollup withdrawal", "\u00d7", "~", "\u00d7", "the delay is the security model"],
           ["Oracle update", "\u00d7", "\u00d7", "\u2713", "the world is sampled"],
           ["Rate kink", "~", "~", "\u2713", "interest already flows per second"],
           ["Unstake queue", "\u2713", "\u2713", "\u00d7", "the underlying must be delivered"],
           ["Option expiry", "\u2713", "\u2713", "\u2713", "already solved: everlasting options"]],
          widths=[FRAME_W * .22, FRAME_W * .06, FRAME_W * .06, FRAME_W * .06,
                  FRAME_W * .60])

    P("Three near-misses are worth naming because they are where a weaker analysis "
      "would have cut a corner. The unstake queue passes A and B and fails C for a "
      "reason no economic design can fix: at some point ETH must leave the beacon "
      "chain. Option expiry passes all three, and is therefore disqualified on "
      "novelty rather than feasibility. The interest-rate kink is the right size but "
      "has no lumpy transfer inside it: removing a parameter is not deleting an event.")

    # ---------------------------------------------------------------- 3
    H1("3. Model")
    H2("3.1 State")
    P("A position is a triple (<i>V</i>, <i>D</i>, <i>c</i>) \u2208 \u211d\u00b3 of collateral value, debt "
      "and buffer-line multiplier, together with an exogenous mark at which <i>V</i> is "
      "measured. We use")
    STORY.extend(EQ(r"L \;=\; c\,D, \qquad S \;=\; V - L, \qquad h \;=\; \frac{V}{D}, "
                    r"\qquad g \;=\; tgt\cdot D - V", 13, "3.1"))
    P("with <i>c</i> = 1 + \u03b5 &gt; 1 (the underwriter's discount \u03b5) and <i>tgt</i> &gt; <i>c</i> "
      "(the health at which absorption switches on). The implementation carries every "
      "quantity as a WAD-scaled integer; \u00a77 closes that gap formally rather than by "
      "tolerance.")

    H2("3.2 Transitions")
    P("There are two flows, both linear in elapsed time, and three user actions:")
    STORY.extend(EQ(r"\mathrm{payRent}(r): (V,D)\mapsto(V-r,\,D), \quad r\leq S", 12, "3.2"))
    STORY.extend(EQ(r"\mathrm{delever}(x): (V,D)\mapsto(V-cx,\,D-x), \quad x\leq D", 12, "3.3"))
    P("plus <i>borrow</i> (<i>D</i> increases, admissible iff <i>cy</i> \u2264 <i>S</i>), "
      "<i>repay</i>, and an exogenous mark update that rescales <i>V</i>. The flow is "
      "state feedback rather than a parameter:")
    STORY.extend(EQ(r"\frac{x}{\Delta t} \;=\; k\,\frac{g}{tgt}, \qquad "
                    r"\frac{r}{\Delta t} \;=\; \rho\,D, \qquad "
                    r"\rho' = \mathrm{clip}_{[0,\rho_{max}]}\!\left(\rho+\eta\,"
                    r"\left[\mathrm{Demand}(\rho)-\mathrm{Supply}(\rho)\right]\right)", 12, "3.4"))
    P("where Demand is non-increasing and Supply non-decreasing in \u03c1, so excess demand "
      "<i>z</i>(\u03c1) is non-increasing and the crossing is unique when it exists.")

    H2("3.3 The accounting identity")
    THM("Lemma 3.1 (buffer neutrality)", "For all <i>x</i>: <i>S</i>(delever(<i>x</i>)) "
        "= <i>S</i>.",
        "Expand: <i>S</i>' = (<i>V</i> \u2212 <i>cx</i>) \u2212 <i>c</i>(<i>D</i> \u2212 <i>x</i>) = "
        "<i>V</i> \u2212 <i>cD</i> = <i>S</i>. Machine-checked: <b>T1</b>.")
    THM("Corollary 3.2 (health identity)", "<i>h</i> = <i>c</i> + <i>S/D</i>.",
        "Since <i>cD</i> + <i>S</i> = <i>V</i>, divide by <i>D</i>. Machine-checked: <b>T10</b>.")
    P("Corollary 3.2 is the mechanism. A flow that reduces <i>D</i> at fixed <i>S</i> "
      "raises health monotonically and without bound; the design needs no threshold "
      "because health is a continuous, strictly decreasing function of <i>D</i> and of "
      "nothing else.")

    # ---------------------------------------------------------------- 4
    H1("4. Safety")
    H2("4.1 Solvency of the flow")
    THM("Theorem 4.1 (no bad debt)", "For <i>c</i> &gt; 0, <i>x</i> \u2264 <i>D</i> and "
        "<i>cD</i> \u2264 <i>V</i>, we have <i>c</i>(<i>D</i> \u2212 <i>x</i>) \u2264 <i>V</i> \u2212 <i>cx</i>.",
        "<i>c</i>(<i>D</i>\u2212<i>x</i>) = <i>cD</i> \u2212 <i>cx</i> \u2264 <i>V</i> \u2212 <i>cx</i>. "
        "Machine-checked: <b>T2</b>.")
    P("A unit of debt retired at a collateral price of <i>c</i> leaves the residual "
      "position at least as over-collateralised as the original, at any mark and for "
      "any size. That is what makes participation rational for an underwriter in the "
      "residual sense, and it is the assumption whose violation on the underwriter's "
      "own book (\u00a710.1) is fatal.")

    H2("4.2 The event has an empty domain")
    THM("Theorem 4.2 (no liquidatable state)", "For <i>c</i> &gt; 1, <i>D</i> &gt; 0 and "
        "<i>cD</i> \u2264 <i>V</i>: <i>V</i> &gt; <i>D</i>.",
        "<i>V</i> = <i>cD</i> + <i>S</i> &gt; <i>D</i> + <i>S</i> \u2265 <i>D</i>. "
        "Machine-checked: <b>T5</b>; also stated in Lean 4 as "
        "<font face='Courier'>no_liquidation_predicate</font>.")
    P("Standard lending defines the event by <i>h</i> &lt; 1. Theorem 4.2 says that "
      "predicate is unsatisfiable on the reachable set. This is the precise sense in "
      "which the mechanism deletes the event: a resized liquidation still has a "
      "satisfiable trigger, so its event set is non-empty.")

    H2("4.3 The inductive invariant")
    THM("Theorem 4.3 (invariant preservation)", "If <i>S</i> \u2265 0 then (i) delever "
        "preserves it exactly; (ii) payRent preserves it for all <i>r</i> \u2264 <i>S</i>; "
        "(iii) borrow preserves it for all <i>cy</i> \u2264 <i>S</i>; (iv) repay increases it.",
        "Case by case from Lemma 3.1 and the caps. By induction <i>S</i> \u2265 0 on every "
        "reachable state. Machine-checked: T1, T9 and the integer version <b>I4</b>.")
    P("Note that payRent <i>decreases</i> the surplus. Rent is a drag, not a "
      "preservation, which is why it needs its own bound and why \u00a76 derives the region "
      "in which the flow outruns it.")

    H2("4.4 The spiral boundary")
    THM("Theorem 4.4 (when protection becomes predation)", "For 0 &lt; <i>x</i> &lt; "
        "<i>D</i> and <i>V</i> &lt; <i>cD</i>: (<i>V</i> \u2212 <i>cx</i>)<i>D</i> &lt; "
        "<i>V</i>(<i>D</i> \u2212 <i>x</i>).",
        "The difference is <i>x</i>(<i>V</i> \u2212 <i>cD</i>) &lt; 0. Machine-checked: <b>T4</b>.")
    P("Together with Lemma 4.6 this is an equivalence of sign: the flow is stabilising "
      "if and only if <i>V</i> &gt; <i>cD</i>, i.e. if and only if \u03b5 &lt; <i>b</i> where "
      "<i>b</i> is the borrower's relative buffer. There is no intermediate regime, "
      "which is why the multiplier <i>c</i> is immutable in the implementation.")

    H2("4.5 A correction forced by the machine")
    P("The first statement of health monotonicity used <i>S</i> \u2265 0 and was false. "
      "Z3 returned the model <i>c</i> = 2, <i>V</i> = 2, <i>D</i> = 1, <i>x</i>\u2081 = 0, "
      "<i>x</i>\u2082 = \u00bd, for which <i>h</i>(<i>x</i>\u2081) = <i>h</i>(<i>x</i>\u2082) = 2 because "
      "<i>S</i> = 0 makes the gain vanish identically. The true pair of statements is a "
      "weak monotonicity at <i>S</i> \u2265 0 and a strict one at <i>S</i> &gt; 0.")
    THM("Lemma 4.6 (health monotonicity)", "For <i>c</i> &gt; 1, 0 \u2264 <i>x</i>\u2081 \u2264 "
        "<i>x</i>\u2082 &lt; <i>D</i> and <i>cD</i> \u2264 <i>V</i>: <i>h</i>(<i>x</i>\u2081) \u2264 "
        "<i>h</i>(<i>x</i>\u2082). Under <i>cD</i> &lt; <i>V</i> and <i>x</i>\u2081 &lt; "
        "<i>x</i>\u2082 the inequality is strict.",
        "<i>h</i>(<i>x</i>\u2082) \u2212 <i>h</i>(<i>x</i>\u2081) = (<i>x</i>\u2082 \u2212 "
        "<i>x</i>\u2081)(<i>V</i> \u2212 <i>cD</i>) / [(<i>D</i> \u2212 <i>x</i>\u2081)(<i>D</i> "
        "\u2212 <i>x</i>\u2082)], both denominator factors positive. Machine-checked: <b>T3</b> "
        "(weak), <b>T3b</b> (strict).")
    P("The correction propagates nowhere else: the Lean statement of Theorem 4.2 never "
      "used strictness. We report it because a formal artefact whose only output is "
      "\u201cverified\u201d is not doing its job; the interesting output is the counterexample.")

    # ---------------------------------------------------------------- 5
    H1("5. Dynamics")
    H2("5.1 The gap contracts")
    THM("Theorem 5.1 (strict gap contraction)", "For <i>x</i> &gt; 0 and <i>tgt</i> &gt; "
        "<i>c</i>: <i>g</i>' = <i>tgt</i>(<i>D</i>\u2212<i>x</i>) \u2212 (<i>V</i>\u2212<i>cx</i>) "
        "= <i>g</i> \u2212 <i>x</i>(<i>tgt</i> \u2212 <i>c</i>) &lt; <i>g</i>.",
        "Expand and collect. Machine-checked: <b>T6</b>.")
    P("The constant (<i>tgt</i> \u2212 <i>c</i>) is the design's <i>repair wedge</i>: the "
      "distance between the trigger and the underwriter's cost. If the trigger converges "
      "on the line the flow loses all authority, which is the quantitative reason the "
      "trigger must sit strictly above <i>c</i>.")

    H2("5.2 Continuous-time limit")
    P("Passing to continuous time with a persistent adverse drift <i>V\u0307</i> = "
      "\u2212<i>vV</i>:")
    STORY.extend(EQ(r"\dot{g} \;=\; tgt\,\dot{D} - \dot{V} \;=\; -k\,g + v\,V", 13, "5.1"))
    THM("Proposition 5.2 (closed form)", "With <i>g</i>(0) = <i>g</i>\u2080 and "
        "<i>V</i>(<i>t</i>) = <i>V</i>\u2080<i>e</i><super>\u2212<i>vt</i></super>,")
    STORY.extend(EQ(r"g(t) \;=\; \frac{V_0 v\, e^{kt} + \left(-V_0 v + g_0 k - g_0 v\right)"
                    r"e^{vt}}{(k-v)\, e^{t(k+v)}}", 12, "5.2"))
    P("and <i>g</i>(<i>t</i>) \u2192 0 as <i>t</i> \u2192 \u221e for all <i>k</i>, <i>v</i> &gt; 0, "
      "<i>k</i> \u2260 <i>v</i>. The homogeneous eigenvalue is \u2212<i>k</i>. Verified "
      "symbolically with <font face='Courier'>sympy.dsolve</font> and "
      "<font face='Courier'>sympy.limit</font>.")
    P("<b>Corollary 5.3.</b> The control loop has no unstable parameter region. Unlike "
      "the discrete rent interaction (\u00a76.3) and the accounting boundary (\u00a74.4), the "
      "flow itself is stable for every <i>k</i> &gt; 0, because it feeds back on the "
      "denominator of health rather than on a price.")
    THM("Corollary 5.4 (quasi-steady health)", "Setting <i>g\u0307</i> = 0 gives "
        "<i>kg</i> = <i>vV</i>, hence <i>h</i>* = <i>tgt</i>/(1 + <i>v/k</i>).",
        "Substitute <i>g</i> = <i>tgt D</i> \u2212 <i>V</i> and solve for <i>V/D</i>. "
        "Machine-checked (algebraic core): <b>T12</b>.")

    TABLE("Table 3. Quasi-steady health under sustained drawdown, <i>tgt</i> = 1.20, "
          "<i>k</i> = 365/yr.",
          ["Sustained drawdown v", "Equilibrium health h*", "Deficit vs trigger"],
          [["0.5 /yr", "1.1984", "0.14%"],
           ["1.0 /yr", "1.1967", "0.27%"],
           ["2.0 /yr", "1.1935", "0.54%"],
           ["5.0 /yr", "1.1838", "1.35%"],
           ["20 /yr", "1.1377", "5.19%"]],
          widths=[FRAME_W * .36, FRAME_W * .34, FRAME_W * .30])
    P("A two-thousand-percent annual collapse still holds health within five percent of "
      "target. The flow converts a cliff into a lag, and Corollary 5.4 is the size of "
      "the lag. Closing the last fraction of the gap takes time proportional to "
      "ln(<i>g</i>\u2080/\u03b5)/<i>k</i>; at <i>k</i> = 365/yr a gap falls by an order of "
      "magnitude every 55 hours.")

    # ---------------------------------------------------------------- 6
    H1("6. The rent law")
    H2("6.1 A proportional controller on a measured imbalance")
    P("The primitive variable is not set by a committee. It is updated by a t\u00e2tonnement "
      "on the measured gap between the notional demanding buffer access and the capital "
      "offering it (\u00a73.4). Demand is non-increasing in the rent and supply is "
      "non-decreasing, so the excess is monotone and the crossing is attracting.")
    THM("Lemma 6.1 (sign)", "For \u03b7 &gt; 0, <i>z</i> &gt; 0 implies \u03c1 &lt; \u03c1\u2032 and "
        "<i>z</i> &lt; 0 implies \u03c1\u2032 &lt; \u03c1.",
        "Follows from \u03b7<i>z</i> having the sign of <i>z</i>. Machine-checked: <b>T8</b>.")
    THM("Theorem 6.2 (contraction bound)", "For 0 &lt; \u03b7<i>L</i> &lt; 2 with "
        "<i>L</i> = \u2212<i>z</i>\u2032, the linearised map satisfies \u22121 &lt; 1 \u2212 "
        "\u03b7<i>L</i> &lt; 1.",
        "Immediate. Machine-checked: <b>T7</b>, <b>T7b</b>. Hence \u03b7<i>L</i> &lt; 2 is "
        "the stability bound and \u03b7<i>L</i> = 1 is deadbeat.")
    THM("Lemma 6.3 (no overshoot)", "From \u03c1 \u2264 \u03c1*, <i>z</i>(\u03c1) \u2265 0 and "
        "\u03c1 + \u03b7<i>z</i>(\u03c1) \u2264 \u03c1*, one step satisfies \u03c1 \u2264 \u03c1\u2032 \u2264 \u03c1*.",
        "Monotonicity gives <i>z</i>(\u03c1) \u2265 <i>z</i>(\u03c1*) = 0; then "
        "\u03b7<i>z</i>(\u03c1) \u2265 0. Machine-checked: <b>T8</b>; Lean 4: "
        "<font face='Courier'>tatonnement_no_overshoot</font>.")

    H2("6.2 Where the loop is net-negative")
    P("One accrual changes health by the repair minus the rent drag. To first order in "
      "\u0394<i>t</i>, with \u03b4 = <i>f\u00b7tgt\u00b7D</i> and <i>S</i> = <i>s\u00b7D</i>:")
    STORY.extend(EQ(r"\Delta h \;\approx\; \Delta t\left[\frac{k\,f\,s}{tgt} - \rho\right]"
                    r"\qquad \rho < \frac{k\,f\,s}{tgt} \;\Longleftrightarrow\; \Delta h > 0", 12, "6.1"))
    P("Define the margin <i>M</i> = <i>kfs</i>/(<i>tgt</i>\u03c1<sub>max</sub>). With "
      "<i>k</i> = 365/yr, <i>tgt</i> = 1.20 and \u03c1<sub>max</sub> = 0.10/yr:")
    TABLE("Table 4. Margin M = kfs/(tgt\u00b7\u03c1<sub>max</sub>). Cells below 1 invert the loop: "
          "the position is pushed deeper into distress by its own protection.",
          ["s \\ f", "0.005", "0.02", "0.05", "0.20", "0.50"],
          [["0.005", "0.11", "0.44", "1.10", "4.38", "10.95"],
           ["0.010", "0.22", "0.88", "2.19", "8.76", "21.90"],
           ["0.050", "1.10", "4.38", "10.95", "43.80", "109.50"],
           ["0.150", "3.29", "13.14", "32.85", "131.40", "328.50"]],
          widths=[FRAME_W * .16] + [FRAME_W * .168] * 5)
    THM("Proposition 6.4 (spiral onset)", "The position is pushed deeper into distress by "
        "its own protection when <i>f</i> &lt; <i>f</i>* = \u03c1<sub>max</sub><i>tgt</i>/"
        "(<i>ks</i>).",
        "Rearrange (6.1). At <i>s</i> = 0.15, <i>f</i>* is 0.18% of the trigger value at "
        "\u03c1<sub>max</sub> = 0.10/yr, 0.91% at 0.50/yr and 1.83% at 1.0/yr.")
    BOX("Design rule", [
        "Calibrate \u03c1<sub>max</sub> from the <i>smallest</i> (f\u00b7s) corner the protocol "
        "admits \u2014 barely-distressed positions carrying the thinnest permitted buffer \u2014 "
        "and not from the stressed ones. Table 4's top-left is the only part that "
        "matters, and it is the part that looks safe when you calibrate on the "
        "bottom-right.",
        "This is the most consequential quantitative finding in the note, and it is not "
        "visible without writing (6.1) down. It also explains a design asymmetry: "
        "raising \u03c1<sub>max</sub> to attract underwriter capital is safe at high "
        "distress and destabilising at low distress, which is the opposite of the "
        "intuition a risk committee brings to the parameter."])

    # ---------------------------------------------------------------- 7
    H1("7. Refinement to fixed-point integers")
    P("Theorems 4\u20136 are over \u211d; the contract truncates. Truncation can only reduce a "
      "positive quantity, so rounding is intuitively safe, but intuition is what the "
      "remaining lemmas remove. Every division in "
      "<font face='Courier'>_accrue</font> is floored and the arguments are non-negative.")
    THM("Lemma 7.1 (single floor)", "For <i>a</i> \u2265 0 and <i>W</i> \u2265 1: "
        "(\u230aa/W\u230b)\u00b7<i>W</i> \u2264 <i>a</i>.", "Machine-checked: <b>I1</b>.")
    THM("Lemma 7.2 (rent path)", "With <i>burn</i> = \u230a<i>rW</i>/<i>P</i>\u230b and "
        "<i>rem</i> = \u230a<i>burn\u00b7P</i>/<i>W</i>\u230b, for <i>r</i> \u2265 0, <i>W</i> "
        "\u2265 1, <i>P</i> \u2265 1: <i>rem</i> \u2264 <i>r</i>.",
        "The borrower is never charged more rent than the flow computed. "
        "Machine-checked: <b>I2</b>.")
    THM("Lemma 7.3 (absorb path)", "With <i>cx</i> = <i>c\u00b7x</i>, <i>sv</i> = "
        "\u230a<i>cx</i>/<i>W</i>\u230b, <i>su</i> = \u230a<i>sv\u00b7W</i>/<i>P</i>\u230b and "
        "<i>vr</i> = \u230a<i>su\u00b7P</i>/<i>W</i>\u230b: <i>vr</i> \u2264 <i>c\u00b7x</i>.",
        "The value released to the underwriter never exceeds <i>c\u00b7x</i>, so rounding "
        "always favours the buffer line. Machine-checked: <b>I3</b>.")
    THM("Theorem 7.4 (integer invariant, exactly)", "For <i>c</i> &gt; 0, <i>x</i> \u2264 "
        "<i>D</i>, <i>cD</i> \u2264 <i>V</i>, <i>r</i> \u2264 <i>V</i> \u2212 <i>cD</i> and "
        "any <i>W</i>, <i>P</i> \u2265 1: <i>c</i>(<i>D</i> \u2212 <i>x</i>) \u2264 "
        "(<i>V</i> \u2212 <i>rem</i>) \u2212 <i>vr</i>.",
        "Machine-checked: <b>I4</b> by both solvers, and independently by an exhaustive "
        "campaign of 122,760 integer states using the exact truncating semantics of the "
        "Solidity, with zero violations.")
    P("<b>Corollary 7.5.</b> Theorems 4.1\u20134.3 hold over \u211d; Lemmas 7.1\u20137.3 and "
      "Theorem 7.4 show the integer implementation's per-step transition satisfies the "
      "same inequality. Since the invariant is inductive, the contract preserves "
      "<i>S</i> \u2265 0 on every reachable state for any sequence of operations \u2014 not "
      "up to a wei, but exactly.")

    H2("7.4 A second correction")
    P("Theorem 7.4 as first stated omitted the rent cap, and Z3 returned <i>c</i> = 1, "
      "<i>D</i> = 1, <i>V</i> = 1, <i>r</i> = 2: a rent of two on a position whose "
      "surplus is zero. The contract caps rent at <i>S</i>, so the counterexample lies "
      "outside the code's domain \u2014 but the <i>statement</i> was wrong, and a statement "
      "that leans on an unstated precondition is exactly the kind that manufactures "
      "false confidence. The corrected form carries <i>r</i> \u2264 <i>V</i> \u2212 <i>cD</i> "
      "as a hypothesis matching the line "
      "<font face='Courier'>if (rentDue &gt; s) rentDue = s;</font>.")

    # ---------------------------------------------------------------- 8
    H1("8. Verification methodology")
    H2("8.1 The SMT protocol")
    P("For each statement we assert the hypotheses together with the negation of the "
      "goal and hand the formula to two independent solvers. <i>Unsat</i> means no "
      "assignment satisfies the hypotheses and falsifies the goal, so the statement is "
      "valid; for quantifier-free real arithmetic both Z3 (nlsat) and cvc5 use complete "
      "decision procedures, so <i>unsat</i> is a decision rather than a failed search. "
      "<i>Sat</i> returns a model, which is printed as a counterexample. <i>Unknown</i> "
      "is reported as unknown, and nothing is ever recorded as proved on the strength of "
      "it. Every formula is also emitted as an SMT-LIB2 file so that a sceptic can "
      "re-check any single theorem with any front end.")
    H2("8.2 Executable invariants")
    P("The contract is additionally exercised on a live EVM. Five campaigns cover "
      "buffer-line preservation under random marks and rents (1,000 steps), strict "
      "health increase in the distress band (400 distressed accruals, all strictly "
      "positive), the sign law of the rent update (60 steps, zero violations), a "
      "ten-percent mark shock healed by the flow alone in 60 days with zero keeper "
      "calls, and an exact conservation check that the surplus falls by precisely the "
      "rent paid (residual zero to the wei).")
    H2("8.3 On the Lean artefact")
    P("A Lean 4 development of the same statements is included in the repository. It "
      "has <i>not</i> been compiled: no Lean toolchain was reachable in the environment "
      "where this note was produced, and the bootstrap binaries were network-blocked. It "
      "is restricted to core Lean 4 with no Mathlib for that reason, and its content is "
      "cross-validated by the SMT suite. We list it as an artefact to be finished, not "
      "as evidence.")
    H2("8.4 Threats to validity")
    P("Three, all material. The solvers verify <i>statements</i>, and a statement can be "
      "weaker than the code it is meant to describe; \u00a77.4 is an instance where the "
      "statement was weaker than intended. The refinement argument covers arithmetic, "
      "not storage layout, access control or upgrade paths. And the whole safety "
      "analysis is conditional on the underwriter being unlevered (\u00a710.1), which is an "
      "economic assumption enforced by the pool's construction rather than by a proof.")

    TABLE("Table 5. Verification ledger.",
          ["Artefact", "Method", "Status"],
          [["Algebraic core (T1\u2013T6, T9\u2013T12)", "Z3 + cvc5, QF_NRA", "proved"],
           ["Control bounds (T7, T7b, T8)", "Z3 + cvc5", "proved"],
           ["Floor bounds (I1\u2013I3)", "Z3 + cvc5", "proved"],
           ["Integer invariant (I4)", "Z3 + cvc5 + 122,760-state grid", "proved"],
           ["Closed form of the ODE", "sympy dsolve / limit", "symbolic"],
           ["Contract on live EVM", "Hardhat EDR, 1,490 accruals", "holds"],
           ["Lean 4 development", "\u2014", "not compiled"],
           ["Underwriter incentive compatibility", "\u2014", "admitted"]],
          widths=[FRAME_W * .44, FRAME_W * .38, FRAME_W * .18])

    # ---------------------------------------------------------------- 9
    H1("9. Economics")
    H2("9.1 Who pays whom")
    TABLE("Table 6. The payment structure.",
          ["", "Payer", "Payee", "When", "Amount"],
          [["Rent", "borrower", "underwriter pool", "continuously",
            "\u2308 min(\u03c1D\u0394t, S)"],
           ["Absorption", "underwriter pool", "lender (debt retired)", "continuously",
            "x = k\u00b7g\u0394t/tgt"],
           ["Collateral", "borrower position", "underwriter pool", "with absorption",
            "worth c\u00b7x at the mark"],
           ["Liquidation", "\u2014", "\u2014", "never", "\u2014"]],
          widths=[FRAME_W * .14, FRAME_W * .18, FRAME_W * .22, FRAME_W * .18,
                  FRAME_W * .28])
    P("The borrower's cost is a rent on surplus plus a discount on the amount actually "
      "absorbed. In the reference configuration the discount is 2% against a 5\u201310% "
      "liquidation bonus charged on a close-factor-sized block. The underwriter's gross "
      "margin is (<i>c</i>\u22121) per unit of debt retired, and inside the surface "
      "Theorem 4.1 makes the residual position at least as collateralised as before, so "
      "the trade is positive at the level of the accounting.")

    H2("9.2 A participant class")
    P("The keeper is levered on latency and light on capital. The buffer underwriter is "
      "the opposite: unlevered, latency-irrelevant, and compensated with a discovered "
      "spread for standing ready. That substitution is the mechanism's main structural "
      "claim, and it is checkable rather than asserted: <font face='Courier'>poke()</font> "
      "pays nothing and the state transition never reads the caller, so there is no rent "
      "to race for and no searcher class can form around the accrual.")

    H2("9.3 Implementation notes")
    P("Two operational issues deserve recording. Absorption is bounded by pool cash; an "
      "empty book leaves the position solvent but distressed, which degrades to patience "
      "rather than to a cliff. And the rent book is free optionality unless bids are "
      "committed: an adversary can post a large bid, push \u03c1 to the ceiling for one "
      "block, withdraw it and repeat, bleeding the surplus at \u03c1<sub>max</sub> per year. "
      "The prototype enforces a minimum bid lock and refuses repricing inside the lock "
      "window; the optimal lock length is left open.")

    # ---------------------------------------------------------------- 10
    H1("10. Red team")
    H2("10.1 Economic death")
    P("Three boundaries, all closed-form and all monitorable on-chain. (i) <b>Discount "
      "crosses buffer</b>: if <i>c</i> \u2265 1 + <i>b</i>, Theorem 4.4 applies and each "
      "unit absorbed lowers health; the multiplier must be immutable and the constructor "
      "must enforce <i>tgt</i> &gt; <i>c</i>. (ii) <b>Rent drag outruns repair</b>: "
      "condition (6.1), with onset given by Proposition 6.4; the failure region is "
      "inversely proportional to the buffer, so small positions are the exposed ones. "
      "(iii) <b>T\u00e2tonnement overshoot</b>: \u03b7 outside the contraction bound, which "
      "pumps surplus in both directions of the rent; the clamp bounds the excursion. "
      "Finally, the recursive case: an underwriter that borrows against the collateral "
      "it absorbs acquires its own buffer line and its own flow, and a large shock makes "
      "it deleverage into the fall it is meant to cushion. This is the one that is fatal "
      "and it is not a parameter problem.")
    H2("10.2 Technical death")
    P("The rent is oracle-free; the distress measure is not. The cheapest attack is a "
      "mark-down by the underwriter itself: push the mark down, force absorption, and "
      "buy real collateral at \u03b5 below a mark you control. The defence is that the "
      "absorbed amount is <i>O</i>(\u0394<i>t</i>): at <i>k</i> = 365/yr a twelve-second "
      "block absorbs 1.4\u00b710\u207b\u2074 of the gap, so retiring ten percent of a fully "
      "distressed position requires roughly sixteen hours of sustained manipulation, "
      "during which the attacker is not manipulating but holding a position. Profit over "
      "cost vanishes with block time \u2014 the same argument that makes perp funding "
      "unmanipulable in a single block. A stale mark is the residual risk: the flow keeps "
      "running at the last mark, which is wrong but bounded, and freezing the flow is "
      "strictly worse than running it because a frozen flow plus a fresh mark produces "
      "the very jump the mechanism exists to prevent.")
    H2("10.3 Regulatory death")
    P("The borrower pays a periodic premium to a counterparty in exchange for that "
      "counterparty absorbing a defined credit-contingent loss on a reference "
      "obligation. That is a credit default swap, and the characterisation is structural "
      "rather than a matter of labels: in the United States a CDS on a loan is a swap "
      "under the Commodity Exchange Act, and in the European Union it is a derivative "
      "under MiFID II, with a retail premium-paying cover product functioning as "
      "insurance \u2014 a regulated activity requiring authorisation in each member state. "
      "The mechanism dies first in the EU retail perimeter, not on economics. The "
      "survivable configuration is professional underwriters, no transferable position "
      "token on the underwriter side, and jurisdiction-shopped issuance, which is "
      "precisely the configuration that keeps the addressable market institutional.")

    # ---------------------------------------------------------------- 11
    H1("11. Related work")
    P("Milionis, Moallemi, Roughgarden and Zhang decompose LP returns into a beta "
      "component and a microstructural alpha, and show that the instantaneous "
      "loss-versus-rebalancing rate of a constant-product pool is \u03c3\u00b2/8 per unit "
      "time; they also observe that a delta-hedged LP position is a generalised variance "
      "swap. That observation is why we classify LVR as hedgeable and disqualify it in "
      "\u00a72: hedging is not deletion.")
    P("Everlasting options replace expiry with a funding rate paid by the holder, which "
      "is the same generative move applied to a different instrument; it is published "
      "and partially deployed, so it constrains novelty here rather than supporting it. "
      "Aave v4 ramps the liquidation bonus with health and sizes liquidation to a target "
      "health factor, both governed parameters with a keeper-triggered event that "
      "remains satisfiable. Liquity, Maker and Ajna clear seizures through auctions, "
      "which presupposes the lump. Recent work on batch liquidation benchmarks against a "
      "\u201ccontinuous liquidation\u201d baseline, so continuity alone is not the "
      "contribution; the contribution is continuity priced by an endogenous book, with "
      "no privileged caller, and an invariant that makes the event unsatisfiable.")

    # ---------------------------------------------------------------- 12
    H1("12. Conclusion")
    P("Liquidation is a discrete transfer attached to a race. It is not a necessary "
      "feature of collateralised credit: decomposing a position into a buffer line and a "
      "buffer surplus shows that a purchase priced at the line is exactly neutral in the "
      "surplus, which makes health a function of debt alone and turns the liquidation "
      "predicate into a contradiction rather than an event. What replaces it is a rent "
      "on the buffer, discovered by the same kind of local feedback that prices a "
      "perpetual swap's basis, and paid to a participant whose advantage is capital "
      "patience rather than latency.")
    P("The verification is reported with its failures. Two statements were false as "
      "first written; the solvers found the counterexamples; the corrected statements "
      "are weaker and true. One assumption \u2014 an unlevered underwriter \u2014 is "
      "load-bearing and unproved. And the instrument is structurally a credit default "
      "swap, which is a sentence about the size of the market rather than about the "
      "soundness of the mechanism.")

    H1("13. Future work")
    BL([
        "A multi-agent simulation with levered underwriters, to locate the boundary at "
        "which the recursive case in \u00a710.1 dominates.",
        "Discretising the mark path to a finite lattice so that underwriter incentive "
        "compatibility becomes a decidable statement and can be discharged by SMT rather "
        "than admitted.",
        "The optimal bid-lock length, which trades manipulation resistance against the "
        "cost the borrower bears for repricing.",
        "Completing the Lean development, and mechanically linking it to the contract "
        "through a verified extraction rather than a hand refinement argument.",
    ])

    H1("Acknowledgements")
    P("The sector data is from DeFiLlama, read live on 12 November 2026. Theorems were "
      "discharged by Z3 5.4.1 and cvc5 1.4.2 through their Python bindings; the closed "
      "form in \u00a75.2 was verified with SymPy. The Aave v4 parameter description follows "
      "the governance forum posts cited below.")

    H1("References")
    refs = [
        "[1] J. Milionis, C. C. Moallemi, T. Roughgarden, A. L. Zhang. Automated Market "
        "Making and Loss-Versus-Rebalancing. arXiv:2208.06046, v6, 2026.",
        "[2] D. White, S. Bankman-Fried. Everlasting Options. 2021.",
        "[3] Aave governance forum. Aave v4: New Features and Risk Parameter Analysis; "
        "[ARFC] Aave V4 Activation on Ethereum Mainnet. 2025\u20132026.",
        "[4] BALI: Solvency-Constrained Batch Liquidation as a Cryptoeconomic Control "
        "Mechanism. SSRN 6668879, 2026.",
        "[5] Measuring the engine of a liquidation cascade. arXiv:2608.03616, 2026.",
        "[6] DeFiLlama. Protocol categories and protocol index, read 12 November 2026.",
        "[7] Continuum repository: contracts, SMT certificates, execution harness. "
        "research/continuum in this repository.",
    ]
    for r in refs:
        STORY.append(Paragraph(sanitize(r), S["ref"]))

    H1("Appendix A. Reproducing every claim")
    P("From the repository root:")
    CODE("cd research/continuum\ntext\npython3 -m venv .venv && ./.venv/bin/pip install "
         "z3-solver cvc5 sympy numpy\n\n./.venv/bin/python verify/proofs.py --smt2      "
         "# 18 SMT theorems + exhaustive grid\n./.venv/bin/python verify/ode_study.py      "
         "      # closed form of the flow ODE\n./.venv/bin/python whitepaper/build.py      "
         "      # this document\n\ncd verify\nnpm i solc@0.8.24 hardhat@^2 "
         "@nomicfoundation/hardhat-ethers@^3 ethers@^6\nnode compile.mjs              "
         "                 # compile the contract\nnpx hardhat run run.cjs           "
         "            # five invariant campaigns on a real EVM")
    P("Any single theorem can be re-checked independently, e.g. "
      "<font face='Courier'>z3 verify/smt/T5.smt2</font>, which prints <i>unsat</i>.")
    STORY.append(Spacer(1, 6))
    P("<i>Document typeset with ReportLab; equations rendered with matplotlib mathtext. "
      "Source and build script are in <font face='Courier'>whitepaper/build.py</font>.</i>",
      "cap")


def main():
    out = os.path.join(HERE, "Continuum-Whitepaper.pdf")
    build_content()
    doc = Paper(out)
    doc.multiBuild(STORY)
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
