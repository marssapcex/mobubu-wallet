; gap shrinks: x>0 ∧ tgt>c ⟹ gap' < gap
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun x () Real)
(declare-fun tgt () Real)
(declare-fun c () Real)
(declare-fun V () Real)
(declare-fun D () Real)
(assert
 (< 0.0 x))
(assert
 (< c tgt))
(assert
 (let ((?x112 (* tgt D)))
(let ((?x165 (- ?x112 V)))
(not (< (- (* tgt (- D x)) (- V (* c x))) ?x165)))))
(check-sat)
