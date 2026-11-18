; drift equilibrium: gap*k=vV ∧ gap=tgt*D-V ∧ k>0 => tgt*D*k = V*(k+v)
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun k () Real)
(declare-fun V () Real)
(declare-fun v () Real)
(declare-fun g () Real)
(declare-fun D () Real)
(declare-fun tgt () Real)
(assert
 (< 0.0 k))
(assert
 (= (* g k) (* v V)))
(assert
 (let ((?x112 (* tgt D)))
 (let ((?x165 (- ?x112 V)))
 (= g ?x165))))
(assert
 (not (= (* (* tgt D) k) (* V (+ k v)))))
(check-sat)
