// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Blake2b512} from "./Blake2b512.sol";

/// Domain-separated 512-bit transcript/commitment building blocks, NOT the
/// Fiat–Shamir schedule of a note-spend proof. No live custody callers.
library WideTranscript256 {
    string private constant DOMAIN = "hcmtrail/eth-pool/stark256/research/v2";
    uint256 private constant P = 0xffffffff00000001;

    error InvalidDigestLength();
    error FrameTooLarge();
    error ExhaustedChallenge();

    function check(bytes memory value) private pure {
        if (value.length != 64) revert InvalidDigestLength();
    }

    function start(bytes memory publicContext) internal view returns (bytes memory) {
        if (publicContext.length > type(uint32).max) revert FrameTooLarge();
        return Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(0), uint32(publicContext.length), publicContext));
    }

    function absorb(bytes memory state, uint8 label, bytes memory value) internal view returns (bytes memory) {
        check(state);
        if (value.length > type(uint32).max) revert FrameTooLarge();
        return Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(1), state, label, uint32(value.length), value));
    }

    function readWord(bytes memory data, uint256 at) internal pure returns (uint64 word) {
        // Callers pass 8-byte-aligned offsets in already length-checked sections.
        // Load the aligned memory word so the last read stays within the allocation.
        assembly ("memory-safe") {
            let v := mload(add(add(data, 32), and(at, not(31))))
            v := and(shr(sub(192, mul(8, and(at, 31))), v), 0xffffffffffffffff)
            v := or(shl(8, and(v, 0x00ff00ff00ff00ff)), shr(8, and(v, 0xff00ff00ff00ff00)))
            v := or(shl(16, and(v, 0x0000ffff0000ffff)), shr(16, and(v, 0xffff0000ffff0000)))
            word := or(shl(32, and(v, 0xffffffff)), shr(32, v))
        }
    }

    /// Eight little-endian u64 words. Reject the entire sample if any word is at
    /// least p; reducing u64 modulo p would give some elements twice the weight.
    function sample(bytes memory candidate) internal pure returns (bool ok, uint64[8] memory value) {
        check(candidate);
        for (uint256 i; i < 8; ++i) {
            uint64 word = readWord(candidate, 8 * i);
            if (word >= P) return (false, value);
            value[i] = word;
        }
        return (true, value);
    }

    function challenge(bytes memory state, uint8 label)
        internal view returns (uint64[8] memory value, bytes memory next)
    {
        check(state);
        for (uint32 retry; retry < 8; ++retry) {
            next = Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(2), state, label, retry));
            (bool ok, uint64[8] memory words) = sample(next);
            if (ok) return (words, next);
        }
        revert ExhaustedChallenge();
    }

    function leaf(uint8 tree, bytes memory row) internal view returns (bytes memory) {
        if (row.length > type(uint32).max) revert FrameTooLarge();
        return Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(3), tree, uint32(row.length), row));
    }

    function parent(uint8 tree, bytes memory left, bytes memory right) internal view returns (bytes memory) {
        check(left);
        check(right);
        return Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(4), tree, left, right));
    }

    function queryBlock(bytes memory state, uint32 counter) internal view returns (bytes memory) {
        check(state);
        return Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(5), state, counter));
    }

    function sessionKey(bytes memory context, bytes memory header) internal view returns (bytes memory) {
        return Blake2b512.digest(abi.encodePacked(DOMAIN, uint8(6), start(context), header));
    }
}
