; single floor: a>=0 ∧ W>=1 ⟹ (a div W)*W <= a
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun a () Int)
(declare-fun W () Int)
(assert
 (<= 0 a))
(assert
 (<= 1 W))
(assert
 (not (<= (* (div a W) W) a)))
(check-sat)
