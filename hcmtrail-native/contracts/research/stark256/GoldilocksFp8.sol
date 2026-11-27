// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Fp[t]/(t^8-7) with canonical 64-bit limbs. The Goldilocks prime is 1 mod 4,
/// 8 divides p-1 and 7 has full 2-adic order. The binomial is irreducible.
library GoldilocksFp8 {
    uint256 internal constant P = 0xffffffff00000001;
    uint256 private constant INV_EIGHT = 16140901060737761281;
    uint256 private constant INV_OMEGA = 1099511627520;

    error NonCanonical();
    error ZeroCoset();

    function check(uint64[8] memory a) private pure {
        for (uint256 i; i < 8; ++i) if (a[i] >= P) revert NonCanonical();
    }

    function multiply(uint64[8] memory a, uint64[8] memory b) internal pure returns (uint64[8] memory) {
        check(a);
        check(b);
        return mul(a, b);
    }

    function mul(uint64[8] memory a, uint64[8] memory b) private pure returns (uint64[8] memory c) {
        // Accumulators < 8 * 7 * (2^64)^2 < 2^134; reducing once per limb
        // preserves the exact polynomial product and avoids mod on every term.
        unchecked {
            for (uint256 i; i < 8; ++i) {
                uint256 acc;
                for (uint256 j; j <= i; ++j) acc += uint256(a[j]) * b[i - j];
                for (uint256 j = i + 1; j < 8; ++j) acc += uint256(a[j]) * b[i + 8 - j] * 7;
                c[i] = uint64(acc % P);
            }
        }
    }

    function powBase(uint256 a, uint256 exponent) internal pure returns (uint256 acc) {
        acc = 1;
        while (exponent != 0) {
            if (exponent & 1 != 0) acc = mulmod(acc, a, P);
            a = mulmod(a, a, P);
            exponent >>= 1;
        }
    }

    function component(uint64[8][8] memory ys, uint256 k) private pure returns (uint256[8] memory sums) {
        uint256 step = powBase(INV_OMEGA, k);
        uint256 weight = 1;
        // Each sum < 8 * 2^128. Reduction/normalization follows in fold8.
        unchecked {
            for (uint256 j; j < 8; ++j) {
                for (uint256 i; i < 8; ++i) sums[i] += uint256(ys[j][i]) * weight;
                weight = mulmod(weight, step, P);
            }
        }
    }

    /// One radix-8 fold at nonzero coset point x, not a spend statement.
    function fold8(uint64[8][8] memory ys, uint64 x, uint64[8] memory alpha)
        internal pure returns (uint64[8] memory acc)
    {
        if (x == 0) revert ZeroCoset();
        if (x >= P) revert NonCanonical();
        check(alpha);
        for (uint256 j; j < 8; ++j) check(ys[j]);
        uint256 inv = powBase(x, P - 2);
        uint64[8] memory at;
        for (uint256 i; i < 8; ++i) at[i] = uint64(mulmod(alpha[i], inv, P));
        for (uint256 k = 8; k > 0; --k) {
            acc = mul(acc, at);
            uint256[8] memory sums = component(ys, k - 1);
            for (uint256 i; i < 8; ++i) acc[i] = uint64(addmod(acc[i], mulmod(sums[i], INV_EIGHT, P), P));
        }
    }
}
