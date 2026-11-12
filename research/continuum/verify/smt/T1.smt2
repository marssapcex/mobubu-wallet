; buffer invariance: S(delever(V,D,c,x)) = S(V,D,c)
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun D () Real)
(declare-fun c () Real)
(declare-fun V () Real)
(declare-fun x () Real)
(assert
 (let ((?x13 (* c D)))
(let ((?x14 (- V ?x13)))
(not (= (- (- V (* c x)) (* c (- D x))) ?x14)))))
(check-sat)
