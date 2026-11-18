#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
cd "$ROOT"
if [[ -z "${MOBUBU_RUST_VERIFY_BIN:-}" ]]; then
  export CARGO_TARGET_DIR="$REPO/mobubu-wallet-rust/target"
  cargo test --manifest-path "$REPO/mobubu-wallet-rust/Cargo.toml" --locked
  cargo build --manifest-path "$REPO/mobubu-wallet-rust/Cargo.toml" --locked --release
  export MOBUBU_RUST_VERIFY_BIN="$CARGO_TARGET_DIR/release/mobubu-wallet"
fi
if [[ ! -x "$MOBUBU_RUST_VERIFY_BIN" ]]; then
  echo "Rust verifier executable not found: $MOBUBU_RUST_VERIFY_BIN" >&2
  exit 1
fi
npm test
