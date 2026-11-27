import { ETH_POOL_RELEASE_POLICY } from '../pool/release-policy.mjs';
import { ETH_POOL_LEGACY } from '../pool/lab-profile.mjs';
import { STARK256_RESEARCH, algebraicBudget, errorBits, oracleTermScales } from '../pool/stark256-profile.mjs';

const bits = (term) => Number(errorBits(term).toFixed(2));
function screen(profile) {
  const b = algebraicBudget(profile);
  const q = oracleTermScales(profile);
  return {
    profile,
    termsBits: Object.fromEntries(Object.entries(b.terms).map(([name, term]) => [name, bits(term)])),
    conditionalRbrBudgetBits: bits(b.union),
    conditionalClassicalProjectionBits: bits(b.romProjection),
    idealDigestClassicalCollisionWorkBits: b.collisionWorkBits,
    passesClassicalArithmeticScreenOnly: b.meetsArithmeticTarget,
    quantumTermScalesOnly: { logOracleBudget: q.logQuantumQueries, rbrBits: bits(q.rbr), idealCollisionBits: bits(q.idealCollision) },
    spendVerifierImplemented: false,
    quantumAnalysisEstablished: false,
  };
}
console.log(JSON.stringify({
  policy: ETH_POOL_RELEASE_POLICY,
  localLab: ETH_POOL_LEGACY,
  friExperiment: screen(STARK256_RESEARCH),
  warning: 'Parameter worksheet only. These are not protocol security bounds or custody approvals.',
}, null, 2));
