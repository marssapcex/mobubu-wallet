import { makeFriReference } from '../research/fri-reference.mjs';
import { STARK256_RESEARCH } from '../stark256-profile.mjs';

export const { benchmarkCoefficients, framedHasher, HEADER_BYTES, mul, powBase, proveFri, QUERY_BYTES } =
  makeFriReference(STARK256_RESEARCH, 2, 'hcmtrail/eth-pool/stark256/research/v2');
