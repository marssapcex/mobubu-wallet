#!/usr/bin/env bash
set -euo pipefail
lab=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$lab/../.." && pwd)
build=${MOBUBU_LAZER_BUILD_DIR:-"$root/build/lazer-spend"}
mkdir -p -- "$build"
build=$(cd -- "$build" && pwd)

# This lab builds only the LaZer LaBRADOS backend, not the legacy LNP22
# library. The pinned C implementation uses x86 vector AES and AVX-512.
flags=$(sed -n '/^flags[[:space:]]*:/ { p; q; }' /proc/cpuinfo 2>/dev/null || true)
for flag in aes avx512f avx512bw avx512dq avx512vl avx512vbmi avx512_vnni vaes; do
  if [[ $(uname -m) != x86_64 || " $flags " != *" $flag "* ]]; then
    echo 'The LaZer spend lab requires Linux x86-64 with AVX-512 and VAES.' >&2
    exit 1
  fi
done

fetch() {
  local repo=$1 revision=$2 sum=$3 file="$build/$1-$2.tar.gz"
  if [[ ! -f $file ]]; then
    curl --fail --silent --show-error --location --retry 2 \
      "https://codeload.github.com/lazer-crypto/$repo/tar.gz/$revision" -o "$file.download"
    printf '%s  %s\n' "$sum" "$file.download" | sha256sum --check --status
    mv -- "$file.download" "$file"
  else
    printf '%s  %s\n' "$sum" "$file" | sha256sum --check --status
  fi
  printf '%s\n' "$file"
}

lazer=$(fetch lazer b958e247a2fdb9593b3c25c9603c6c5305c19420 \
  80ef7c83d27a985e78285a3325dc32dca0ff3fe768d7133c9a1cdfd03a5dbaf0)
labrador=$(fetch labrador c1ae0e612d5accd9e7d9d1c264951c1afe949c83 \
  8828eaedcfd1f2fbae780ee17b5a07ae23dc41fbee0b1c9124c85e87defbfeb9)

work=$(mktemp -d "$build/compile.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/source"
tar -xzf "$lazer" -C "$work/source" --strip-components=1
mkdir -p "$work/source/src/labrados"
tar -xzf "$labrador" -C "$work/source/src/labrados" --strip-components=1

# Generate the small coefficient table from the pinned case-study constants.
# Parse the data as a literal rather than executing the upstream Python file.
python3 "$lab/matrix.py" "$work/source/python/succinct_zkp/urand_matrix.py" > "$work/ajtai.h"
make -s -C "$work/source" -f Makefile -f "$lab/native.mk" mobubu-lazer \
  "LAB_DIR=$lab" "WORK_DIR=$work"
mv -f -- "$work/libmobubu_lazer.so" "$build/libmobubu_lazer.so"
printf 'Built lab only: %s/libmobubu_lazer.so\n' "$build"
