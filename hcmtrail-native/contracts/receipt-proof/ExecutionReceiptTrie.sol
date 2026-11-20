// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReceiptEvidence} from "./ReceiptEvidence.sol";
import {StrictRlp} from "./StrictRlp.sol";

/// @dev EVM receipt trie, not a generic state/storage trie. No secure key hashing: key = RLP(txIndex).
/// Every receipt has a 256-byte bloom, so populated leaves and all their ancestors are >= 32 bytes.
/// Children on an inclusion path are therefore hash references, never embedded small nodes.
library ExecutionReceiptTrie {
    error InvalidReceiptPath();

    struct Walk { uint256 cursor; uint256 left; uint256 depth; bytes32 hash; }

    function value(bytes calldata proof, uint256 cursor, bytes32 root, uint32 index, uint8 count)
        internal pure returns (bytes calldata receipt)
    {
        if (root == bytes32(0)) revert InvalidReceiptPath();
        bytes memory key = _key(index);
        Walk memory w = Walk(cursor, count, 0, root);
        while (w.left != 0) {
            --w.left;
            bytes calldata node;
            (node, w.cursor) = ReceiptEvidence.frame(proof, w.cursor, ReceiptEvidence.MAX_NODE_BYTES);
            if (node.length < 32 || keccak256(node) != w.hash) revert InvalidReceiptPath();
            StrictRlp.Item memory next;
            bool done;
            (w.depth, next, done) = _next(node, key, w.depth);
            if (done) {
                if (w.left != 0 || w.cursor != proof.length) revert InvalidReceiptPath();
                return StrictRlp.payload(node, next);
            }
            w.hash = StrictRlp.word(node, next);
        }
        revert InvalidReceiptPath();
    }

    function _next(bytes calldata node, bytes memory key, uint256 depth)
        private pure returns (uint256, StrictRlp.Item memory, bool)
    {
        (StrictRlp.Item[] memory c, uint256 n) = StrictRlp.children(node, StrictRlp.root(node), 17);
        if (n == 17) {
            if (depth == key.length * 2) return (depth, c[16], true);
            return (depth + 1, c[_nibble(key, depth)], false);
        }
        if (n != 2) revert InvalidReceiptPath();
        (uint256 afterPath, bool leaf) = _match(StrictRlp.payload(node, c[0]), key, depth);
        return (afterPath, c[1], leaf);
    }

    function _key(uint32 index) private pure returns (bytes memory key) {
        if (index == 0) return hex"80";
        if (index < 128) return abi.encodePacked(uint8(index));
        uint256 n = 0;
        for (uint256 x = index; x != 0; x >>= 8) ++n;
        key = new bytes(n + 1);
        key[0] = bytes1(uint8(0x80 + n));
        for (uint256 i; i < n; ++i) key[n - i] = bytes1(uint8(index >> (i * 8)));
    }

    function _nibble(bytes memory b, uint256 at) private pure returns (uint8) {
        uint8 x = uint8(b[at / 2]);
        return at % 2 == 0 ? x >> 4 : x & 15;
    }

    function _match(bytes calldata path, bytes memory key, uint256 depth) private pure returns (uint256, bool leaf) {
        if (path.length == 0) revert InvalidReceiptPath();
        uint8 head = uint8(path[0]);
        uint8 flags = head >> 4;
        if (flags > 3 || ((flags & 1) == 0 && (head & 15) != 0)) revert InvalidReceiptPath();
        leaf = flags >= 2;
        uint256 start = (flags & 1) == 0 ? 2 : 1;
        uint256 length = path.length * 2 - start;
        uint256 end = depth + length;
        if (end > key.length * 2 || (leaf ? end != key.length * 2 : length == 0)) revert InvalidReceiptPath();
        for (uint256 i; i < length; ++i) {
            uint256 pos = start + i;
            uint8 b = uint8(path[pos / 2]);
            if ((pos % 2 == 0 ? b >> 4 : b & 15) != _nibble(key, depth + i)) revert InvalidReceiptPath();
        }
        return (end, leaf);
    }

}
