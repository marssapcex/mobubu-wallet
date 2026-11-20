// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Canonical RLP envelopes over bounded calldata slices. Offsets are relative to `raw`.
library StrictRlp {
    struct Item { uint256 data; uint256 end; bool list; }
    error InvalidRlp();

    function at(bytes calldata raw, uint256 start, uint256 limit) internal pure returns (Item memory item) {
        if (start >= limit || limit > raw.length) revert InvalidRlp();
        uint8 prefix = uint8(raw[start]);
        if (prefix < 0x80) return Item(start, start + 1, false);
        bool list = prefix >= 0xc0;
        uint256 tag = prefix - (list ? 0xc0 : 0x80);
        uint256 data = start + 1;
        uint256 length = tag;
        if (tag >= 56) {
            uint256 width = tag - 55;
            if (width > limit - data || raw[data] == 0) revert InvalidRlp();
            length = 0;
            for (uint256 i; i < width; ++i) length = length * 256 + uint8(raw[data + i]);
            data += width;
            if (length < 56) revert InvalidRlp();
        }
        if (length > limit - data || (!list && length == 1 && uint8(raw[data]) < 0x80)) revert InvalidRlp();
        return Item(data, data + length, list);
    }

    function root(bytes calldata raw) internal pure returns (Item memory item) {
        item = at(raw, 0, raw.length);
        if (!item.list || item.end != raw.length) revert InvalidRlp();
    }

    function children(bytes calldata raw, Item memory list, uint256 max)
        internal pure returns (Item[] memory items, uint256 count)
    {
        if (!list.list) revert InvalidRlp();
        items = new Item[](max);
        for (uint256 pos = list.data; pos < list.end;) {
            if (count == max) revert InvalidRlp();
            Item memory item = at(raw, pos, list.end);
            items[count++] = item;
            pos = item.end;
        }
    }

    function payload(bytes calldata raw, Item memory item) internal pure returns (bytes calldata) {
        if (item.list) revert InvalidRlp();
        return raw[item.data:item.end];
    }

    function word(bytes calldata raw, Item memory item) internal pure returns (bytes32 out) {
        bytes calldata data = payload(raw, item);
        if (data.length != 32) revert InvalidRlp();
        assembly ("memory-safe") { out := calldataload(data.offset) }
    }

    function account(bytes calldata raw, Item memory item) internal pure returns (address out) {
        bytes calldata data = payload(raw, item);
        if (data.length != 20) revert InvalidRlp();
        assembly ("memory-safe") { out := shr(96, calldataload(data.offset)) }
    }

    function integer64(bytes calldata raw, Item memory item) internal pure returns (uint64 out) {
        bytes calldata data = payload(raw, item);
        if (data.length > 8 || (data.length != 0 && data[0] == 0)) revert InvalidRlp();
        for (uint256 i; i < data.length; ++i) out = out * 256 + uint8(data[i]);
    }
}
