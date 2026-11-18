use std::process::Command;
use serde::{Deserialize, Serialize};

/// ZK-SNARK prover using Circom + snarkjs (via Node.js bridge)
/// In production, replace with arkworks-native Rust prover.
pub struct ZkProver {
    wasm_path: String,
    zkey_path: String,
}

#[derive(Serialize, Deserialize)]
pub struct WithdrawalCircuitInput {
    pub root: String,
    pub nullifier_hash: String,
    pub recipient: String,
    pub relayer: String,
    pub fee: String,
    pub amount: String,
    // Private inputs:
    pub nullifier: String,
    pub secret: String,
    pub note_amount: String,
    pub path_elements: Vec<String>,
    pub path_indices: Vec<String>,
    pub commitment: String,
}

#[derive(Serialize, Deserialize)]
pub struct ZkProof {
    pub pi_a: [String; 2],
    pub pi_b: [[String; 2]; 2],
    pub pi_c: [String; 2],
    pub protocol: String,
    pub curve: String,
}

impl ZkProver {
    pub fn new(wasm_path: &str, zkey_path: &str) -> Self {
        Self {
            wasm_path: wasm_path.to_string(),
            zkey_path: zkey_path.to_string(),
        }
    }

    /// Generate ZK-SNARK proof for withdrawal
    pub fn prove_withdrawal(&self, input: &WithdrawalCircuitInput) -> anyhow::Result<(ZkProof, Vec<String>)> {
        // Write input to temp file
        let input_json = serde_json::to_string(input)?;
        let input_path = format!("/tmp/zk_input_{}.json", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?.as_nanos());
        std::fs::write(&input_path, &input_json)?;

        // Run snarkjs groth16 prove (requires node + snarkjs installed)
        let output = Command::new("npx")
            .args(["snarkjs", "groth16", "prove", &self.zkey_path, &input_path])
            .output()?;

        if !output.status.success() {
            return Err(anyhow::anyhow!("snarkjs prove failed: {}", String::from_utf8_lossy(&output.stderr)));
        }

        let proof_json = String::from_utf8_lossy(&output.stdout);
        let proof: serde_json::Value = serde_json::from_str(&proof_json)?;

        let proof_obj = ZkProof {
            pi_a: [proof["pi_a"][0].as_str().unwrap().to_string(), proof["pi_a"][1].as_str().unwrap().to_string()],
            pi_b: [
                [proof["pi_b"][0][0].as_str().unwrap().to_string(), proof["pi_b"][0][1].as_str().unwrap().to_string()],
                [proof["pi_b"][1][0].as_str().unwrap().to_string(), proof["pi_b"][1][1].as_str().unwrap().to_string()],
            ],
            pi_c: [proof["pi_c"][0].as_str().unwrap().to_string(), proof["pi_c"][1].as_str().unwrap().to_string()],
            protocol: proof["protocol"].as_str().unwrap_or("groth16").to_string(),
            curve: proof["curve"].as_str().unwrap_or("bn128").to_string(),
        };

        let public_signals: Vec<String> = proof["public_signals"]
            .as_array()
            .unwrap_or(&serde_json::Value::Null)
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_string())
            .collect();

        // Cleanup temp file
        let _ = std::fs::remove_file(&input_path);

        Ok((proof_obj, public_signals))
    }

    /// Verify ZK proof (client-side pre-check before sending to chain)
    pub fn verify_withdrawal(&self, proof: &ZkProof, public_signals: &[String]) -> anyhow::Result<bool> {
        // In production, use arkworks-native verifier or call snarkjs verify
        // For now, return true if proof is structurally valid
        Ok(!proof.pi_a[0].is_empty() && !proof.pi_b[0][0].is_empty() && !proof.pi_c[0].is_empty())
    }
}
