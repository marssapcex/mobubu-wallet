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
case "${1:-all}" in
  all) node --test --test-concurrency=1 test/native-swap.integration.mjs test/pool-devnet.integration.mjs ;;
  pool) node --test test/pool-devnet.integration.mjs ;;
  *) echo 'Usage: test-native-swap.sh [all|pool]' >&2; exit 2 ;;
esac
