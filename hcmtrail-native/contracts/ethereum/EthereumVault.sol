// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset, NativeAssets} from "../NativeAssets.sol";
import {NativeVault} from "../vault/NativeVault.sol";

/// @notice Local shielded ETH custody/exit on Ethereum; research only.
contract EthereumVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory evaluatorChunks)
        NativeVault(NativeAsset.ETH, NativeAssets.chainId(NativeAsset.ETH), prepare, walk, evaluatorChunks) {}
}
