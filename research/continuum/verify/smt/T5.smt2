; no liquidatable state: c>1 ∧ D>0 ∧ cD<=V ⟹ V>D
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun c () Real)
(declare-fun D () Real)
(declare-fun V () Real)
(assert
 (< 1.0 c))
(assert
 (< 0.0 D))
(assert
 (let ((?x13 (* c D)))
 (<= ?x13 V)))
(assert
 (not (< D V)))
(check-sat)
