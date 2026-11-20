// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeStark} from "../vault/NativeStark.sol";
import {NativeExit} from "../vault/NativeVault.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";
import {WithdrawalTerms} from "./WithdrawalTerms.sol";

/// @notice The same pinned NotBefore circuit as the native vault, deployed separately to stay under
/// initcode limits. It only verifies a statement; it has no rights over money or note roots.
contract SpendGate is NativeStark {
    uint256 public immutable homeChain;
    error InvalidStatement();

    constructor(address prepare, address walk, address[3] memory chunks)
        NativeStark(block.chainid == 0xcd8690dc, prepare, walk, chunks)
    {
        WithdrawalTerms.asset(block.chainid);
        homeChain = block.chainid;
    }

    function verify(bytes calldata proof, uint8 asset, NativeExit calldata spend) external view returns (bool) {
        if (block.chainid != homeChain || uint8(WithdrawalTerms.asset(block.chainid)) != asset) revert InvalidStatement();
        uint256[] memory limbs = new uint256[](37);
        _digest(limbs, 0, spend.root);
        _digest(limbs, 4, spend.root);
        _digest(limbs, 8, spend.nullifiers[0]);
        _digest(limbs, 12, spend.nullifiers[1]);
        _digest(limbs, 16, spend.change[0]);
        _digest(limbs, 20, spend.change[1]);
        limbs[24] = spend.amount;
        limbs[25] = spend.fee;
        limbs[26] = asset;
        _address(limbs, 28, spend.recipient);
        _address(limbs, 32, spend.feeRecipient);
        limbs[36] = spend.notBefore;
        _verifyStark(proof, limbs);
        return true;
    }

    function _digest(uint256[] memory limbs, uint256 i, bytes32 d) private pure {
        if (d == bytes32(0) || !Goldilocks.isCanonicalDigest(d)) revert InvalidStatement();
        for (uint256 j; j < 4; ++j) limbs[i + j] = Goldilocks.limb(d, j);
    }

    function _address(uint256[] memory limbs, uint256 i, address at) private pure {
        for (uint256 j; j < 4; ++j) limbs[i + j] = uint48(uint160(at) >> (48 * j));
    }
}
