// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset} from "../NativeAssets.sol";
import {NativeVault} from "../vault/NativeVault.sol";

/// Four separate deployments; each is locked to its testnet, currency and pinned STARK stack.
/// No configurable fallback chain, verifier, admin, or wrapped asset. Test funds only.
contract SepoliaVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory chunks)
        NativeVault(NativeAsset.ETH, 11155111, prepare, walk, chunks) {}
}

contract BscTestnetVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory chunks)
        NativeVault(NativeAsset.BNB, 97, prepare, walk, chunks) {}
}

contract NileVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory chunks)
        NativeVault(NativeAsset.TRX, 0xcd8690dc, prepare, walk, chunks) {}
}

contract HyperEvmTestnetVault is NativeVault {
    constructor(address prepare, address walk, address[3] memory chunks)
        NativeVault(NativeAsset.HYPE, 998, prepare, walk, chunks) {}
}
