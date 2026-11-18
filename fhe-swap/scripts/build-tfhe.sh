#!/usr/bin/env bash
# Build the experimental Linux/x86-64 CGGI worker from pinned Apache-2.0 libtfhe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${TFHE_CACHE:-"$ROOT/../.cache/fhe"}"
PIN="9373b5d8a5b022ca5b4e112ae1c2440bc18e160c"
SHA256="c0cbb3bad9d3303d7aafc9a2d98b5d59eb14f45e855c6213dc5cfa7367e96db4"
CXX="${CXX:-g++}"
CC="${CC:-gcc}"
OUTPUT="${TFHE_OUTPUT:-"$ROOT/native/bin/tfhe_worker"}"
BACKEND="${TFHE_FFT:-auto}"

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "The CGGI worker build currently supports Linux x86-64 only." >&2
  exit 1
fi
if [[ "$BACKEND" == auto ]]; then
  BACKEND=nayuki-portable
  if grep -qm1 -E '^flags[[:space:]]*:.*\bavx2\b' /proc/cpuinfo && grep -qm1 -E '^flags[[:space:]]*:.*\bfma\b' /proc/cpuinfo; then
    BACKEND=spqlios-fma
  fi
fi
case "$BACKEND" in
  spqlios-fma) ARCH=(-mavx2 -mfma);;
  nayuki-portable) ARCH=();;
  *) echo "Unknown TFHE_FFT: $BACKEND" >&2; exit 1;;
esac

mkdir -p "$CACHE" "$(dirname "$OUTPUT")"
CACHE="$(cd "$CACHE" && pwd)"
WORK="$(mktemp -d "$CACHE/build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
archive="$CACHE/tfhe-$PIN.tar.gz"
check_archive() { printf '%s  %s\n' "$SHA256" "$1" | sha256sum -c --status; }
if ! check_archive "$archive" 2>/dev/null; then
  curl --fail --silent --show-error --location --max-time 60 \
    "https://codeload.github.com/tfhe/tfhe/tar.gz/$PIN" -o "$WORK/source.tar.gz"
  check_archive "$WORK/source.tar.gz" || { echo 'Pinned libtfhe checksum failed' >&2; exit 1; }
  mv "$WORK/source.tar.gz" "$archive"
fi
mkdir "$WORK/src" "$WORK/obj"
tar -xzf "$archive" --strip-components=1 -C "$WORK/src"
patch -d "$WORK/src" -p1 --batch < "$ROOT/native/tfhe-os-random.patch"
SRC="$WORK/src/src"
OBJ="$WORK/obj"
CXXFLAGS=(-std=gnu++11 -O2 -DNDEBUG -fwrapv "${ARCH[@]}" "-I$SRC/include" "-I$ROOT/native")

echo "Building CGGI worker: $PIN / $BACKEND / Linux getrandom"
for file in "$SRC"/libtfhe/*.cpp; do
  "$CXX" "${CXXFLAGS[@]}" -c "$file" -o "$OBJ/$(basename "${file%.cpp}").o"
done
if [[ "$BACKEND" == spqlios-fma ]]; then
  FFT="$SRC/libtfhe/fft_processors/spqlios"
  for file in spqlios-fft-impl fft_processor_spqlios lagrangehalfc_impl; do
    "$CXX" "${CXXFLAGS[@]}" -I"$FFT" -c "$FFT/$file.cpp" -o "$OBJ/$file.o"
  done
  for file in spqlios-fft-fma spqlios-ifft-fma lagrangehalfc_impl_fma; do
    "$CC" -c "$FFT/$file.s" -o "$OBJ/$file.o"
  done
else
  FFT="$SRC/libtfhe/fft_processors/nayuki"
  for file in fft-x8664-avx-aux fft-model-of-x8664-avx; do
    "$CC" -std=c99 -O3 -DNDEBUG -fwrapv -c "$FFT/$file.c" -o "$OBJ/$file.o"
  done
  for file in fft_processor_nayuki lagrangehalfc_impl; do
    "$CXX" "${CXXFLAGS[@]}" -I"$FFT" -c "$FFT/$file.cpp" -o "$OBJ/$file.o"
  done
fi
"$CXX" "${CXXFLAGS[@]}" "$ROOT/native/tfhe_worker.cpp" "$OBJ"/*.o -lm -Wl,-z,noexecstack -o "$WORK/tfhe_worker"
(cd "$WORK" && printf '1 PING\n2 KEYGEN 128 smoke.key\n3 MODE\n4 QUIT\n' | ./tfhe_worker > smoke.log)
grep -qx '1 OK PONG' "$WORK/smoke.log"
grep -q '^2 OK client 128 ' "$WORK/smoke.log"
grep -qx '3 OK client' "$WORK/smoke.log"
grep -qx '4 OK BYE' "$WORK/smoke.log"
# Publish only after a smoke test; never track the architecture-specific binary.
# Stage next to the final path so the last rename is atomic even with an external cache.
STAGED="$(mktemp "$(dirname "$OUTPUT")/.tfhe_worker.XXXXXX")"
trap 'rm -rf "$WORK"; rm -f "$STAGED"' EXIT
install -m 0755 "$WORK/tfhe_worker" "$STAGED"
mv "$STAGED" "$OUTPUT"
