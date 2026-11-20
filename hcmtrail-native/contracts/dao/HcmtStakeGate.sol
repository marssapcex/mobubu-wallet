// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeStark} from "../vault/NativeStark.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";

struct StakePermit {
    uint64 nonce;
    uint64 notBefore;
    bytes32[2] nullifiers;
    bytes32[2] outputs;
}

/// @notice A pinned NotBefore proof of knowledge for a synthetic staking credential (no money).
/// @dev Created by the treasury, never supplied by the caller. The treasury interprets the proof
/// as authorization of `challenge`; it does not pay either synthetic public address or append notes.
contract HcmtStakeGate is NativeStark {
    uint256 public constant AUTH_ASSET = 0x48434d5453544b31; // "HCMTSTK1", disjoint from native assets
    uint256 public constant TIME_GRID = 600;
    error InvalidStakeStatement();

    constructor(bool tvm, address prepare, address walk, address[3] memory chunks) NativeStark(tvm, prepare, walk, chunks) {}

    function verify(bytes calldata proof, bytes32 root, bytes32 challenge, StakePermit calldata permit) external view {
        if (permit.notBefore == 0 || permit.notBefore > block.timestamp || permit.notBefore >= Goldilocks.P
            || permit.notBefore % TIME_GRID != 0 || permit.nullifiers[0] == permit.nullifiers[1]) {
            revert InvalidStakeStatement();
        }
        uint256[] memory limbs = new uint256[](37);
        _digest(limbs, 0, root);
        _digest(limbs, 4, root);
        _digest(limbs, 8, permit.nullifiers[0]);
        _digest(limbs, 12, permit.nullifiers[1]);
        _digest(limbs, 16, permit.outputs[0]);
        _digest(limbs, 20, permit.outputs[1]);
        // The two unit amounts force a live opening in the registered root. These units
        // have no financial value. The full 256-bit action hash uses two 128-bit payloads
        // in the address slots, each marked nonzero at bit 128. Limbs are 48/48/48/16 bits.
        limbs[24] = 1;
        limbs[25] = 1;
        limbs[26] = AUTH_ASSET;
        uint256 digest = uint256(challenge);
        _address(limbs, 28, uint128(digest >> 128));
        _address(limbs, 32, uint128(digest));
        limbs[36] = permit.notBefore;
        _verifyStark(proof, limbs);
    }

    function _digest(uint256[] memory limbs, uint256 i, bytes32 digest) private pure {
        if (digest == bytes32(0) || !Goldilocks.isCanonicalDigest(digest)) revert InvalidStakeStatement();
        for (uint256 j; j < 4; ++j) limbs[i + j] = Goldilocks.limb(digest, j);
    }

    function _address(uint256[] memory limbs, uint256 i, uint128 data) private pure {
        uint256 word = (uint256(1) << 128) | data;
        for (uint256 j; j < 4; ++j) limbs[i + j] = uint48(word >> (48 * j));
    }
}
