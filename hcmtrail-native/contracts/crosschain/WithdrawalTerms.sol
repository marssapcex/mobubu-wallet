// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset, NativeAssets} from "../NativeAssets.sol";
import {HcmtPolicy} from "../dao/HcmtPolicy.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";

/// User consents to a bounded market order, not a fixed price from deposit time.
/// `liquidityLimit` is reserved on the destination before the order can be locked.
struct WithdrawalOrder {
    uint256 sourceChain;
    address sourceVault;
    uint256 destinationChain;
    address destinationVault;
    uint64 amountIn;
    uint96 minNetOut;
    uint96 liquidityLimit;
    address recipient;
    address sourceLP;
    address destinationLP;
    bytes32 refundOwnerCommit;
    bytes32 salt;
    uint64 acceptBy; // exclusive, on the source; reservation must also precede this
    uint64 payBy;    // exclusive, on the destination
}

struct WithdrawalRate {
    bytes32 epoch; // Source oracle observation ID (ordered pair of current rounds).
    uint80 priceIn18;
    uint80 priceOut18;
    uint64 acceptedAt;
    uint96 grossOut;
}

interface IFinalizedEvents {
    /// @dev Verification must bind the remote chain/emitter, exact event, this chain and the calling vault.
    function proves(uint256 remoteChain, address emitter, uint8 kind, bytes32 order, bytes32 data,
        bytes calldata proof) external view returns (bool);
}

library WithdrawalTerms {
    uint8 internal constant RESERVED = 1;
    uint8 internal constant LOCKED = 2;
    uint8 internal constant PAID = 3;
    uint8 internal constant CANCELLED = 4;
    uint64 internal constant MIN_RELAY_WINDOW = 15 minutes;
    uint64 internal constant MAX_RELAY_WINDOW = 2 days;
    uint64 internal constant MAX_ACCEPT_WINDOW = 1 hours;
    bytes32 private constant DOMAIN = keccak256("hcmtrail.crosschain-native-withdrawal.v1");

    error UnsupportedChain();
    error InvalidOrder();
    error OutOfBounds();

    function asset(uint256 chain) internal pure returns (NativeAsset) {
        if (chain == 11155111) return NativeAsset.ETH;
        if (chain == 97) return NativeAsset.BNB;
        if (chain == 0xcd8690dc) return NativeAsset.TRX;
        if (chain == 998) return NativeAsset.HYPE;
        revert UnsupportedChain();
    }

    function id(WithdrawalOrder calldata order) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, order));
    }

    function validate(WithdrawalOrder calldata o) internal pure {
        NativeAsset src = asset(o.sourceChain);
        NativeAsset dst = asset(o.destinationChain);
        // NotBefore's two synthetic address slots require a positive 1-unit second leg.
        // Both legs go into escrow; neither is paid to a relayer or charged as a fee.
        uint256 cap = src == NativeAsset.TRX ? uint256(uint64(type(int64).max)) : Goldilocks.MAX_VALUE;
        if (src == dst || o.sourceVault == address(0) || o.destinationVault == address(0)
            || o.amountIn < 2 || o.amountIn > cap || o.liquidityLimit > NativeAssets.ceiling(dst)
            || o.minNetOut == 0 || o.minNetOut > o.liquidityLimit - HcmtPolicy.fee(o.liquidityLimit)
            || o.recipient == address(0) || o.sourceLP == address(0) || o.destinationLP == address(0)
            || o.recipient == o.destinationVault || o.sourceLP == o.sourceVault || o.destinationLP == o.destinationVault
            || o.refundOwnerCommit == bytes32(0) || !Goldilocks.isCanonicalDigest(o.refundOwnerCommit) || o.salt == bytes32(0)
            || o.acceptBy == 0 || o.payBy <= o.acceptBy || o.payBy - o.acceptBy < MIN_RELAY_WINDOW
            || o.payBy - o.acceptBy > MAX_RELAY_WINDOW) revert InvalidOrder();
    }

    function acceptanceOpen(WithdrawalOrder calldata o) internal view {
        if (block.timestamp >= o.acceptBy || o.acceptBy - block.timestamp > MAX_ACCEPT_WINDOW) revert InvalidOrder();
    }

    function payout(WithdrawalOrder calldata o, uint80 input18, uint80 output18)
        internal pure returns (uint96 gross, uint96 levy, uint96 net)
    {
        // Conversion is gross and floors only once. Then apply the existing DAO fee floor in dst units.
        // No source withdrawal fee or second deposit fee. No gas fee deducted from this quote.
        gross = uint96(NativeAssets.convert(asset(o.sourceChain), asset(o.destinationChain), o.amountIn, input18, output18, 0));
        levy = uint96(HcmtPolicy.fee(gross));
        net = gross - levy;
        if (net < o.minNetOut || gross > o.liquidityLimit) revert OutOfBounds();
    }

    function authenticated(IFinalizedEvents verifier, uint256 chain, address emitter, uint8 kind, bytes32 order,
        bytes32 data, bytes calldata proof) internal view
    {
        try verifier.proves(chain, emitter, kind, order, data, proof) returns (bool valid) {
            if (valid) return;
        } catch {} // A malformed certificate (including noncanonical ABI words) fails closed.
        revert UnverifiedEvent();
    }

    error UnverifiedEvent();
}
