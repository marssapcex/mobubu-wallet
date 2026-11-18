; h = c + S/D  (i.e. D*c + S = V)
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun V () Real)
(declare-fun D () Real)
(declare-fun c () Real)
(assert
 (not (= (+ (* D c) (- V (* c D))) V)))
(check-sat)
