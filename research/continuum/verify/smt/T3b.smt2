; health strictly monotone when the buffer is strict: cD<V ∧ 0<=x1<x2<D ⟹ h(x1) < h(x2)
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun c () Real)
(declare-fun x1 () Real)
(declare-fun x2 () Real)
(declare-fun D () Real)
(declare-fun V () Real)
(assert
 (< 1.0 c))
(assert
 (<= 0.0 x1))
(assert
 (< x1 x2))
(assert
 (< x2 D))
(assert
 (let ((?x13 (* c D)))
 (< ?x13 V)))
(assert
 (let ((?x292 (* (- V (* c x2)) (- D x1))))
(let ((?x324 (* (- V (* c x1)) (- D x2))))
(not (< ?x324 ?x292)))))
(check-sat)
