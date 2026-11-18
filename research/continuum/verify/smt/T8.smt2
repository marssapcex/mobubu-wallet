; no overshoot: z(rho)>=0 ∧ rho+eta*z <= rhoS ⟹ rho <= rho+eta*z <= rhoS
; we assert hypotheses + the NEGATION of the goal; unsat => theorem valid
; benchmark generated from python API
(set-info :status unknown)
(declare-fun zr () Real)
(declare-fun eta () Real)
(declare-fun rhoS () Real)
(declare-fun rho () Real)
(assert
 (<= 0.0 zr))
(assert
 (<= 0.0 eta))
(assert
 (<= rho rhoS))
(assert
 (let ((?x83 (* eta zr)))
 (let ((?x77 (+ rho ?x83)))
 (<= ?x77 rhoS))))
(assert
 (not (<= rho (+ rho (* eta zr)))))
(check-sat)
