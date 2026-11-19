// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset} from "../NativeAssets.sol";
import {NativeVault} from "../vault/NativeVault.sol";

/// @notice Local shielded HYPE custody/exit on HyperEVM; research only.
contract HyperEvmVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory evaluatorChunks)
        NativeVault(NativeAsset.HYPE, prepare, walk, evaluatorChunks) {}
}
