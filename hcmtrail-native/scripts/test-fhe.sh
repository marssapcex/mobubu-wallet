#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
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
fft="$lib/fft_processors/nayuki"
"${CC:-cc}" -std=c99 -O3 -DNDEBUG -fwrapv -c "$fft/fft-x8664-avx-aux.c" -o "$work/fft-aux.o"
"${CC:-cc}" -std=c99 -O3 -DNDEBUG -fwrapv -c "$fft/fft-model-of-x8664-avx.c" -o "$work/fft-model.o"
"${CXX:-c++}" -std=c++11 -O2 -DNDEBUG -fwrapv -I"$work/source/src/include" -I"$root/lab" -I"$fft" \
  "$root/lab/tfhe_quote.cpp" "$lib"/*.cpp "$fft/fft_processor_nayuki.cpp" "$fft/lagrangehalfc_impl.cpp" \
  "$work/fft-aux.o" "$work/fft-model.o" -Wl,-z,noexecstack -lm -o "$work/lab-tfhe"
"$work/lab-tfhe"
