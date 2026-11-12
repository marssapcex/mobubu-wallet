; rent rounding: r>=0 ∧ W>=1 ∧ p>=1 ⟹ value actually removed <= r
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun r () Int)
(declare-fun W () Int)
(declare-fun p () Int)
(assert
 (<= 0 r))
(assert
 (<= 1 W))
(assert
 (<= 1 p))
(assert
 (let ((?x141 (div (* (div (* r W) p) p) W)))
(let (($x152 (<= ?x141 r)))
(not $x152))))
(check-sat)
