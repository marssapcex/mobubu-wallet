// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarketProbe {
    function poke(address who) external;

    function positionOf(address who)
        external
        view
        returns (uint256 coll, uint256 debt, uint256 bid, uint64 last, uint64 bidLock);
}

/// @title PokeProbe — materialises twice inside ONE transaction
/// @notice The only way to test "idempotent inside a block" honestly: two calls
///         with the same block timestamp, one after the other, no mining in
///         between. If the protocol's state were a function of the caller or of
///         the number of calls rather than of elapsed time, this would show it.
contract PokeProbe {
    function probeTwice(address market, address who) external returns (uint256 afterFirst, uint256 afterSecond) {
        IMarketProbe(market).poke(who);
        (, afterFirst,,,) = IMarketProbe(market).positionOf(who);
        IMarketProbe(market).poke(who);
        (, afterSecond,,,) = IMarketProbe(market).positionOf(who);
    }
}
