// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset, NativeAssets} from "../NativeAssets.sol";
import {NativeVault} from "../vault/NativeVault.sol";

/// @notice Local shielded BNB custody/exit on BNB Smart Chain; research only.
contract BscVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory evaluatorChunks)
        NativeVault(NativeAsset.BNB, NativeAssets.chainId(NativeAsset.BNB), prepare, walk, evaluatorChunks) {}
}
