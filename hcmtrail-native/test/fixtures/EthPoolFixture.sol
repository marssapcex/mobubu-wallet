// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoseidonGoldilocks} from "../../contracts/vendor/nonos/PoseidonGoldilocks.sol";
import {EthPoolState} from "../../contracts/ethereum/EthPoolState.sol";
import {EthNetworkState, NetworkConfig} from "../../contracts/ethereum/EthNetworkState.sol";

/// FAKE proofs, for state/gas tests only. Not compiled into the preview or production artifacts.
contract EthPoolHarness is EthPoolState {
    error WrongTestProof();
    constructor(address token) EthPoolState(block.chainid, bytes32(uint256(1)), new PoseidonGoldilocks(), token) {}
    function _verifyNote(bytes calldata proof, uint256[] memory words) internal pure override {
        if (proof.length != 32 || bytes32(proof) != keccak256(abi.encode(words))) revert WrongTestProof();
    }
}

contract RejectEth {
    bool private reject = true;
    function accept() external { reject = false; }
    receive() external payable { require(!reject); }
}

/// Routing/accounting fixture; not present in the preview or emitted pool build.
contract EthNetworkHarness is EthNetworkState {
    error WrongTestProof();
    constructor(address token, NetworkConfig memory cfg)
        EthPoolState(block.chainid, bytes32(uint256(1)), new PoseidonGoldilocks(), token) EthNetworkState(cfg) {}
    function _verifyNote(bytes calldata proof, uint256[] memory words) internal pure override {
        if (proof.length != 32 || bytes32(proof) != keccak256(abi.encode(words))) revert WrongTestProof();
    }
}
