// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ChainlinkPriceEpochs} from "../ChainlinkPriceEpochs.sol";
import {NativeAsset} from "../NativeAssets.sol";
import {ReceiptQuorum} from "./ReceiptQuorum.sol";
import {IFinalizedEvents} from "./WithdrawalTerms.sol";
import {WithdrawalConfigPinData} from "./WithdrawalConfigPinData.sol";

/// @dev This profile opts into a known devnet quorum, not an arbitrary adapter supplied by a deployer.
/// Pin executable logic and validate immutable and storage policy separately. Feed/witness identities
/// are still trusted parameters; a future consensus adapter requires a new audited profile.
library WithdrawalConfigPins {
    error WrongWithdrawalConfig();

    function checkOracle(ChainlinkPriceEpochs oracle, bool tvm) internal view {
        (uint256 length, bytes32 hash, bytes memory groups) = WithdrawalConfigPinData.oracle(tvm);
        _check(address(oracle), length, hash, groups);
        uint32 skew = oracle.maxTimestampSkew();
        address sequencer = oracle.sequencerFeed();
        uint32 grace = oracle.sequencerGrace();
        if (oracle.oracleChainId() != block.chainid || oracle.feeBps() != 0 || skew == 0
            || (sequencer == address(0) ? grace != 0 : sequencer.code.length == 0 || grace == 0)) revert WrongWithdrawalConfig();
        ChainlinkPriceEpochs.Feed[4] memory feeds;
        for (uint8 i; i < 4; ++i) {
            ChainlinkPriceEpochs.Feed memory f = oracle.feedConfig(NativeAsset(i));
            if (f.proxy == sequencer || f.proxy.code.length == 0 || f.maxAge == 0 || f.decimals > 18
                || f.minPrice18 == 0 || f.minPrice18 > f.maxPrice18) revert WrongWithdrawalConfig();
            for (uint8 j; j < i; ++j) if (feeds[j].proxy == f.proxy) revert WrongWithdrawalConfig();
            feeds[i] = f;
        }
        if (oracle.oracleDomain() != sha256(abi.encode(sha256("hcmtrail.native.price-epochs.v1"),
            block.chainid, address(oracle), feeds, skew, uint16(0), sequencer, grace))) revert WrongWithdrawalConfig();
    }

    function checkQuorum(IFinalizedEvents receipts, bool tvm) internal view {
        (uint256 length, bytes32 hash, bytes memory groups) = WithdrawalConfigPinData.quorum(tvm);
        _check(address(receipts), length, hash, groups);
        ReceiptQuorum quorum = ReceiptQuorum(address(receipts));
        if (quorum.homeChain() != block.chainid || quorum.domainSeparator() != keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Hcmtrail Withdrawal Finality"), keccak256("1"), block.chainid, address(quorum)))) revert WrongWithdrawalConfig();
        address w0 = quorum.witnesses(0);
        address w1 = quorum.witnesses(1);
        if (w0 == address(0) || w0 >= w1 || w1 >= quorum.witnesses(2)) revert WrongWithdrawalConfig();
    }

    function _check(address target, uint256 length, bytes32 hash, bytes memory groups) private view {
        bytes memory code = target.code;
        if (code.length != length) revert WrongWithdrawalConfig();
        // Each group starts with the number of occurrences, then their uint16 byte offsets.
        // `build-crosschain --check-config-pins` verifies every interval against solc output.
        for (uint256 i; i < groups.length;) {
            uint256 n = uint8(groups[i++]);
            uint256 expected;
            for (uint256 j; j < n; ++j) {
                uint256 at = (uint256(uint8(groups[i])) << 8) | uint8(groups[i + 1]);
                i += 2;
                uint256 word;
                assembly ("memory-safe") {
                    let ptr := add(add(code, 32), at)
                    word := mload(ptr)
                    mstore(ptr, 0)
                }
                if (j == 0) expected = word;
                else if (word != expected) revert WrongWithdrawalConfig();
            }
        }
        if (keccak256(code) != hash) revert WrongWithdrawalConfig();
    }
}
