; debt monotone: 0<=x ⟹ D-x <= D
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun x () Real)
(declare-fun D () Real)
(assert
 (<= 0.0 x))
(assert
 (not (<= (- D x) D)))
(check-sat)
