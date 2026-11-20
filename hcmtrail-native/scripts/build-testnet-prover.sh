#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${1:?Usage: RUSTC=/path/to/rustc-1.88.0 bash scripts/build-testnet-prover.sh /new/local/prover-dir}"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'This build targets Linux x86-64.' >&2; exit 1; }
# Audit recipe: unmodified NON-OS proving code, exact Rust revision, BLAKE3 C at the upstream lockfile version.
nonos=a47d23ae969e23b5f841e30b49a1d483a80a6b02
blake=f3149ec5bb5449af877ba20377a11008ff499fa2
rustc=$(command -v "${RUSTC:-rustc}")
version=$("$rustc" --version)
[[ $version == 'rustc 1.88.0 (6b00bc388 2025-06-23)' ]] || { echo 'Need Rust 1.88.0 (see docs/TESTNET.md).' >&2; exit 1; }
unset RUSTC_BOOTSTRAP
out=$(realpath -m -- "$1")
[[ ! -e $out ]] || { echo 'Choose a new prover install directory.' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
source_at() {
  git init -q "$1"
  git -C "$1" -c advice.detachedHead=false fetch --quiet --depth=1 "$2" "$3"
  git -C "$1" checkout -q --detach FETCH_HEAD
  [[ $(git -C "$1" rev-parse HEAD) == "$3" ]]
}
source_at src https://github.com/NON-OS/STARKs.git "$nonos"
source_at blake3 https://github.com/BLAKE3-team/BLAKE3.git "$blake"

# Small FFI shim for the only BLAKE3 interface that nonos-stark uses. No circuit or verifier edits.
cat >hash.c <<'C'
#include "blake3.h"
void native_blake3(const uint8_t *input, size_t len, uint8_t *out) {
    blake3_hasher h;
    blake3_hasher_init(&h);
    blake3_hasher_update(&h, input, len);
    blake3_hasher_finalize(&h, out, 32);
}
C
cc -std=c11 -O3 -Iblake3/c -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 \
  -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0 \
  -c hash.c blake3/c/{blake3,blake3_dispatch,blake3_portable}.c
ar rcs libnative_blake.a hash.o blake3.o blake3_dispatch.o blake3_portable.o
cat >blake3.rs <<'RS'
#![no_std]
#[link(name = "native_blake", kind = "static")]
unsafe extern "C" { fn native_blake3(input: *const u8, len: usize, out: *mut u8); }
pub struct Hash([u8; 32]);
impl Hash { pub fn as_bytes(&self) -> &[u8; 32] { &self.0 } }
pub fn hash(input: &[u8]) -> Hash {
    let mut out = [0; 32];
    unsafe { native_blake3(input.as_ptr(), input.len(), out.as_mut_ptr()) };
    Hash(out)
}
RS
compile() { "$rustc" --edition=2021 -O --remap-path-prefix "$work=/src" -L dependency="$work" "$@"; }
features=(--cfg 'feature="fri8"' --cfg 'feature="radix8"' --cfg 'feature="digest32"')
compile --crate-name blake3 --crate-type rlib -L native="$work" blake3.rs
echo 'Building pinned NON-OS STARK engine'
compile --crate-name nonos_stark --crate-type rlib "${features[@]}" \
  --extern blake3=libblake3.rlib src/nonos-stark/src/lib.rs
echo 'Building NotBefore statement and proof tools'
CARGO_MANIFEST_DIR="$work/src/stark_proofs" compile --crate-name stark_proofs --crate-type rlib \
  "${features[@]}" --cfg 'feature="std"' --cfg 'feature="not_before"' \
  --extern nonos_stark=libnonos_stark.rlib src/stark_proofs/src/lib.rs
CARGO_MANIFEST_DIR="$work/src/nox_prover" compile --crate-name nox_prover --crate-type rlib \
  "${features[@]}" --cfg 'feature="not_before"' --extern stark_proofs=libstark_proofs.rlib src/nox_prover/src/lib.rs
for bin in nox_bench nox_share; do
  compile --extern nox_prover=libnox_prover.rlib "src/nox_prover/src/bin/$bin.rs" -o "$bin"
done
mkdir -m 700 -- "$out"
install -m 0700 nox_bench nox_share "$out/"
install -m 0600 src/LICENSE "$out/LICENSE.NONOS"
install -m 0600 blake3/LICENSE_A2 blake3/LICENSE_A2LLVM blake3/LICENSE_CC0 "$out/"
cat >"$out/prover.json" <<EOF
{
  "source": "$nonos",
  "blake3": "$blake",
  "rust": "$version",
  "nox_bench": "$(sha256sum nox_bench | cut -d' ' -f1)",
  "nox_share": "$(sha256sum nox_share | cut -d' ' -f1)"
}
EOF
printf 'Set NATIVE_STARK_PROVER_DIR=%s\n' "$out"
