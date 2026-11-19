// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Local tests only. Mutable and deliberately allows broken reports.
contract FeedFixture {
    uint8 public decimals;
    uint80 public round;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    bool public offline;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function report(uint80 round_, int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        (round, answer, startedAt, updatedAt) = (round_, answer_, startedAt_, updatedAt_);
    }

    function setDecimals(uint8 decimals_) external { decimals = decimals_; }
    function setOffline(bool offline_) external { offline = offline_; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!offline, "NO_DATA");
        return (round, answer, startedAt, updatedAt, 0); // answeredInRound intentionally ignored by the consumer.
    }
}
