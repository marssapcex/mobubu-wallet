; stability bound, lower side
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun L () Real)
(declare-fun eta () Real)
(assert
 (let ((?x45 (* eta L)))
 (< 0.0 ?x45)))
(assert
 (let ((?x45 (* eta L)))
 (> 2.0 ?x45)))
(assert
 (not (< (- 1.0) (- 1.0 (* eta L)))))
(check-sat)
