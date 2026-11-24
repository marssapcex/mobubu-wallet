// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// RFC 7693 unkeyed BLAKE2b with a 64-byte digest, using the EIP-152 compression precompile.
/// The call fails closed on an environment without EIP-152. Ethereum research only.
library Blake2b512 {
    error CompressionFailed();

    function digest(bytes memory input) internal view returns (bytes memory out) {
        out = new bytes(64);
        bool ok;
        assembly ("memory-safe") {
            let work := mload(0x40)
            mstore(0x40, add(work, 256))
            // rounds=12 (BE u32); the IV XOR the parameter word 0x01010040 (LE u64 lanes).
            mstore(work, shl(224, 12))
            mstore(add(work, 4), 0x48c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5)
            mstore(add(work, 36), 0xd182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b)
            let size := mload(input)
            let done := 0
            let head := add(input, 32)
            let blockData := add(work, 68)
            let count := add(work, 196)
            // Always compress exactly one final block, including for empty input.
            for {} 1 {} {
                let take := sub(size, done)
                if gt(take, 128) { take := 128 }
                let src := add(head, done)
                for { let i := 0 } lt(i, 128) { i := add(i, 32) } {
                    let word := 0
                    if lt(i, take) {
                        word := mload(add(src, i))
                        let left := sub(take, i)
                        if lt(left, 32) { word := and(word, shl(mul(8, sub(32, left)), not(0))) }
                    }
                    mstore(add(blockData, i), word)
                }
                done := add(done, take)
                mstore(count, 0) // t1=0, t0=done as LE u64. Memory is much smaller than 2^64 bytes.
                for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                    mstore8(add(count, i), shr(mul(8, i), done))
                }
                let finalBlock := eq(done, size)
                mstore8(add(work, 212), finalBlock)
                ok := staticcall(gas(), 9, work, 213, add(work, 4), 64)
                ok := and(ok, eq(returndatasize(), 64))
                if iszero(ok) { break }
                if finalBlock { break }
            }
            mstore(add(out, 32), mload(add(work, 4)))
            mstore(add(out, 64), mload(add(work, 36)))
        }
        if (!ok) revert CompressionFailed();
    }
}
