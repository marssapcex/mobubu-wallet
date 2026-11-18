// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title YieldMath
 * @dev Toán tính lãi cho YieldVault.
 *      Mô hình lãi đơn: amount * apr * elapsed_time / SECONDS_PER_YEAR.
 *      Trong production, kết nối với Aave/Morpho adapter để tính lãi thật.
 */
library YieldMath {
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant PRECISION = 1e18;

    /**
     * @dev Tính lãi đã sinh ra từ amount trong khoảng thời gian elapsed.
     * @param amount số tiền gốc
     * @param aprBps lãi suất năm (basis points, ví dụ 500 = 5%)
     * @param elapsedSeconds thời gian trôi qua (giây)
     * @return lãi đã sinh (weide smallest unit)
     */
    function calculateInterest(
        uint256 amount,
        uint256 aprBps,
        uint256 elapsedSeconds
    ) internal pure returns (uint256) {
        if (amount == 0 || aprBps == 0 || elapsedSeconds == 0) {
            return 0;
        }
        // interest = amount * aprBps * elapsedSeconds / (SECONDS_PER_YEAR * PRECISION)
        uint256 numerator = amount * aprBps * elapsedSeconds;
        uint256 denominator = SECONDS_PER_YEAR * PRECISION;
        return numerator / denominator;
    }

    /**
     * @dev Tính tổng số tiền (gốc + lãi).
     */
    function calculateTotal(
        uint256 amount,
        uint256 interest
    ) internal pure returns (uint256) {
        return amount + interest;
    }

    /**
     * @dev Chuyển amount sang yToken (1:1 tại thời điểm deposit, sau đó yToken giá trị tăng theo lãi).
     */
    function amountToYTokens(
        uint256 amount,
        uint256 totalSupply,
        uint256 totalAssets
    ) internal pure returns (uint256) {
        if (totalAssets == 0) {
            return amount;
        }
        return (amount * totalSupply) / totalAssets;
    }

    /**
     * @dev Chuyển yToken ngược lại amount.
     */
    function yTokensToAmount(
        uint256 yTokens,
        uint256 totalSupply,
        uint256 totalAssets
    ) internal pure returns (uint256) {
        if (totalSupply == 0) {
            return 0;
        }
        return (yTokens * totalAssets) / totalSupply;
    }
}
