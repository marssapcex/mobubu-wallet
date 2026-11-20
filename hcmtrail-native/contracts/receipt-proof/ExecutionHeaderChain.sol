// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReceiptEvidence} from "./ReceiptEvidence.sol";
import {StrictRlp} from "./StrictRlp.sol";

/// @dev Derive a receipt root from an authenticated *execution* checkpoint and its ancestors.
/// Does not choose the checkpoint or verify Beacon/Parlia consensus.
library ExecutionHeaderChain {
    struct Anchor { uint64 height; bytes32 hash; bytes32 genesis; }
    error NotCheckpointAncestor();

    function receiptsRoot(bytes calldata proof, uint8 headers, Anchor memory anchor)
        internal pure returns (bytes32 root, uint256 next)
    {
        next = ReceiptEvidence.PREFIX_BYTES;
        if (uint256(headers) > uint256(anchor.height) + 1) revert NotCheckpointAncestor();
        for (uint256 i; i < headers; ++i) {
            bytes calldata header;
            (header, next) = ReceiptEvidence.frame(proof, next, ReceiptEvidence.MAX_HEADER_BYTES);
            if (keccak256(header) != anchor.hash || (anchor.height == 0 && anchor.hash != anchor.genesis)) {
                revert NotCheckpointAncestor();
            }
            (StrictRlp.Item[] memory items, uint256 n) = StrictRlp.children(header, StrictRlp.root(header), 21);
            // Standard execution fields are at fixed positions through the supported EVM header formats.
            if (n < 15 || StrictRlp.integer64(header, items[8]) != anchor.height) revert NotCheckpointAncestor();
            if (i + 1 == headers) return (StrictRlp.word(header, items[5]), next);
            anchor = Anchor(anchor.height - 1, StrictRlp.word(header, items[0]), anchor.genesis);
        }
        revert NotCheckpointAncestor();
    }
}
