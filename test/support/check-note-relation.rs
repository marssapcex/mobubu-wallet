// Native parity harness only; it receives the witness and DOES NOT prove zero knowledge.
// SPDX-License-Identifier: ISC
#[path = "../../proofs/shielded-spend/src/relation.rs"]
mod relation;
use std::io::{self, Read};

#[link(name = "libcrypto.so.3", kind = "dylib", modifiers = "+verbatim")]
extern "C" {
    fn SHA256(input: *const u8, len: usize, out: *mut u8) -> *mut u8;
}

fn sha256(input: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // Input and output are live non-overlapping slices of the required sizes.
    assert!(!unsafe { SHA256(input.as_ptr(), input.len(), out.as_mut_ptr()) }.is_null());
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut public = [0u8; relation::JOURNAL_LEN];
    let mut witness = [0u8; relation::WITNESS_LEN];
    let mut input = io::stdin().lock();
    input.read_exact(&mut public)?;
    input.read_exact(&mut witness)?;
    let mut extra = [0u8];
    if input.read(&mut extra)? != 0 || !relation::verify(&public, &witness, sha256) {
        std::process::exit(1);
    }
    Ok(())
}
