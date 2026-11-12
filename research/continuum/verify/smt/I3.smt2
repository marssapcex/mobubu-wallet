; flow rounding: cx>=0 ∧ W>=1 ∧ p>=1 ⟹ value actually released <= cx
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun cx () Int)
(declare-fun W () Int)
(declare-fun p () Int)
(declare-fun x () Int)
(declare-fun c () Int)
(assert
 (<= 0 cx))
(assert
 (<= 1 W))
(assert
 (<= 1 p))
(assert
 (let ((?x191 (* c x)))
 (= cx ?x191)))
(assert
 (<= 0 c))
(assert
 (<= 0 x))
(assert
 (let ((?x191 (* c x)))
(let ((?x155 (div (* (div (* (div cx W) W) p) p) W)))
(not (<= ?x155 ?x191)))))
(check-sat)
