import { GOLDILOCKS } from '../testnet/networks.mjs';
import { ETH_POOL_RELEASE_POLICY } from './release-policy.mjs';

// HCFR v2 is a distinct FRI proximity experiment, not an ETH authorization
// profile. Neither a passing worksheet nor v2 openings can enable custody.
export const STARK256_RESEARCH = Object.freeze({
  id: 'HCFR-v2-FRI-only', status: 'research-fri-only', hash: 'BLAKE2b-512 / EIP-152',
  extensionDegree: 8, digestBits: 512,
  maxDegreeLog: 18, blowupLog: 6, proximityM: 3, queries: 144, foldRadix: 8, maxFoldRounds: 6,
  maxAlphaDegree: 1 << 18, maxOodIdentityDegree: 1 << 22, maxCopyDegree: 2 ** 32,
  romBudgetLog: 48,
});

const error = (numerator, denominator) => ({ numerator, denominator });
const sum = (a, b) => error(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const times = (a, n) => error(a.numerator * BigInt(n), a.denominator);
export const atLeastBits = (e, bits) => (e.numerator << BigInt(bits)) <= e.denominator;

// Only for displaying a decimal approximation. Admission comparisons are exact BigInt.
function log2(n) {
  const excess = Math.max(0, n.toString(2).length - 52);
  return Math.log2(Number(n >> BigInt(excess))) + excess;
}
export const errorBits = (e) => log2(e.denominator) - log2(e.numerator);

export function algebraicBudget(profile = STARK256_RESEARCH) {
  const { extensionDegree, digestBits, maxDegreeLog, blowupLog, proximityM, queries, foldRadix,
    maxFoldRounds, maxAlphaDegree, maxOodIdentityDegree, maxCopyDegree, romBudgetLog } = profile;
  const required = [[extensionDegree, 1, 8], [digestBits, 1, 1024], [maxDegreeLog, 1, 26], [blowupLog, 2, 16],
    [proximityM, 1, 32], [queries, 1, 1024], [foldRadix, 2, 64], [maxFoldRounds, 1, 32],
    [maxAlphaDegree, 1, 2 ** 32], [maxOodIdentityDegree, 1, 2 ** 32], [maxCopyDegree, 1, 2 ** 40], [romBudgetLog, 0, 128]];
  if (!required.every(([n, min, max]) => Number.isInteger(n) && n >= min && n <= max) ||
    blowupLog % 2 !== 0 || maxDegreeLog + blowupLog > 32 || (foldRadix & (foldRadix - 1)) !== 0 ||
    maxFoldRounds * Math.log2(foldRadix) < maxDegreeLog) throw new Error('Unsupported soundness worksheet parameters');
  const pK = GOLDILOCKS ** BigInt(extensionDegree);
  const D = 1n << BigInt(maxDegreeLog);
  const N = D << BigInt(blowupLog);
  const m = BigInt(proximityM);
  // BCIKS20-style terms used by the pinned upstream worksheet (§2 and §3).
  // No grind credit at any stage. Assume independent uniform query draws;
  // the new AIR, DEEP batching, domain exclusions and challenge order must
  // actually satisfy the hypotheses before any reliance on these numbers.
  const johnson = error((2n * m + 1n) ** 7n * N ** 2n * (1n << BigInt(3 * blowupLog / 2)), 384n * pK);
  const queryBase = error(2n * m + 1n, 2n * m * (1n << BigInt(blowupLog / 2)));
  if (queryBase.numerator >= queryBase.denominator || pK <= 2n * N) throw new Error('Degenerate soundness worksheet');
  const terms = {
    composition: error(BigInt(maxAlphaDegree), pK),
    copy: error(BigInt(maxCopyDegree), pK),
    ood: error(BigInt(maxOodIdentityDegree), pK - 2n * N), // allow exclusion of up to two evaluation-domain sized sets
    deep: johnson,
    folds: times(johnson, (foldRadix - 1) * maxFoldRounds),
    queries: error(queryBase.numerator ** BigInt(queries), queryBase.denominator ** BigInt(queries)),
  };
  const union = Object.values(terms).reduce(sum);
  // Conditional RBR screen. To apply it to a real spend proof, prove the
  // reduction for the actual serialization, Merkle-to-oracle binding and AIR.
  const budget = 1n << BigInt(romBudgetLog);
  const idealCollision = error(budget * (budget + 1n), 1n << BigInt(digestBits + 1));
  const romProjection = sum(times(union, budget + 1n), idealCollision);
  const collisionWorkBits = Math.floor(digestBits / 2);
  const threshold = ETH_POOL_RELEASE_POLICY.minClassicalSoundnessBits;
  return { terms, union, idealCollision, romProjection, collisionWorkBits,
    meetsArithmeticTarget: atLeastBits(romProjection, threshold) && collisionWorkBits >= threshold };
}

// Compare the leading scales in CMS19, Theorem 8.6, in an *ideal* oracle.
// This is parameter triage only. We do not instantiate the theorem, assign
// constants to its O() terms, or assume the HCFR transcript meets its hypotheses.
export function oracleTermScales(profile = STARK256_RESEARCH, logQuantumQueries = 128) {
  if (!Number.isInteger(logQuantumQueries) || logQuantumQueries < 0 || logQuantumQueries > 256) {
    throw new Error('Unsupported oracle worksheet budget');
  }
  const { union } = algebraicBudget(profile);
  const t = 1n << BigInt(logQuantumQueries);
  return {
    logQuantumQueries,
    rbr: { numerator: t * t * union.numerator, denominator: union.denominator },
    idealCollision: { numerator: t ** 3n, denominator: 1n << BigInt(profile.digestBits) },
  };
}
