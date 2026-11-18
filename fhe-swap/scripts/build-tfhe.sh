#!/usr/bin/env bash
# Build the TFHE (CGGI) homomorphic computation worker.
#
# Upstream library: https://github.com/tfhe/tfhe  (Apache-2.0)
# Paper: Chillotti, Gama, Georgieva, Izabachene, "TFHE: Fast Fully Homomorphic
#        Encryption over the Torus" (https://eprint.iacr.org/2018/421)
#
# Worker glue: fhe-swap/native/tfhe_worker.cpp (this project, MIT).
#
# No cmake is required: the upstream sources compile directly with g++.
# The SPQLIOS-FMA FFT backend is preferred (AVX2+FMA); falls back to the
# nayuki-portable backend otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${TFHE_CACHE:-"$ROOT/../.cache/fhe"}"
UPSTREAM="$CACHE/tfhe-lib"
PIN="9373b5d8a5b022ca5b4e112ae1c2440bc18e160c"
OBJ="$CACHE/obj-fma"
BIN="$ROOT/native/bin"
WORKER="$ROOT/native/tfhe_worker.cpp"
LIB="$OBJ/libtfhe.a"

mkdir -p "$CACHE" "$OBJ" "$BIN"

# --- Build TFHE from source if a usable archive is not already present ---
build_tfhe() {
  if [ ! -d "$UPSTREAM/.git" ]; then
    echo "== clone tfhe/tfhe"
    git clone https://github.com/tfhe/tfhe.git "$UPSTREAM"
  fi
  git -C "$UPSTREAM" fetch --depth 1 origin "$PIN" >/dev/null 2>&1 || \
    git -C "$UPSTREAM" fetch origin >/dev/null 2>&1 || true
  git -C "$UPSTREAM" checkout -q "$PIN" 2>/dev/null || \
    echo "WARN: using $(git -C "$UPSTREAM" rev-parse HEAD) (pin $PIN unavailable)" >&2
  echo "== tfhe upstream: $(git -C "$UPSTREAM" rev-parse HEAD)"

  CXX="${CXX:-g++}"
  CC="${CC:-gcc}"
  ARCH_FLAGS="${TFHE_ARCH_FLAGS:--march=native}"
  CXXFLAGS="-std=gnu++11 -O2 -DNDEBUG $ARCH_FLAGS -funroll-loops -fPIC"
  CFLAGS="-std=c99 -O3 -DNDEBUG $ARCH_FLAGS -fPIC"
  INC="-I$UPSTREAM/src/include"

  echo "== compile TFHE core ($UPSTREAM/src/libtfhe/*.cpp)"
  for f in "$UPSTREAM"/src/libtfhe/*.cpp; do
    o="$OBJ/$(basename "${f%.cpp}").o"
    if [ ! -f "$o" ] || [ "$f" -nt "$o" ]; then
      $CXX $CXXFLAGS $INC -c "$f" -o "$o"
    fi
  done

  # FFT backend selection.
  BACKEND="${TFHE_FFT:-auto}"
  if [ "$BACKEND" = "auto" ]; then
    if grep -q -m1 -E '\bfma\b' /proc/cpuinfo 2>/dev/null && \
       grep -q -m1 -E '\bavx2\b' /proc/cpuinfo 2>/dev/null; then
      BACKEND="spqlios-fma"
    else
      BACKEND="nayuki-portable"
    fi
  fi
  echo "== FFT backend: $BACKEND"

  # Drop stale backend objects so they cannot collide across rebuilds.
  for stale in spq_impl spq_proc spq_lag spqlios-fft-fma spqlios-ifft-fma \
               lagrangehalfc_impl_fma fft_aux fft_model fft_proc fft_lag \
               fft_avx fft_avx_rev fft_portable; do
    rm -f "$OBJ/$stale.o"
  done

  if [ "$BACKEND" = "spqlios-fma" ]; then
    SPQ="$UPSTREAM/src/libtfhe/fft_processors/spqlios"
    $CXX $CXXFLAGS $INC -I"$SPQ" -c "$SPQ/spqlios-fft-impl.cpp" -o "$OBJ/spq_impl.o"
    $CXX $CXXFLAGS $INC -I"$SPQ" -c "$SPQ/fft_processor_spqlios.cpp" -o "$OBJ/spq_proc.o"
    $CXX $CXXFLAGS $INC -I"$SPQ" -c "$SPQ/lagrangehalfc_impl.cpp" -o "$OBJ/spq_lag.o"
    for s in spqlios-fft-fma spqlios-ifft-fma lagrangehalfc_impl_fma; do
      $CC -c "$SPQ/$s.s" -o "$OBJ/$s.o"
    done
  else
    NYK="$UPSTREAM/src/libtfhe/fft_processors/nayuki"
    $CC $CFLAGS -c "$NYK/fft-x8664-avx-aux.c" -o "$OBJ/fft_aux.o"
    $CC $CFLAGS -c "$NYK/fft-model-of-x8664-avx.c" -o "$OBJ/fft_model.o"
    $CXX $CXXFLAGS $INC -I"$NYK" -c "$NYK/fft_processor_nayuki.cpp" -o "$OBJ/fft_proc.o"
    $CXX $CXXFLAGS $INC -I"$NYK" -c "$NYK/lagrangehalfc_impl.cpp" -o "$OBJ/fft_lag.o"
  fi

  echo "== archive $LIB"
  rm -f "$LIB"
  ar rcs "$LIB" "$OBJ"/*.o
}

if [ ! -f "$LIB" ]; then
  build_tfhe
else
  echo "== using prebuilt TFHE archive $LIB"
fi

# --- Link the worker ---
echo "== link worker"
CXX="${CXX:-g++}"
CXXFLAGS="-std=gnu++11 -O2 -DNDEBUG -march=native -funroll-loops"
INC="-I$UPSTREAM/src/include"
$CXX $CXXFLAGS $INC "$WORKER" "$LIB" -lm -o "$BIN/tfhe_worker" \
  2> >(grep -v 'GNU-stack\|deprecated' >&2 || true)

echo "== built $BIN/tfhe_worker"

# Smoke test over stdin/stdout.
printf '1 PING\n2 KEYGEN 128 /tmp/tfhe-smoke-cloud.key\n3 MODE\n4 QUIT\n' | "$BIN/tfhe_worker"
