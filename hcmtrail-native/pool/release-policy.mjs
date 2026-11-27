// Release policy for the ETH pool, not the legacy devnet or other vaults.
// No flags, environment variables, profile metadata or calculated worksheet
// numbers can approve a custody build. There is no reviewed spend profile yet.
export const ETH_POOL_RELEASE_POLICY = Object.freeze({
  minClassicalSoundnessBits: 256,
  targetQuantumSecurityBits: 128,
  requireReviewedQuantumAnalysis: true,
  approvedSpendProfile: null,
  releaseAllowed: false,
});

export function requireEthPoolRelease() {
  const { minClassicalSoundnessBits, targetQuantumSecurityBits } = ETH_POOL_RELEASE_POLICY;
  throw new Error(`ETH pool release blocked: requires ≥${minClassicalSoundnessBits}-bit classical soundness ` +
    `and separate reviewed evidence for the ${targetQuantumSecurityBits}-bit quantum target. ` +
    'No pinned note-spend profile qualifies. NotBefore A is test ETH only; no fallback.');
}
