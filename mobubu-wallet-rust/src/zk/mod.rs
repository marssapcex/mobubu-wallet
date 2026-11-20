//! Verify Groth16/BN254 over the exact four public inputs of `withdraw.circom`.
//! Only a verification key pinned to the intended circuit and ceremony is trusted.

use std::fmt;
use substrate_bn::{arith::U256, pairing_batch, AffineG1, AffineG2, Fq, Fq2, Fr, Gt, G1, G2};

pub const STATEMENT_BYTES: usize = 4 * 32;
pub const PROOF_BYTES: usize = 8 * 32;
pub const KEY_BYTES: usize = 24 * 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    Length,
    NonCanonicalField,
    InvalidPoint,
    InvalidStatement,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Length => "invalid encoded length",
            Self::NonCanonicalField => "non-canonical BN254 field element",
            Self::InvalidPoint => "invalid affine BN254 point",
            Self::InvalidStatement => "invalid vault statement",
        })
    }
}

impl std::error::Error for DecodeError {}

struct Words<'a>(std::slice::ChunksExact<'a, u8>);

impl<'a> Words<'a> {
    fn new(bytes: &'a [u8], expected: usize) -> Result<Self, DecodeError> {
        if bytes.len() != expected {
            return Err(DecodeError::Length);
        }
        Ok(Self(bytes.chunks_exact(32)))
    }

    fn next(&mut self) -> Result<&'a [u8], DecodeError> {
        self.0.next().ok_or(DecodeError::Length)
    }

    fn fq(&mut self) -> Result<Fq, DecodeError> {
        Fq::from_slice(self.next()?).map_err(|_| DecodeError::NonCanonicalField)
    }

    fn fr(&mut self) -> Result<Fr, DecodeError> {
        scalar(self.next()?)
    }

    fn g1(&mut self) -> Result<G1, DecodeError> {
        AffineG1::new(self.fq()?, self.fq()?)
            .map(G1::from)
            .map_err(|_| DecodeError::InvalidPoint)
    }

    fn g2(&mut self) -> Result<G2, DecodeError> {
        // snarkjs representation: Fq2.real then Fq2.imag. The Solidity EIP-197
        // representation reverses these two coefficients. Do not mix the two.
        let x = Fq2::new(self.fq()?, self.fq()?);
        let y = Fq2::new(self.fq()?, self.fq()?);
        // AffineG2::new validates both the curve equation and subgroup order.
        AffineG2::new(x, y)
            .map(G2::from)
            .map_err(|_| DecodeError::InvalidPoint)
    }
}

fn scalar(bytes: &[u8]) -> Result<Fr, DecodeError> {
    // Fr::from_slice in substrate-bn reduces modulo r. Verification requires
    // *canonical* public signals instead, matching the on-chain verifier.
    let integer = U256::from_slice(bytes).map_err(|_| DecodeError::Length)?;
    Fr::new(integer).ok_or(DecodeError::NonCanonicalField)
}

/// Expected public inputs supplied separately by the caller, in circuit order.
/// This does not determine whether a root is current or a note is unspent.
pub struct Statement([Fr; 4]);

impl Statement {
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut words = Words::new(bytes, STATEMENT_BYTES)?;
        let root = words.fr()?;
        let nullifier = words.fr()?;
        let address_bytes = words.next()?;
        let recipient = scalar(address_bytes)?;
        let domain = words.fr()?;
        if root.is_zero()
            || nullifier.is_zero()
            || recipient.is_zero()
            || address_bytes[..12].iter().any(|byte| *byte != 0)
        {
            return Err(DecodeError::InvalidStatement);
        }
        Ok(Self([root, nullifier, recipient, domain]))
    }
}

pub struct Proof {
    a: G1,
    b: G2,
    c: G1,
}

impl Proof {
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut words = Words::new(bytes, PROOF_BYTES)?;
        Ok(Self {
            a: words.g1()?,
            b: words.g2()?,
            c: words.g1()?,
        })
    }
}

/// Fixed-shape Groth16 verification key (alpha, beta, gamma, delta, and 5 ICs).
pub struct VerificationKey {
    alpha: G1,
    beta: G2,
    gamma: G2,
    delta: G2,
    ic: [G1; 5],
}

impl VerificationKey {
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut words = Words::new(bytes, KEY_BYTES)?;
        Ok(Self {
            alpha: words.g1()?,
            beta: words.g2()?,
            gamma: words.g2()?,
            delta: words.g2()?,
            ic: [
                words.g1()?,
                words.g1()?,
                words.g1()?,
                words.g1()?,
                words.g1()?,
            ],
        })
    }

    /// e(-A, B) × e(IC[0] + Σ(IC[i+1] · s[i]), γ) × e(C, δ) × e(α, β) == 1.
    /// Uses substrate-bn's batched Miller loop/final exponentiation.
    pub fn verify(&self, proof: &Proof, expected: &Statement) -> bool {
        let linear = self.ic[1..]
            .iter()
            .zip(expected.0)
            .fold(self.ic[0], |acc, (point, input)| acc + *point * input);
        pairing_batch(&[
            (-proof.a, proof.b),
            (linear, self.gamma),
            (proof.c, self.delta),
            (self.alpha, self.beta),
        ]) == Gt::one()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_noncanonical_formats() {
        assert_eq!(
            Proof::decode(&[0; PROOF_BYTES - 1]).err(),
            Some(DecodeError::Length)
        );
        assert_eq!(
            Proof::decode(&[0; PROOF_BYTES]).err(),
            Some(DecodeError::InvalidPoint)
        );
        assert_eq!(
            Proof::decode(&[255; PROOF_BYTES]).err(),
            Some(DecodeError::NonCanonicalField)
        );
        assert_eq!(
            VerificationKey::decode(&[0; KEY_BYTES + 1]).err(),
            Some(DecodeError::Length)
        );
        assert_eq!(
            Statement::decode(&[0; STATEMENT_BYTES]).err(),
            Some(DecodeError::InvalidStatement)
        );
    }

    #[test]
    fn statement_is_separate_and_validated() {
        let mut statement = [0; STATEMENT_BYTES];
        statement[31] = 1;
        statement[63] = 2;
        statement[95] = 3;
        statement[127] = 4;
        assert!(Statement::decode(&statement).is_ok());
        statement[64] = 1; // > 160 bits, but less than the scalar field.
        assert_eq!(
            Statement::decode(&statement).err(),
            Some(DecodeError::InvalidStatement)
        );
        statement[32] = 255;
        assert_eq!(
            Statement::decode(&statement).err(),
            Some(DecodeError::NonCanonicalField)
        );
    }
}
