// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Aave v4 liquidation arithmetic, re-expressed
/// @notice Line-for-line port of the two functions that decide the *cost* of a
///         liquidation in Aave v4, used here only as a benchmark for the buffer.
///         Source: `aave/aave-v4` `src/spoke/libraries/LiquidationLogic.sol`
///           - `calculateLiquidationBonus`                     : L312-333
///           - `_calculateDebtToTargetHealthFactor`             : L795-813
///         Aave v4 is BUSL-1.1; this is an independent MIT re-expression of the
///         arithmetic (no Aave code text is reproduced beyond the formula shape),
///         written for comparison and test fixtures. PercentMath semantics used:
///         `percentMulDown(x, bps)  = x * bps / 10000` (floor)
///         `percentMulUp(x, bps)    = ceil(x * bps / 10000)`
///         `bpsToWad(bps)           = bps * 1e18 / 10000`
library AaveV4Math {
    uint256 internal constant PERCENTAGE_FACTOR = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18;
    uint256 internal constant RAY = 1e27;

    function percentMulDown(uint256 value, uint256 bps) internal pure returns (uint256) {
        return (value * bps) / PERCENTAGE_FACTOR;
    }

    function percentMulUp(uint256 value, uint256 bps) internal pure returns (uint256) {
        uint256 p = value * bps;
        return p == 0 ? 0 : (p - 1) / PERCENTAGE_FACTOR + 1;
    }

    function bpsToWad(uint256 bps) internal pure returns (uint256) {
        return (bps * WAD) / PERCENTAGE_FACTOR;
    }

    /// @dev LiquidationLogic.sol:312. Bonus in BPS: `max` when HF <= hfForMax,
    ///      otherwise linear between `min` and `max` over [hfForMax, 1.0].
    ///      Still a discontinuous payout: the transfer happens on the HF < 1 gate.
    function calculateLiquidationBonus(
        uint256 healthFactorForMaxBonus,
        uint256 liquidationBonusFactor,
        uint256 healthFactor,
        uint256 maxLiquidationBonus
    ) internal pure returns (uint256) {
        if (healthFactor <= healthFactorForMaxBonus) return maxLiquidationBonus;
        uint256 minLiquidationBonus =
            percentMulDown(maxLiquidationBonus - PERCENTAGE_FACTOR, liquidationBonusFactor) + PERCENTAGE_FACTOR;
        return minLiquidationBonus
            + ((maxLiquidationBonus - minLiquidationBonus)
                * (HEALTH_FACTOR_LIQUIDATION_THRESHOLD - healthFactor))
                / (HEALTH_FACTOR_LIQUIDATION_THRESHOLD - healthFactorForMaxBonus);
    }

    /// @dev LiquidationLogic.sol:795. Debt (in debt-asset units) that must be
    ///      covered to lift HF to `targetHealthFactor`. `penalty = bonus_wad
    ///      percentMulUp collateralFactor`, ceil-rounded.
    /// @param totalDebtValueRay total debt value, RAY
    /// @param debtAssetUnit    unit of the debt asset (1e6 for USDC, 1e18 for DAI)
    /// @param debtAssetPriceWad price of the debt asset, WAD
    function debtToTargetHealthFactor(
        uint256 totalDebtValueRay,
        uint256 debtAssetUnit,
        uint256 targetHealthFactor,
        uint256 healthFactor,
        uint256 liquidationBonusBps,
        uint256 collateralFactor,
        uint256 debtAssetPriceWad
    ) internal pure returns (uint256) {
        uint256 liquidationPenalty = percentMulUp(bpsToWad(liquidationBonusBps), collateralFactor);
        uint256 num = totalDebtValueRay * debtAssetUnit * (targetHealthFactor - healthFactor);
        uint256 den = (targetHealthFactor - liquidationPenalty) * debtAssetPriceWad;
        uint256 q = num / den;
        return (num % den == 0) ? q : q + 1; // Rounding.Ceil
    }

    /// @notice Health factor exactly as the Spoke computes it: collateral value
    ///         times the average collateral factor over debt value, WAD.
    function healthFactor(uint256 collValue, uint256 avgCollateralFactor, uint256 debtValueRay)
        internal
        pure
        returns (uint256)
    {
        if (debtValueRay == 0) return type(uint256).max;
        return (collValue * avgCollateralFactor * RAY) / (WAD * debtValueRay);
    }
}
