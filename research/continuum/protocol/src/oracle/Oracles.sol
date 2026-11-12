// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);

    function transfer(address, uint256) external returns (bool);

    function decimals() external view returns (uint8);
}

/// @title IOracle — one number, and the right to refuse to give it
/// @notice `price` is debt-token units per whole collateral token, scaled 1e18.
///         An oracle that cannot prove freshness must revert: the market treats
///         a revert as "no accrual possible", which is the only safe answer.
interface IOracle {
    function price() external view returns (uint256);
}

/// @notice Admin-set price, for tests and for chains with no feed. Never deploy
///         this in production: it has no staleness bound and no TWAP.
contract FixedOracle is IOracle {
    address public immutable admin;
    uint256 public priceValue;

    event PriceSet(uint256 price);

    constructor(uint256 price_) {
        admin = msg.sender;
        priceValue = price_;
    }

    function setPrice(uint256 p) external {
        require(msg.sender == admin, "oracle: admin");
        priceValue = p;
        emit PriceSet(p);
    }

    function price() external view returns (uint256) {
        return priceValue;
    }
}

/// @title ChainlinkOracleAdapter
/// @notice Reads a Chainlink aggregator with three refusals the protocol needs:
///         answered-in-round, positive answer, and a staleness ceiling. Decimals
///         are normalised to 1e18. `heartbeat` must be set to the feed's own
///         heartbeat, not to a value chosen to make tests pass.
contract ChainlinkOracleAdapter is IOracle {
    address public immutable feed;
    uint8 public immutable feedDecimals;
    uint256 public immutable heartbeat;
    address public immutable admin;

    error Stale(uint256 updatedAt, uint256 nowTs);
    error NonPositive(int256 answer);
    error IncompleteRound(uint80 answeredInRound, uint80 roundId);

    constructor(address feed_, uint8 feedDecimals_, uint256 heartbeat_) {
        admin = msg.sender;
        feed = feed_;
        feedDecimals = feedDecimals_;
        heartbeat = heartbeat_;
    }

    function price() external view returns (uint256) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            IChainlinkAggregator(feed).latestRoundData();
        if (answer <= 0) revert NonPositive(answer);
        if (answeredInRound < roundId) revert IncompleteRound(answeredInRound, roundId);
        if (updatedAt + heartbeat < block.timestamp) revert Stale(updatedAt, block.timestamp);
        return uint256(answer) * 1e18 / (10 ** feedDecimals);
    }
}

interface IChainlinkAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title OracleGuard — a market-level ceiling on how far one block may move the mark
/// @notice Defence in depth against a compromised feed and against a single
///         manipulated print. The market refuses to accrue on a price that moved
///         more than `maxMoveBps` from the last accepted price, so the flow can
///         never be driven by a print the market has not absorbed gradually.
library OracleGuard {
    function check(uint256 last, uint256 next, uint256 maxMoveBps) internal pure {
        if (last == 0) return;
        uint256 hi = (last * (10_000 + maxMoveBps)) / 10_000;
        uint256 lo = (last * (10_000 - maxMoveBps)) / 10_000;
        require(next <= hi && next >= lo, "oracle: jump too large");
    }
}
