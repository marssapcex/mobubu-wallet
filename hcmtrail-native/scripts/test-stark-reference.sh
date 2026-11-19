#!/usr/bin/env bash
# Replays the pinned upstream verifier fixture. It cannot authorize a hcmtrail spend.
set -euo pipefail
: "${STARK_REFERENCE:?Set STARK_REFERENCE to the pinned NON-OS/L1-Shield checkout (see docs/REFERENCES.md)}"
: "${SOLC_EVM:?Set SOLC_EVM to native Solidity 0.8.24 (see docs/REFERENCES.md)}"
ref=$(realpath "$STARK_REFERENCE")
solc=$(realpath "$SOLC_EVM")
forge=$(command -v "${FORGE:-forge}")
forge=$(realpath "$forge")
commit=9d17ad969812ed953143e5d832816a3e20dc7834
if [[ $(git -C "$ref" rev-parse HEAD) != "$commit" ]] || [[ -n $(git -C "$ref" status --porcelain=v1) ]]; then
  echo 'Use a clean checkout of the pinned STARK reference, outside the application tree.' >&2
  exit 1
fi
submodules=$(git -C "$ref" submodule status --recursive)
if [[ -z "$submodules" ]] || grep -qE '^[-+U]' <<<"$submodules"; then
  echo 'Initialize the pinned upstream submodules: git submodule update --init --recursive --depth 1' >&2
  exit 1
fi
printf '%s  %s\n' fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f "$solc" | sha256sum -c --status
cd "$ref"
FOUNDRY_FFI=false "$forge" test --use "$solc" --offline --match-path test/shield/NotBeforeVerifier.t.sol -vv
