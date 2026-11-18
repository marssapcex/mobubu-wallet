; rent conservation: S(payRent(V,r)) = S(V) - r
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun r () Real)
(declare-fun D () Real)
(declare-fun c () Real)
(declare-fun V () Real)
(assert
 (not (= (- (- V r) (* c D)) (- (- V (* c D)) r))))
(check-sat)
