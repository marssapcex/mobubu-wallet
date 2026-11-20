// SPDX-License-Identifier: ISC
pragma solidity 0.8.24;

/// @notice FIPS 205 SLH-DSA-SHA2-128s signature verification (n=16, h=63,
/// d=7, h'=9, a=12, k=14, lg w=4, m=30). Uses only Ethereum's SHA-256.
/// @dev The vault uses pure SLH-DSA with empty context. This is not
/// HashSLH-DSA. No keygen or signing is done on-chain.
library SlhDsaSha2_128s {
    uint256 internal constant SIGNATURE_BYTES = 7856;

    function verify(bytes32 key, bytes memory message, bytes calldata signature) internal view returns (bool) {
        return verifyInternal(key, abi.encodePacked(bytes2(0), message), signature);
    }

    /// @dev FIPS 205 Algorithm 20 takes the already formatted M'. The
    /// public vault never accepts M' from callers. Also used with ACVP vectors.
    function verifyInternal(bytes32 key, bytes memory messagePrime, bytes calldata signature)
        internal view returns (bool valid)
    {
        if (signature.length != SIGNATURE_BYTES) return false;
        bytes16 r = bytes16(signature[:16]);
        // H_msg for SHA2-128s: MGF1-SHA256 with counter 0; 30 of 32 bytes used.
        bytes32 digest = sha256(abi.encodePacked(
            r, bytes16(key), sha256(abi.encodePacked(r, key, messagePrime)), uint32(0)
        ));

        assembly ("memory-safe") {
            // Values of size n are the low 128 bits on the stack. ADRS_c is
            // the low 176: layer[1] | tree[8] | type[1] | keypair[4] |
            // chain/height[4] | hash/index[4], in big-endian order.
            function readN(pos) -> v { v := shr(128, calldataload(pos)) }
            function hashN(buf, len, out) -> v {
                let ok := staticcall(gas(), 2, buf, len, out, 32)
                if iszero(and(ok, eq(returndatasize(), 32))) { revert(0, 0) }
                v := shr(128, mload(out))
            }
            function nodeAddress(buf, adrs) { mstore(add(buf, 64), shl(80, adrs)) }
            function f(buf, adrs, value, out) -> v {
                nodeAddress(buf, adrs)
                mstore(add(buf, 86), shl(128, value))
                v := hashN(buf, 102, out)
            }
            // FIPS algorithms 11 and 17: combine an authentication path,
            // using tree-global indices for FORS and local indices for XMSS.
            function path(buf, out, adrs, index, value, pos, depth) -> v {
                v := value
                for { let height := 1 } iszero(gt(height, depth)) { height := add(height, 1) } {
                    let sibling := readN(pos)
                    pos := add(pos, 16)
                    let pair := or(shl(128, v), sibling)
                    if and(index, 1) { pair := or(shl(128, sibling), v) }
                    index := shr(1, index)
                    nodeAddress(buf, or(adrs, or(shl(32, height), index)))
                    mstore(add(buf, 86), pair)
                    v := hashN(buf, 118, out)
                }
            }
            // FORS public key from the fourteen signed leaves and paths.
            function fors(buf, accum, out, digest_, base, pos) -> v {
                nodeAddress(accum, or(base, shl(96, 4))) // FORS_ROOTS
                for { let i := 0 } lt(i, 14) { i := add(i, 1) } {
                    let idx := or(shl(12, i), and(shr(sub(244, mul(12, i)), digest_), 4095))
                    let adrs := or(base, shl(96, 3)) // FORS_TREE
                    let node := f(buf, or(adrs, idx), readN(pos), out)
                    node := path(buf, out, adrs, idx, node, add(pos, 16), 12)
                    mstore(add(add(accum, 86), shl(4, i)), shl(128, node))
                    pos := add(pos, 208) // n * (1 + a)
                }
                v := hashN(accum, 310, out) // 64 + 22 + (14 * 16)
            }
            // WOTS+ pkFromSig: 32 message digits then three checksum digits.
            function wots(buf, accum, out, base, msg_, pos) -> v {
                nodeAddress(accum, or(base, shl(96, 1))) // WOTS_PK; last words zero
                let checksum := 0
                for { let i := 0 } lt(i, 35) { i := add(i, 1) } {
                    let digit
                    switch lt(i, 32)
                    case 1 {
                        digit := and(shr(shl(2, sub(31, i)), msg_), 15)
                        checksum := add(checksum, sub(15, digit))
                    }
                    default { digit := and(shr(shl(2, sub(34, i)), checksum), 15) }
                    let node := readN(pos)
                    pos := add(pos, 16)
                    let adrs := or(base, shl(32, i)) // WOTS_HASH (type 0)
                    for { let j := digit } lt(j, 15) { j := add(j, 1) } {
                        node := f(buf, or(adrs, j), node, out)
                    }
                    mstore(add(add(accum, 86), shl(4, i)), shl(128, node))
                }
                v := hashN(accum, 646, out) // 64 + 22 + (35 * 16)
            }

            // Two disjoint hash buffers let path/chain hashing leave the
            // accumulated roots alone. Each buffer is seeded with PK.seed
            // and zeros up to its 64-byte prefix. Largest write ends at 662.
            let buf := mload(0x40)
            let accum := add(buf, 704)
            let out := add(accum, 704)
            mstore(0x40, add(out, 32))
            let seed := shl(128, shr(128, key))
            mstore(buf, seed)
            mstore(add(buf, 32), 0)
            mstore(accum, seed)
            mstore(add(accum, 32), 0)

            // digest = md[21] || idx_tree[7] || idx_leaf[2] || unused[2].
            let tree := and(shr(32, digest), sub(shl(54, 1), 1))
            let leaf := and(shr(16, digest), 511)
            let pos := add(signature.offset, 16)
            let root := fors(buf, accum, out, digest, or(shl(104, tree), shl(64, leaf)), pos)
            pos := add(pos, 2912) // k * n * (1 + a)
            for { let layer := 0 } lt(layer, 7) { layer := add(layer, 1) } {
                let subtree := or(shl(168, layer), shl(104, tree))
                root := wots(buf, accum, out, or(subtree, shl(64, leaf)), root, pos)
                pos := add(pos, 560) // WOTS: len * n
                root := path(buf, out, or(subtree, shl(96, 2)), leaf, root, pos, 9) // TREE
                pos := add(pos, 144) // h' * n
                leaf := and(tree, 511)
                tree := shr(9, tree)
            }
            valid := eq(root, and(key, sub(shl(128, 1), 1)))
        }
    }
}
