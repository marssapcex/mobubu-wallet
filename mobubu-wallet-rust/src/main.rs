use mobubu_wallet::zk::{
    Proof, Statement, VerificationKey, KEY_BYTES, PROOF_BYTES, STATEMENT_BYTES,
};
use std::error::Error;
use std::ffi::OsStr;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::process::ExitCode;

fn validate_file<const N: usize>(metadata: Metadata) -> io::Result<()> {
    if !metadata.is_file() || metadata.len() != N as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("expected a regular file of exactly {N} bytes"),
        ));
    }
    Ok(())
}

fn read_exact_file<const N: usize>(path: &OsStr) -> io::Result<[u8; N]> {
    // Paths are local/trusted; check before open to avoid blocking on a FIFO.
    validate_file::<N>(fs::metadata(path)?)?;
    let mut file = File::open(path)?;
    validate_file::<N>(file.metadata()?)?;
    let mut bytes = [0; N];
    file.read_exact(&mut bytes)?;
    if file.read(&mut [0])? != 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "trailing bytes"));
    }
    Ok(bytes)
}

fn verify() -> Result<bool, Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let (Some(cmd), Some(key), Some(proof), Some(expected), None) = (
        args.next(),
        args.next(),
        args.next(),
        args.next(),
        args.next(),
    ) else {
        return Err("usage: mobubu-wallet verify <trusted-key.bin> <proof.bin> <expected-public-inputs.bin>".into());
    };
    if cmd != "verify" {
        return Err("unsupported command; expected 'verify'".into());
    }
    let key = VerificationKey::decode(&read_exact_file::<KEY_BYTES>(&key)?)?;
    let proof = Proof::decode(&read_exact_file::<PROOF_BYTES>(&proof)?)?;
    let expected = Statement::decode(&read_exact_file::<STATEMENT_BYTES>(&expected)?)?;
    Ok(key.verify(&proof, &expected))
}

fn main() -> ExitCode {
    match verify() {
        Ok(true) => {
            println!("valid");
            ExitCode::SUCCESS
        }
        Ok(false) => {
            eprintln!("invalid proof for expected public inputs");
            ExitCode::from(1)
        }
        Err(error) => {
            eprintln!("verification error: {error}");
            ExitCode::from(2)
        }
    }
}
