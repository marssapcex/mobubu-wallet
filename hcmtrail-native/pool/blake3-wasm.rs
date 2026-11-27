// SPDX-License-Identifier: CC0-1.0
// Bridge to the pinned, dependency-free BLAKE3 reference implementation.
#![no_std]

pub struct Hash([u8; 32]);
impl Hash {
    pub fn as_bytes(&self) -> &[u8; 32] { &self.0 }
}
pub fn hash(input: &[u8]) -> Hash {
    let mut state = reference_impl::Hasher::new();
    state.update(input);
    let mut out = [0; 32];
    state.finalize(&mut out);
    Hash(out)
}
