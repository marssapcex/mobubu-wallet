use crate::types::WithdrawalRequest;
use std::process::{Command, Stdio};
use std::io::{Write, Read, BufReader};

/// FHE context - wraps TFHE worker (C++) or TFHE-rs (future).
/// Currently spawns the C++ worker binary and communicates via stdin/stdout protocol.
pub struct FheContext {
    worker_path: String,
}

impl FheContext {
    pub fn new(worker_path: &str) -> Self {
        Self {
            worker_path: worker_path.to_string(),
        }
    }

    /// Encrypt an integer (client-side only, requires secret key)
    pub fn encrypt(&self, width: u32, value: u128) -> anyhow::Result<String> {
        self.send_request(&["ENC", &width.to_string(), &value.to_string()])?
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| anyhow::anyhow!("ENC: no blob in response"))
            .map(|s| s.to_string())
    }

    /// Decrypt an integer (client-side only, requires secret key)
    pub fn decrypt(&self, width: u32, blob: &str) -> anyhow::Result<u128> {
        let response = self.send_request(&["DEC", &width.to_string(), blob])?;
        response.parse::<u128>().map_err(|e| anyhow::anyhow!("DEC parse: {}", e))
    }

    /// FHE comparison: encrypted_balance >= amount (returns encrypted boolean blob)
    pub fn cmp_ge(&self, width: u32, blob_a: &str, blob_b: &str) -> anyhow::Result<String> {
        self.send_request(&["CMP", "ge", &width.to_string(), blob_a, blob_b])?
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| anyhow::anyhow!("CMP: no blob in response"))
            .map(|s| s.to_string())
    }

    /// Raw request to worker process (id-matched newline protocol)
    fn send_request(&self, args: &[&str]) -> anyhow::Result<String> {
        // Spawn worker for each request (simple, stateless)
        // In production, keep a persistent worker process with id-matching
        let mut child = Command::new(&self.worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.as_mut().unwrap();
        let request_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let line = format!("{} {}", request_id, args.join(" "));
        writeln!(stdin, "{}", line)?;

        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut response = String::new();
        reader.read_line(&mut response)?;

        let _ = child.wait();

        // Parse "id OK payload" or "id ERR msg"
        let parts: Vec<&str> = response.trim().splitn(3, ' ').collect();
        if parts.len() >= 2 && parts[1] == "OK" {
            Ok(parts.get(2).unwrap_or(&"").to_string())
        } else {
            Err(anyhow::anyhow!("FHE worker error: {}", response))
        }
    }
}
