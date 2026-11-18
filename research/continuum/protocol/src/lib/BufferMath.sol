// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BufferMath — the arithmetic of the buffer line, in one place
/// @notice Every function states its rounding direction, because the whole
///         solvency argument is an inequality and a rounding choice can only
///         ever be on one side of it. Nothing here touches storage.
///
///         Terms
///           V  value of the collateral, denominated in debt-token units
///           D  debt, in debt-token units
///           c  buffer discount, WAD; c > 1. The pool will always buy the
///              collateral at par less (1 - 1/c), so `c * D` is the value the
///              collateral must still hold after any state transition.
///           S  surplus, `V - c * D`. The invariant is S >= 0.
library BufferMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    /// @notice Value of `units` of collateral, in debt-token units. Rounds DOWN.
    /// @param price debt-token units per whole collateral token, priced 1e18
    /// @param unitC 1e{decimals(collateral)}; @param unitD 1e{decimals(debt)}
    function valueOf(uint256 units, uint256 price, uint256 unitC, uint256 unitD)
        internal
        pure
        returns (uint256)
    {
        return (units * price * unitD) / (unitC * WAD);
    }

    /// @notice Collateral units whose value equals `value` (debt units). Rounds DOWN.
    function unitsForValue(uint256 value, uint256 price, uint256 unitC, uint256 unitD)
        internal
        pure
        returns (uint256)
    {
        return (value * unitC * WAD) / (price * unitD);
    }

    /// @notice S = V - c*D, **exactly**, returned in WAD-scaled debt units.
    /// @dev The comparison is done on one numerator (`V*WAD` against `c*D`) so
    ///      there is no division and therefore no rounding at all. That matters:
    ///      an earlier version computed `c*D/WAD` first and the floor let the
    ///      invariant read -1 wei when the rent sat exactly on its cap.
    function surplus(uint256 V, uint256 D, uint256 c) internal pure returns (int256) {
        uint256 lhs = V * WAD;
        uint256 rhs = c * D;
        if (lhs >= rhs) return int256(lhs - rhs);
        return -int256(rhs - lhs);
    }

    /// @notice Maximum rent (in debt units) that may be added to `D` without
    ///         breaking S >= 0: c*(D+r) <= V  =>  r <= (V - c*D)/c. Rounds DOWN.
    function rentCap(uint256 V, uint256 D, uint256 c) internal pure returns (uint256) {
        uint256 lhs = V * WAD;
        uint256 rhs = c * D;
        if (lhs <= rhs) return 0;
        // r = floor((V*WAD - c*D) / c)  =>  c*(D+r) <= V*WAD, exactly
        return (lhs - rhs) / c;
    }

    /// @notice Health factor expressed the way a liquidation rule would read it:
    ///         V/D in WAD. The mechanism never consults it; it exists so that
    ///         integrators cannot pretend the predicate is undefined.
    function health(uint256 V, uint256 D) internal pure returns (uint256) {
        if (D == 0) return type(uint256).max;
        return (V * WAD) / D;
    }

    /// @notice Deleverage distance: how far the collateral value is below the
    ///         buffer's own target line `target * D`. Zero when healthy.
    function gap(uint256 V, uint256 D, uint256 target) internal pure returns (uint256) {
        uint256 trig = (target * D) / WAD;
        return V < trig ? trig - V : 0;
    }

    /// @notice Flow per unit of time: x = k * gap * dt / YEAR, in debt units.
    ///         Rounds DOWN, so the flow is never faster than the law allows.
    function flow(uint256 gapValue, uint256 k, uint256 dt) internal pure returns (uint256) {
        return ((k * gapValue) / WAD) * dt / YEAR;
    }

    /// @notice Dimensionless imbalance in [-1e18, 1e18]: demand net of supply,
    ///         normalised by the larger side. This is the `z` of the theorems.
    function imbalance(uint256 demand, uint256 supply) internal pure returns (int256) {
        uint256 norm = demand > supply ? demand : supply;
        if (norm == 0) return 0;
        int256 diff = int256(demand) - int256(supply);
        return (diff * int256(WAD)) / int256(norm);
    }

    /// @notice One step of the rent law, clipped to `+-cap`. `cap` is half a
    ///         bucket, i.e. the resolution of the demand book: without it a
    ///         step function of a demand curve limit-cycles.
    function step(int256 z, uint256 eta, uint256 cap) internal pure returns (int256) {
        int256 s = (int256(eta) * z) / int256(WAD);
        int256 c2 = int256(cap);
        if (s > c2) return c2;
        if (s < -c2) return -c2;
        return s;
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @notice Clip a signed value into [0, hi].
    function clip(int256 x, uint256 hi) internal pure returns (uint256) {
        if (x <= 0) return 0;
        if (uint256(x) > hi) return hi;
        return uint256(x);
    }
}
