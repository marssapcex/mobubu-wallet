; no bad debt: c>0 ∧ x<=D ∧ cD<=V ⟹ c(D-x) <= V-cx
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun c () Real)
(declare-fun D () Real)
(declare-fun x () Real)
(declare-fun V () Real)
(assert
 (< 0.0 c))
(assert
 (<= x D))
(assert
 (let ((?x13 (* c D)))
 (<= ?x13 V)))
(assert
 (not (<= (* c (- D x)) (- V (* c x)))))
(check-sat)
