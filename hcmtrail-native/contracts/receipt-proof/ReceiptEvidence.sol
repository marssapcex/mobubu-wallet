// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// v1 | header count | node count | tx index (u32 BE) | receipt-local log index (u16 BE)
///    | each header as u16 size + RLP | each hashed trie node as u16 size + RLP.
/// No dynamic ABI offsets, witness signatures or user-supplied root in the evidence.
library ReceiptEvidence {
    uint256 internal constant PREFIX_BYTES = 9;
    uint256 internal constant MAX_BYTES = 65_535;
    uint256 internal constant MAX_HEADERS = 33;
    uint256 internal constant MAX_HEADER_BYTES = 4096;
    uint256 internal constant MAX_NODES = 11; // 10 nibbles in RLP(uint32) + leaf
    uint256 internal constant MAX_NODE_BYTES = 32_768;
    uint256 internal constant MAX_LOG_INDEX = 255;

    struct Shape { uint8 headers; uint8 nodes; uint32 txIndex; uint16 logIndex; }
    error BadEvidence();

    function read(bytes calldata raw) internal pure returns (Shape memory s) {
        if (raw.length < PREFIX_BYTES || raw.length > MAX_BYTES || raw[0] != 0x01) revert BadEvidence();
        s.headers = uint8(raw[1]);
        s.nodes = uint8(raw[2]);
        for (uint256 i = 3; i < 7; ++i) s.txIndex = s.txIndex * 256 + uint8(raw[i]);
        s.logIndex = uint16(uint8(raw[7])) * 256 + uint8(raw[8]);
        if (s.headers == 0 || s.headers > MAX_HEADERS || s.nodes == 0 || s.nodes > MAX_NODES
            || s.logIndex > MAX_LOG_INDEX) revert BadEvidence();
    }

    function frame(bytes calldata raw, uint256 at, uint256 max)
        internal pure returns (bytes calldata item, uint256 next)
    {
        if (at > raw.length || raw.length - at < 2) revert BadEvidence();
        uint256 size = uint256(uint8(raw[at])) * 256 + uint8(raw[at + 1]);
        at += 2;
        if (size == 0 || size > max || size > raw.length - at) revert BadEvidence();
        next = at + size;
        item = raw[at:next];
    }
}
