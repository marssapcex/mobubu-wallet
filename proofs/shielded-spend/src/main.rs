#![no_main]

mod relation;
use risc0_zkvm::{guest::env, sha::{Impl, Sha256}};
risc0_zkvm::guest::entry!(main);

fn main() {
    // Witness is guest input only. Commit ONLY the public statement.
    let mut public = [0u8; relation::JOURNAL_LEN];
    let mut witness = [0u8; relation::WITNESS_LEN];
    env::read_slice(&mut public);
    env::read_slice(&mut witness);
    assert!(relation::verify(&public, &witness, |bytes| {
        Impl::hash_bytes(bytes).as_bytes().try_into().unwrap()
    }), "invalid shielded spend");
    env::commit_slice(&public);
}
