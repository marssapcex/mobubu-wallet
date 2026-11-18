# Archived prototype — do not build or use for custody

This directory preserves the old Rust node sketch (chain watchers, FHE stubs,
proof-shape verification, validator approvals and in-memory vault/yield/RWA).
None of it is compiled or exposed by the active package. It neither implements
an EIP-7702 transaction nor provides valid ZK, FHE or threshold authorization.
The active native verifier lives under `src/zk/` and only verifies public proof
statements offline.
