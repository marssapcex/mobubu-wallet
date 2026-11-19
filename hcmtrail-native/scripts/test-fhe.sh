#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
source="$root/lab/tfhe_quote.cpp"
if [[ $# == 1 && $1 == --trace ]]; then
  source="$root/lab/tfhe_trace.cpp"
elif [[ $# != 0 ]]; then
  echo 'Usage: test-fhe.sh [--trace]' >&2
  exit 2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'The TFHE experiment currently targets Linux x86-64.' >&2
  exit 1
fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
pin=9373b5d8a5b022ca5b4e112ae1c2440bc18e160c
sha=c0cbb3bad9d3303d7aafc9a2d98b5d59eb14f45e855c6213dc5cfa7367e96db4
curl --fail --silent --show-error --location --max-time 60 \
  "https://codeload.github.com/tfhe/tfhe/tar.gz/$pin" -o "$work/tfhe.tar.gz"
printf '%s  %s\n' "$sha" "$work/tfhe.tar.gz" | sha256sum -c --status
mkdir "$work/source"
tar -xzf "$work/tfhe.tar.gz" --strip-components=1 -C "$work/source"
patch -d "$work/source" -p1 --batch < "$root/lab/tfhe-os-rng.patch"
lib="$work/source/src/libtfhe"
arch=()
if [[ $# == 1 ]] && grep -qw avx2 /proc/cpuinfo && grep -qw fma /proc/cpuinfo; then
  # Use the pinned upstream fast FFT for the larger trace, only on an appropriate CPU.
  fft="$lib/fft_processors/spqlios"
  arch=(-mavx2 -mfma)
  fft_sources=("$fft/spqlios-fft-impl.cpp" "$fft/fft_processor_spqlios.cpp" "$fft/lagrangehalfc_impl.cpp"
    "$fft/spqlios-fft-fma.s" "$fft/spqlios-ifft-fma.s" "$fft/lagrangehalfc_impl_fma.s")
  echo 'TFHE trace backend: SPQLIOS FMA'
else
  fft="$lib/fft_processors/nayuki"
  "${CC:-cc}" -std=c99 -O3 -DNDEBUG -fwrapv -c "$fft/fft-x8664-avx-aux.c" -o "$work/fft-aux.o"
  "${CC:-cc}" -std=c99 -O3 -DNDEBUG -fwrapv -c "$fft/fft-model-of-x8664-avx.c" -o "$work/fft-model.o"
  fft_sources=("$fft/fft_processor_nayuki.cpp" "$fft/lagrangehalfc_impl.cpp" "$work/fft-aux.o" "$work/fft-model.o")
fi
"${CXX:-c++}" -std=c++11 -O2 -DNDEBUG -fwrapv "${arch[@]}" -I"$work/source/src/include" -I"$root/lab" -I"$fft" \
  "$source" "$lib"/*.cpp "${fft_sources[@]}" -Wl,-z,noexecstack -lm -o "$work/lab-tfhe"
if [[ $# == 1 ]]; then
  TFHE_TRACE_EVALUATOR="$work/lab-tfhe" node --test "$root/test/zama-tfhe-trace.test.mjs"
else
  "$work/lab-tfhe"
fi
