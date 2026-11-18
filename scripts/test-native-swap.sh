#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${BITCOIND:?Set BITCOIND to a local Bitcoin Core daemon executable (v28+). No public nodes or real funds.}"
test -x "$BITCOIND"
npm --prefix fhe-swap run build
if [[ -z "${TFHE_WORKER:-}" ]]; then
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  export TFHE_WORKER="$dir/tfhe_worker"
  TFHE_OUTPUT="$TFHE_WORKER" npm --prefix fhe-swap run build:native
else
  test -x "$TFHE_WORKER"
fi
node --test test/native-swap.integration.mjs
