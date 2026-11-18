//! Offline proof experiment. stdin is never logged; no remote prover.
//! The receipt format is for the native verifier, not EVM calldata.
use anyhow::{bail, ensure, Context, Result};
use bincode::Options;
use risc0_zkvm::{sha::Digest, ExecutorEnv, InnerReceipt, LocalProver, Prover, ProverOpts, Receipt, VerifierContext};
use std::io::{Read, Write};

include!(concat!(env!("OUT_DIR"), "/methods.rs"));
const JOURNAL: usize = 224;
const WITNESS: usize = 724;
const MAX_RECEIPT: u64 = 4 * 1024 * 1024;

fn codec() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_RECEIPT)
        .reject_trailing_bytes()
}

fn input(limit: u64) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    std::io::stdin().lock().take(limit + 1).read_to_end(&mut data)?;
    ensure!(data.len() as u64 <= limit, "oversized input");
    Ok(data)
}

fn checked(receipt: &Receipt, journal: &[u8]) -> Result<()> {
    ensure!(journal.len() == JOURNAL, "invalid journal length");
    ensure!(matches!(&receipt.inner, InnerReceipt::Composite(proof) if proof.assumption_receipts.is_empty()),
        "expected transparent STARK segments without assumptions");
    ensure!(receipt.journal.bytes == journal, "receipt did not bind the requested journal");
    receipt.verify_with_context(&VerifierContext::default().with_dev_mode(false), MOBUBU_SHIELDED_SPEND_GUEST_ID)
        .context("shielded spend receipt rejected")
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|s| s.to_str()) {
        Some("image-id") if args.len() == 1 => {
            println!("{}", Digest::from(MOBUBU_SHIELDED_SPEND_GUEST_ID));
        }
        Some("prove") if args.len() == 1 => {
            let mut private = input((JOURNAL + WITNESS) as u64)?;
            ensure!(private.len() == JOURNAL + WITNESS, "expected 224-byte journal + 724-byte witness on stdin");
            let (journal, witness) = private.split_at(JOURNAL);
            let env = ExecutorEnv::builder().write_slice(journal).write_slice(witness).build()?;
            let receipt = LocalProver::new("mobubu-local")
                .prove_with_ctx(env, &VerifierContext::default().with_dev_mode(false), MOBUBU_SHIELDED_SPEND_GUEST_ELF,
                    &ProverOpts::composite().with_dev_mode(false))?
                .receipt;
            checked(&receipt, journal)?;
            private.fill(0);
            std::io::stdout().lock().write_all(&codec().serialize(&receipt)?)?;
        }
        Some("verify") if args.len() == 2 => {
            // The journal is public, and derives from the SAME terms as the vault.
            let mut journal = Vec::new();
            std::fs::File::open(&args[1])?.take(JOURNAL as u64 + 1).read_to_end(&mut journal)?;
            ensure!(journal.len() == JOURNAL, "invalid journal length");
            let receipt: Receipt = codec().deserialize(&input(MAX_RECEIPT)?)?;
            checked(&receipt, &journal)?;
        }
        _ => bail!("usage: mobubu-shielded-spend-local image-id | prove < private-input | verify JOURNAL < receipt"),
    }
    Ok(())
}

fn main() {
    if run().is_err() {
        // Do not print attacker-controlled bytes, execution traces or openings.
        eprintln!("Local STARK operation failed. Check command, toolchain, and input formats.");
        std::process::exit(1);
    }
}
