// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Wire order for the four native assets. No ERC-20 addresses or caller-supplied units.
enum NativeAsset { ETH, BNB, TRX, HYPE }

library NativeAssets {
    uint256 internal constant BPS = 10_000;

    error SameAsset();
    error InvalidDebit();
    error InvalidPriceOrFee();
    error UnpayableAmount();

    function chainId(NativeAsset asset) internal pure returns (uint256) {
        if (asset == NativeAsset.ETH) return 1;
        if (asset == NativeAsset.BNB) return 56;
        if (asset == NativeAsset.TRX) return 0x2b6653dc; // TVM Mainnet CHAINID.
        return 999; // HyperEVM (not HyperCore).
    }

    function units(NativeAsset asset) internal pure returns (uint256) {
        return asset == NativeAsset.TRX ? 1e6 : 1e18;
    }

    function ceiling(NativeAsset asset) internal pure returns (uint256) {
        // TRON transports native amounts as nonnegative signed int64 (sun).
        return asset == NativeAsset.TRX ? uint256(uint64(type(int64).max)) : type(uint96).max;
    }

    function convert(NativeAsset src, NativeAsset dst, uint256 debit, uint80 priceIn, uint80 priceOut, uint16 feeBps)
        internal pure returns (uint256 payout)
    {
        if (src == dst) revert SameAsset();
        if (debit == 0 || debit > ceiling(src)) revert InvalidDebit();
        if (priceIn == 0 || priceOut == 0 || feeBps >= BPS) revert InvalidPriceOrFee();

        // Common price scale cancels. No intermediate rounding. Bounds: numerator < 2^(96+80+60+14),
        // denominator < 2^(80+60+14), so checked uint256 arithmetic is sufficient.
        uint256 numerator = debit * priceIn * units(dst) * (BPS - feeBps);
        uint256 denominator = uint256(priceOut) * units(src) * BPS;
        payout = numerator / denominator;
        if (payout == 0 || payout > ceiling(dst)) revert UnpayableAmount();
    }
}
