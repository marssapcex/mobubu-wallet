// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolState, EthPoolVerified} from "./EthPoolState.sol";
import {EthNetworkState, NetworkConfig} from "./EthNetworkState.sol";
import {NativeStark} from "../vault/NativeStark.sol";

/// @notice Identical pool code on the three lab lanes; no public-chain deployment.
contract EthShieldedPool is EthPoolVerified, EthNetworkState {
    constructor(uint256 chainId_, address stakeToken, address hasher, address prepare, address walk, address evaluator,
        NetworkConfig memory network)
        NativeStark(prepare, walk, evaluator)
        EthPoolState(_local(chainId_), STARK_IMAGE, _pinnedHasher(hasher), stakeToken)
        EthNetworkState(network) {}

    function _local(uint256 chainId_) private view returns (uint256) {
        if (chainId_ != block.chainid || chainId_ < 31337 || chainId_ > 31339) revert LegacyProfileLocalOnly();
        return chainId_;
    }
}
