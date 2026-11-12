// Everlasting option — the 2021 construction, checked numerically.
// White & Bankman-Fried (2021), "Everlasting Options", Paradigm.
//   A.2  funding per payment = (MARK - PAYOFF) / FUNDING_FREQUENCY
//   B.1  price = (1/F) * sum_{i>=1} (F/(F+1))^i * REGPRICE_{t_i}
// r = 0 throughout, so the option value is time-homogeneous.

const PHI = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {                      // Abramowitz-Stegun 7.1.26, |err|<1.5e-7
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const bsCall = (S, K, T, sig) => {
  if (T <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / (sig * Math.sqrt(T));
  const d2 = d1 - sig * Math.sqrt(T);
  return S * PHI(d1) - K * PHI(d2);
};

// Continuous limit: V = lam * int_0^inf e^{-lam u} C(u) du
function vExact(S, K, sig, lam, U = 12 / lam) {
  const n = 40000, du = U / n; let acc = 0;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) * du;
    acc += Math.exp(-lam * u) * bsCall(S, K, u, sig) * du;
  }
  return lam * acc;
}

// Paper B.1, finite truncation at N rungs. F payments per period of length P.
function vLadder(S, K, sig, P, F, N, wantMass) {
  const q = F / (F + 1); let acc = 0, mass = 0;
  for (let i = 1; i <= N; i++) {
    const w = (1 / F) * Math.pow(q, i);
    acc += w * bsCall(S, K, (i * P) / F, sig); mass += w;
  }
  if (wantMass) return { v: acc, mass };
  return acc;
}

const S = 3000, K = 3000, sig = 0.6, P = 1 / 365;   // one-day funding period
const lam = 1 / P;
const ex = vExact(S, K, sig, lam);

console.log("=== B.1 converges to the exponential strip as F grows ===");
console.log("F (payments/period)   ladder value    error vs exact   error/notional");
for (const F of [1, 2, 24, 144, 1440, 8640]) {
  // enough rungs to make the tail mass < 1e-13: q^N < 1e-13  =>  N > 30 F
  const N = Math.min(Math.ceil(30 * F) + 10, 400000);
  const { v, mass } = vLadder(S, K, sig, P, F, N, true);
  const e = v - ex;
  console.log(String(F).padStart(8), String(N).padStart(7), v.toFixed(4).padStart(15),
    e.toFixed(4).padStart(14), ((e / S) * 1e4).toFixed(3).padStart(12) + " bp",
    ((1 - mass) * 1e6).toFixed(2).padStart(10) + " ppm tail");
}
console.log("exact (lam -> integral):", ex.toFixed(4), " vs 1-day ATM call:", bsCall(S, K, P, sig).toFixed(4));

// The modified Black-Scholes PDE the continuous instrument must satisfy:
//   0.5*sig^2*S^2*V_SS = lam*(V - payoff)      (r = 0, time-homogeneous)
console.log("\n=== PDE residual  0.5 sig^2 S^2 V_SS - lam (V - payoff) ===");
const h = S * 1e-3;   // coarser step: V_SS has a 1/sqrt(u) singularity at the kink
for (const s of [2400, 2700, 3000, 3300, 3600]) {
  const vSS = (vExact(s + h, K, sig, lam) - 2 * vExact(s, K, sig, lam) + vExact(s - h, K, sig, lam)) / (h * h);
  const lhs = 0.5 * sig * sig * s * s * vSS;
  const rhs = lam * (vExact(s, K, sig, lam) - Math.max(s - K, 0));
  console.log(`S=${s}  lhs=${lhs.toFixed(4)}  rhs=${rhs.toFixed(4)}  residual=${(lhs - rhs).toFixed(4)}`);
}

// The discontinuity the paper warns about: at each funding instant the long pays
// MARK - PAYOFF, so the traded value jumps by the time value. Size vs frequency.
// The discrete funding instant: the payment lands in one block, so a stale quote
// can be farmed for the whole of it. The size of that prize is TV/F, so it vanishes
// as 1/F and is exactly zero under continuous accrual.
console.log("\n=== prize for farming one funding instant (TV / F) ===");
console.log("F        instant payment    as bp of notional    annualised if farmed daily");
for (const F of [1, 24, 1440]) {
  const tv = ex - Math.max(S - K, 0);              // ATM: time value == value
  const pay = tv / F;
  console.log(String(F).padStart(5), pay.toFixed(4).padStart(18),
    ((pay / S) * 1e4).toFixed(3).padStart(19) + " bp",
    ((pay / S) * 365 * 1e4).toFixed(0).padStart(21) + " bp");
}
console.log("continuous accrual: payment is a rate, instant prize = 0, and a trader");
console.log("holding for eps receives eps*rate while bearing eps of the risk -- no free lunch.");

// What vanilla maturity has the same value as the everlasting? The paper says
// "twice daily behaves almost exactly like a one-day option"; measure it.
console.log("\n=== equivalent vanilla maturity of the everlasting (lambda = 1/day) ===");
let lo = 1e-6, hi = 0.02;
for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; (bsCall(S, K, m, sig) < ex) ? lo = m : hi = m; }
console.log(`value ${ex.toFixed(4)} == vanilla with T = ${((lo + hi) / 2).toFixed(6)} yr ` +
  `= ${(((lo + hi) / 2) * 365).toFixed(3)} days  (period P = 1.000 day)`);
console.log(`one-day vanilla is ${bsCall(S, K, P, sig).toFixed(4)}, ` +
  `${(((bsCall(S, K, P, sig) / ex) - 1) * 100).toFixed(1)}% above the everlasting`);
