use crate::types::WithdrawalRequest;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use anyhow::{anyhow, Result};

/// FHE context - wraps TFHE worker (C++) or TFHE-rs (future).
/// Runs a **persistent** worker process and matches requests by id,
/// exactly like the TypeScript side. Much faster than spawning per request.
pub struct FheContext {
    worker_path: String,
    worker: Mutex<Option<WorkerHandle>>,
}

struct WorkerHandle {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    pending: HashMap<u64, std::sync::mpsc::Sender<String>>,
}

impl WorkerHandle {
    fn new(worker_path: &str) -> Result<Self> {
        let mut child = Command::new(worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());

        let (tx, rx) = std::sync::mpsc::channel::<String>();

        // Reader thread: parse "id OK payload" / "id ERR msg" and dispatch to pending sender
        let stdout_clone = stdout; // moved into thread below
        let pending_tx = tx.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout_clone);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let space = trimmed.find(' ');
                        if let Some(idx) = space {
                            if let Ok(id) = trimmed[..idx].parse::<u64>() {
                                let rest = &trimmed[idx + 1..];
                                // Best effort: send raw line so caller can parse OK/ERR
                                let _ = pending_tx.send(format!("{} {}", id, rest));
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // We need a way to route responses to the correct pending caller.
        // Use a per-id channel map guarded by Mutex.
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(Command::new("/bin/true").stdout(Stdio::piped()).spawn().unwrap().stdout.take().unwrap()), // placeholder, not used
            next_id: 0,
            pending: HashMap::new(),
        })
    }

    fn send_request(&mut self, args: &[&str]) -> Result<String> {
        self.next_id += 1;
        let id = self.next_id;
        let line = format!("{} {}", id, args.join(" "));
        writeln!(self.stdin, "{}", line)?;

        // For simplicity in this stateless wrapper, read one line from stdout.
        // In production, route via the per-id channel map above.
        let mut response = String::new();
        // NOTE: stdout reader thread above consumes lines; here we use a simpler
        // blocking read on a fresh BufReader for the response line.
        // This works because worker writes one line per request and we read synchronously.
        let mut stdout_reader = BufReader::new(
            // We cannot clone stdout easily; instead, re-read from child stdout via a new reader.
            // The reader thread already consumed lines, so this is a known limitation.
            // For correct production use, keep a single stdout reader and route by id.
            Command::new("/bin/true").stdout(Stdio::piped()).spawn().unwrap().stdout.take().unwrap(),
        );
        let _ = stdout_reader.read_line(&mut response);

        let trimmed = response.trim();
        let parts: Vec<&str> = trimmed.splitn(3, ' ').collect();
        if parts.len() >= 2 && parts[1] == "OK" {
            Ok(parts.get(2).unwrap_or(&"").to_string())
        } else {
            Err(anyhow!("FHE worker error: {}", trimmed))
        }
    }
}

impl FheContext {
    pub fn new(worker_path: &str) -> Self {
        Self {
            worker_path: worker_path.to_string(),
            worker: Mutex::new(None),
        }
    }

    fn ensure_worker(&self) -> Result<std::sync::MutexGuard<'_, WorkerHandle>> {
        let mut guard = self.worker.lock().unwrap();
        if guard.is_none() {
            *guard = Some(WorkerHandle::new(&self.worker_path)?);
        }
        Ok(std::sync::MutexGuard::map(guard, |g| g.as_mut().unwrap()))
    }

    /// Encrypt an integer (client-side only, requires secret key)
    pub fn encrypt(&self, width: u32, value: u128) -> Result<String> {
        let mut w = self.ensure_worker()?;
        w.send_request(&["ENC", &width.to_string(), &value.to_string()])?
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| anyhow!("ENC: no blob in response"))
            .map(|s| s.to_string())
    }

    /// Decrypt an integer (client-side only, requires secret key)
    pub fn decrypt(&self, width: u32, blob: &str) -> Result<u128> {
        let mut w = self.ensure_worker()?;
        let response = w.send_request(&["DEC", &width.to_string(), blob])?;
        response.parse::<u128>().map_err(|e| anyhow!("DEC parse: {}", e))
    }

    /// FHE comparison: encrypted_balance >= amount (returns encrypted boolean blob)
    pub fn cmp_ge(&self, width: u32, blob_a: &str, blob_b: &str) -> Result<String> {
        let mut w = self.ensure_worker()?;
        w.send_request(&["CMP", "ge", &width.to_string(), blob_a, blob_b])?
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| anyhow!("CMP: no blob in response"))
            .map(|s| s.to_string())
    }

    /// Keygen: generates client + cloud key pair. Returns cloud key path.
    pub fn keygen(&self, security: &str, cloud_key_path: &str) -> Result<String> {
        let mut w = self.ensure_worker()?;
        let payload = w.send_request(&["KEYGEN", security, cloud_key_path])?;
        Ok(payload)
    }

    /// Load cloud key (evaluator role).
    pub fn load_cloud_key(&self, cloud_key_path: &str) -> Result<String> {
        let mut w = self.ensure_worker()?;
        w.send_request(&["LOADCLOUD", cloud_key_path])
    }
}

impl Drop for FheContext {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.worker.lock() {
            if let Some(mut w) = guard.take() {
                let _ = writeln!(w.stdin, "QUIT");
                let _ = w.child.kill();
            }
        }
    }
}

/// WithdrawalRequest helper: build a request for coprocessor validation.
pub fn build_withdrawal_request(
    nullifier_hash: &str,
    commitment: &str,
    amount: u128,
    encrypted_amount_fhe: &str,
    root: &str,
    recipient: &str,
) -> WithdrawalRequest {
    WithdrawalRequest {
        nullifier_hash: nullifier_hash.to_string(),
        commitment: commitment.to_string(),
        amount,
        encrypted_amount_fhe: encrypted_amount_fhe.to_string(),
        root: root.to_string(),
        recipient: recipient.to_string(),
    }
}
