// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset} from "../NativeAssets.sol";
import {NativeVault} from "../vault/NativeVault.sol";

/// @notice Local shielded TRX custody/exit on TRON; research only.
contract TronVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory evaluatorChunks)
        NativeVault(NativeAsset.TRX, prepare, walk, evaluatorChunks) {}
}
