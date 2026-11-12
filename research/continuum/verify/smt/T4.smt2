; spiral: V < cD ∧ 0<x<D ⟹ deleveraging LOWERS health
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun c () Real)
(declare-fun x () Real)
(declare-fun D () Real)
(declare-fun V () Real)
(assert
 (< 0.0 c))
(assert
 (< 0.0 x))
(assert
 (< x D))
(assert
 (let ((?x13 (* c D)))
 (< V ?x13)))
(assert
 (not (< (* (- V (* c x)) D) (* V (- D x)))))
(check-sat)
