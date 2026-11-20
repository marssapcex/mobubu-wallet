// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset, NativeAssets} from "./NativeAssets.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Noncustodial pricing lab. Reads four local Chainlink-style proxies; never takes funds or user orders.
/// @dev Does not authenticate any remote chain or provide an executable liquidity quote.
contract ChainlinkPriceEpochs {
    struct Feed {
        address proxy;
        uint32 maxAge;
        uint8 decimals;
        uint80 minPrice18;
        uint80 maxPrice18;
    }

    struct Round {
        uint80 roundId;
        uint80 price18;
        uint64 updatedAt;
    }

    struct Epoch {
        bytes32 id;
        uint64 publishedAt;
        uint64 validUntil; // Exclusive, determined by the oldest freshness deadline across all four feeds.
        Round[4] rounds;
    }

    bytes32 private constant DOMAIN_TAG = sha256("hcmtrail.native.price-epochs.v1");
    bytes32 private constant PAIR_TAG = keccak256("hcmtrail.native.live-price-pair.v1");
    uint256 public immutable oracleChainId;
    bytes32 public immutable oracleDomain;
    uint32 public immutable maxTimestampSkew;
    uint16 public immutable feeBps;
    address public immutable sequencerFeed;
    uint32 public immutable sequencerGrace;
    Feed[4] private feeds; // Only written in the constructor; no owner, setter, proxy or delegatecall.
    Epoch private published;

    error WrongChain();
    error BadPolicy();
    error BadFeedConfig(NativeAsset asset);
    error DuplicateFeed();
    error BadClock();
    error SequencerUnavailable();
    error FeedDecimalsChanged(NativeAsset asset);
    error InvalidRound(NativeAsset asset);
    error StaleRound(NativeAsset asset);
    error PriceOutsideBounds(NativeAsset asset);
    error TimestampSkew();
    error NonMonotonicRound(NativeAsset asset);
    error NoEpoch();
    error EpochExpired();
    error EpochChanged();
    error MinimumNotMet();

    event EpochPublished(bytes32 indexed id, uint64 publishedAt, uint64 validUntil, Round[4] rounds);

    constructor(
        uint256 expectedChainId,
        Feed[4] memory policy,
        uint32 timestampSkew,
        uint16 swapFeeBps,
        address l2Sequencer,
        uint32 grace
    ) {
        if (expectedChainId == 0 || block.chainid != expectedChainId) revert WrongChain();
        if (timestampSkew == 0 || swapFeeBps >= NativeAssets.BPS) revert BadPolicy();
        // An OP Mainnet pricing-only hub is a candidate, not a default deployment target.
        if (l2Sequencer == address(0)) {
            if (grace != 0 || expectedChainId == 10) revert BadPolicy();
        } else if (l2Sequencer.code.length == 0 || grace == 0) revert BadPolicy();
        for (uint8 i; i < 4; ++i) {
            Feed memory f = policy[i];
            if (f.proxy == l2Sequencer || f.proxy.code.length == 0 || f.maxAge == 0 || f.decimals > 18
                || f.minPrice18 == 0 || f.maxPrice18 < f.minPrice18
                || IAggregatorV3(f.proxy).decimals() != f.decimals) revert BadFeedConfig(NativeAsset(i));
            for (uint8 j; j < i; ++j) {
                if (f.proxy == policy[j].proxy) revert DuplicateFeed();
            }
            feeds[i] = f;
        }
        oracleChainId = expectedChainId;
        maxTimestampSkew = timestampSkew;
        feeBps = swapFeeBps;
        sequencerFeed = l2Sequencer;
        sequencerGrace = grace;
        oracleDomain = sha256(abi.encode(DOMAIN_TAG, expectedChainId, address(this), policy, timestampSkew,
            swapFeeBps, l2Sequencer, grace));
    }

    function nativeAssetInfo(NativeAsset asset) external pure returns (uint256, uint256, uint256) {
        return (NativeAssets.chainId(asset), NativeAssets.units(asset), NativeAssets.ceiling(asset));
    }

    function feedConfig(NativeAsset asset) external view returns (Feed memory) {
        return feeds[uint8(asset)];
    }

    /// @notice Last publication (historical information; it can be stale or superseded).
    function publishedEpoch() external view returns (Epoch memory) {
        return published;
    }

    /// @notice Anyone can relay a new epoch. No calldata for amounts or caller-selected rounds.
    function refresh() external returns (bytes32 id) {
        (Round[4] memory next, uint64 validUntil) = _readAll();
        id = _epochId(next, validUntil);
        if (id == published.id) return id; // Cannot extend an epoch by replaying the same rounds.

        for (uint8 i; i < 4; ++i) {
            Round memory previous = published.rounds[i];
            Round memory n = next[i];
            if (n.roundId < previous.roundId || n.updatedAt < previous.updatedAt
                || (n.roundId == previous.roundId
                    && (n.price18 != previous.price18 || n.updatedAt != previous.updatedAt))) {
                revert NonMonotonicRound(NativeAsset(i));
            }
            published.rounds[i] = n;
        }
        uint64 now64 = uint64(block.timestamp); // Checked in _readAll.
        published.id = id;
        published.publishedAt = now64;
        published.validUntil = validUntil;
        emit EpochPublished(id, now64, validUntil, next);
    }

    /// @notice Read the shared public prices; use this and compute private quotes in the wallet.
    function activeEpoch() public view returns (Epoch memory current) {
        current = published;
        if (current.id == bytes32(0)) revert NoEpoch();
        if (block.timestamp >= current.validUntil) revert EpochExpired();
        (Round[4] memory latest, uint64 validUntil) = _readAll();
        if (_epochId(latest, validUntil) != current.id) revert EpochChanged();
    }

    /// @notice Two current rounds for a new withdrawal. No keeper or other asset's feed is required.
    /// @dev The observation ID identifies this ordered pair, not a published four-feed epoch or a remote proof.
    function currentPair(NativeAsset src, NativeAsset dst)
        external view returns (bytes32 observation, Round memory input, Round memory output)
    {
        if (src == dst) revert NativeAssets.SameAsset();
        (uint256 nowAt, uint256 recoveredAt) = _clock();
        (input,) = _readOne(src, nowAt, recoveredAt);
        (output,) = _readOne(dst, nowAt, recoveredAt);
        uint64 skew = input.updatedAt > output.updatedAt ? input.updatedAt - output.updatedAt : output.updatedAt - input.updatedAt;
        if (skew > maxTimestampSkew) revert TimestampSkew();
        observation = keccak256(abi.encode(PAIR_TAG, oracleDomain, src, dst, input, output));
    }

    /// @notice Reference math only. Do not send a private debit/minOut here or to a public RPC.
    function quote(bytes32 expectedEpoch, NativeAsset src, NativeAsset dst, uint256 debit, uint256 minOut)
        external view returns (uint256 payout)
    {
        Epoch memory current = activeEpoch();
        if (expectedEpoch != current.id) revert EpochChanged();
        payout = NativeAssets.convert(src, dst, debit, current.rounds[uint8(src)].price18,
            current.rounds[uint8(dst)].price18, feeBps);
        if (payout < minOut) revert MinimumNotMet();
    }

    function _epochId(Round[4] memory rounds, uint64 validUntil) private view returns (bytes32) {
        return sha256(abi.encode(oracleDomain, validUntil, rounds));
    }

    function _clock() private view returns (uint256 nowAt, uint256 recoveredAt) {
        if (block.chainid != oracleChainId) revert WrongChain();
        nowAt = block.timestamp;
        if (nowAt == 0 || nowAt > type(uint64).max - type(uint32).max) revert BadClock();
        recoveredAt = _recoverTime(nowAt);
    }

    function _readAll() private view returns (Round[4] memory rounds, uint64 expiry) {
        (uint256 nowAt, uint256 recoveredAt) = _clock();
        uint64 oldest = type(uint64).max;
        uint64 newest;
        expiry = type(uint64).max;
        for (uint8 i; i < 4; ++i) {
            (Round memory r, uint64 deadline) = _readOne(NativeAsset(i), nowAt, recoveredAt);
            rounds[i] = r;
            if (r.updatedAt < oldest) oldest = r.updatedAt;
            if (r.updatedAt > newest) newest = r.updatedAt;
            if (deadline < expiry) expiry = deadline;
        }
        if (newest - oldest > maxTimestampSkew) revert TimestampSkew();
    }

    function _recoverTime(uint256 nowAt) private view returns (uint256) {
        if (sequencerFeed == address(0)) return 0;
        (uint80 roundId, int256 status, uint256 startedAt, uint256 updatedAt,) =
            IAggregatorV3(sequencerFeed).latestRoundData();
        if (roundId == 0 || status != 0 || startedAt == 0 || updatedAt < startedAt || updatedAt > nowAt
            || nowAt - startedAt <= sequencerGrace) revert SequencerUnavailable();
        return startedAt;
    }

    function _readOne(NativeAsset asset, uint256 nowAt, uint256 recoveredAt)
        private view returns (Round memory r, uint64 deadline)
    {
        Feed memory f = feeds[uint8(asset)];
        IAggregatorV3 feed = IAggregatorV3(f.proxy);
        if (feed.decimals() != f.decimals) revert FeedDecimalsChanged(asset);
        // answeredInRound is deprecated. Freshness is based on the timestamp of the reported answer.
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (roundId == 0 || answer <= 0 || updatedAt == 0 || updatedAt > nowAt) revert InvalidRound(asset);
        if (updatedAt < recoveredAt || nowAt - updatedAt >= f.maxAge) revert StaleRound(asset);

        uint256 scale = 10 ** (18 - uint256(f.decimals));
        if (uint256(answer) > uint256(f.maxPrice18) / scale) revert PriceOutsideBounds(asset);
        uint256 normalized = uint256(answer) * scale;
        if (normalized < f.minPrice18) revert PriceOutsideBounds(asset);
        return (Round(roundId, uint80(normalized), uint64(updatedAt)), uint64(updatedAt + f.maxAge));
    }
}
