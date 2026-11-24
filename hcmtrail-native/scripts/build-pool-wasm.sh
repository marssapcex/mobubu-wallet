#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 && $1 == --legacy-devnet ]] || {
  echo 'ETH pool prover release blocked. For test ETH only, use build:pool:legacy:wasm.' >&2
  exit 1
}

# Browser wrapper around the pinned NotBefore engine. The vault only checks
# this legacy AIR and format 7 proof in the ETH lab.
nonos=a47d23ae969e23b5f841e30b49a1d483a80a6b02
blake=f3149ec5bb5449af877ba20377a11008ff499fa2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
out="$root/build/eth-pool"
rustc=$(command -v "${RUSTC:-rustc}")
[[ $("$rustc" --version) == 'rustc 1.88.0 (6b00bc388 2025-06-23)' ]] || { echo 'Use Rust 1.88.0 with the wasm32-unknown-unknown target.' >&2; exit 1; }
unset RUSTC_BOOTSTRAP
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
source_at() {
  git init -q "$1"
  git -C "$1" fetch -q --depth=1 "$2" "$3"
  git -C "$1" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
  [[ $(git -C "$1" rev-parse HEAD) == "$3" ]]
}
source_at src https://github.com/NON-OS/STARKs.git "$nonos"
source_at blake3 https://github.com/BLAKE3-team/BLAKE3.git "$blake"
compile() { "$rustc" --target wasm32-unknown-unknown -C opt-level=3 -C panic=abort --remap-path-prefix "$work=/src" -L dependency="$work" "$@"; }
features=(--cfg 'feature="fri8"' --cfg 'feature="radix8"' --cfg 'feature="digest32"')
compile --edition=2021 --crate-type rlib --crate-name reference_impl blake3/reference_impl/reference_impl.rs
compile --edition=2021 --crate-type rlib --crate-name blake3 --extern reference_impl=libreference_impl.rlib "$root/pool/blake3-wasm.rs"
compile --edition=2021 --crate-type rlib --crate-name nonos_stark "${features[@]}" \
  --extern blake3=libblake3.rlib src/nonos-stark/src/lib.rs
CARGO_MANIFEST_DIR="$work/src/stark_proofs" compile --edition=2021 --crate-type rlib --crate-name stark_proofs \
  "${features[@]}" --cfg 'feature="std"' --cfg 'feature="not_before"' --extern nonos_stark=libnonos_stark.rlib src/stark_proofs/src/lib.rs
CARGO_MANIFEST_DIR="$work/src/nox_prover" compile --edition=2021 --crate-type rlib --crate-name nox_prover \
  "${features[@]}" --cfg 'feature="not_before"' --extern stark_proofs=libstark_proofs.rlib src/nox_prover/src/lib.rs
compile --edition=2021 --crate-type cdylib --crate-name pool_prover --extern nox_prover=libnox_prover.rlib \
  -C strip=debuginfo "$root/pool/prover-wasm.rs" -o prover.wasm

# Ship corresponding source with the browser binary. Layout matches the build script.
mkdir -p source/pool source/scripts
cp "$root/pool/"{blake3-wasm.rs,prover-wasm.rs} source/pool/
cp "$root/scripts/build-pool-wasm.sh" source/scripts/
git -C src archive --prefix=nonos-starks/ HEAD | tar -xf - -C source
git -C blake3 archive --prefix=blake3/ HEAD reference_impl LICENSE_A2 LICENSE_A2LLVM LICENSE_CC0 | tar -xf - -C source
tar -czf prover-source.tar.gz -C source .
mkdir -p "$out"
install -m 0644 prover.wasm prover-source.tar.gz "$out/"
sha256sum "$out/prover.wasm"
