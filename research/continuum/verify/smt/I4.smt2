; integer step: cD<=V ∧ r<=V-cD ∧ x<=D ∧ all floors ⟹ c(D-x) <= (V-rem)-vr
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun c () Int)
(declare-fun x () Int)
(declare-fun D () Int)
(declare-fun V () Int)
(declare-fun W () Int)
(declare-fun p () Int)
(declare-fun r () Int)
(declare-fun cx () Int)
(assert
 (< 0 c))
(assert
 (<= 0 x))
(assert
 (<= x D))
(assert
 (let ((?x199 (* c D)))
 (<= ?x199 V)))
(assert
 (<= 1 W))
(assert
 (<= 1 p))
(assert
 (<= 0 r))
(assert
 (<= r (- V (* c D))))
(assert
 (let ((?x191 (* c x)))
 (= cx ?x191)))
(assert
 (let ((?x141 (div (* (div (* r W) p) p) W)))
 (<= ?x141 V)))
(assert
 (let ((?x141 (div (* (div (* r W) p) p) W)))
 (<= ?x141 r)))
(assert
 (let ((?x155 (div (* (div (* (div cx W) W) p) p) W)))
 (<= ?x155 cx)))
(assert
 (let ((?x155 (div (* (div (* (div cx W) W) p) p) W)))
(let (($x208 (<= (* c (- D x)) (- (- V (div (* (div (* r W) p) p) W)) ?x155))))
(not $x208))))
(check-sat)
