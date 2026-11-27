// SPDX-License-Identifier: AGPL-3.0-or-later
//! A single-threaded browser ABI for the pinned NON-OS NotBefore engine. The worker
//! is short-lived; it owns the WASM instance, all temporary memory and note secrets.

use nox_prover::{prove_keeping_cache, prove_with, to_json, to_shared, verify_shared, Options, ENTROPY_BYTES};
use std::fmt::Write;

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    if len == 0 || len > 16 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; len as usize].into_boxed_slice()) as *mut u8
}

// Only called by our worker, with live, non-overlapping regions of this instance's memory.
#[no_mangle]
pub unsafe extern "C" fn prove(input: *const u8, req_len: u32, seed_len: u32, cache_len: u32) -> u64 {
    let result = (|| -> Result<String, String> {
        let total = req_len as usize + seed_len as usize + ENTROPY_BYTES + cache_len as usize;
        if input.is_null() || total > 16 * 1024 * 1024 { return Err("Invalid prover input".into()); }
        let bytes = unsafe { std::slice::from_raw_parts(input, total) };
        let (request, rest) = bytes.split_at(req_len as usize);
        let (seed, rest) = rest.split_at(seed_len as usize);
        let (entropy, cache) = rest.split_at(ENTROPY_BYTES);
        let request = std::str::from_utf8(request).map_err(|e| e.to_string())?;
        let seed = std::str::from_utf8(seed).map_err(|e| e.to_string())?;
        let report = |phase: nox_prover::Phase, fraction: f32| unsafe { progress(phase as u32, fraction) };
        let supplied = (!cache.is_empty()).then_some(cache);
        let (p, created_cache) = if let Some(cache) = supplied {
            let (p, _) = prove_with(request, seed, entropy,
                &Options { cache: Some(cache), progress: Some(&report), cancel: None }).map_err(|e| e.to_string())?;
            (p, None)
        } else {
            let (p, cache) = prove_keeping_cache(request, seed, entropy).map_err(|e| e.to_string())?;
            (p, Some(cache))
        };
        let cache = supplied.or(created_cache.as_deref()).ok_or("Missing periodic parameters")?;
        let shared = to_shared(&p.bytes, &p.publics, cache).map_err(|e| e.to_string())?;
        verify_shared(&shared, &p.publics, cache).map_err(|e| e.to_string())?;
        let mut result = String::from("0x");
        for b in shared { write!(result, "{b:02x}").unwrap(); }
        result.push('\n');
        result.push_str(&to_json(&p)); // includes the two change openings, never sent to a server
        Ok(result)
    })();
    let bytes = result.unwrap_or_else(|_| "Prover refused this witness or ran out of resources.".into())
        .into_bytes().into_boxed_slice();
    let len = bytes.len() as u64;
    let at = Box::into_raw(bytes) as *mut u8 as u32;
    (len << 32) | u64::from(at)
}

#[link(wasm_import_module = "hcmtrail")]
extern "C" {
    fn progress(phase: u32, fraction: f32);
}
