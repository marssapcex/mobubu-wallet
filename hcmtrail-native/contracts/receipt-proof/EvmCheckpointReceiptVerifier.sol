// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IFinalizedEvents} from "../crosschain/WithdrawalTerms.sol";
import {ReceiptEvidence} from "./ReceiptEvidence.sol";
import {ExecutionHeaderChain} from "./ExecutionHeaderChain.sol";
import {ExecutionReceiptTrie} from "./ExecutionReceiptTrie.sol";
import {SettlementReceipt} from "./SettlementReceipt.sol";

/// @notice Historical proof experiment for Sepolia <-> BSC Testnet, not a consensus light client.
/// @dev The checkpoint is trusted at construction and cannot advance. No witness keys, owner, or updates.
/// This contract cannot establish that the deployer's checkpoint is canonical or finalized. Do not use
/// it to authorize custody. The existing CrosschainNoteVault / CrosschainLiquidity reject this adapter.
contract EvmCheckpointReceiptVerifier is IFinalizedEvents {
    uint256 public immutable localChain;
    uint256 public immutable remoteChain;
    bytes32 public immutable remoteGenesis;
    uint64 public immutable checkpointHeight;
    bytes32 public immutable checkpointHash;
    address public immutable remoteEmitter;
    address public immutable localConsumer;
    uint8 public immutable kindMask; // bit (kind - 1), kinds 1 to 4

    error BadCheckpointRoute();

    constructor(uint256 fromChain, bytes32 genesis, uint64 height, bytes32 checkpoint,
        address emitter, address consumer, uint8 kinds)
    {
        if (!((block.chainid == 11155111 && fromChain == 97) || (block.chainid == 97 && fromChain == 11155111))
            || genesis == bytes32(0) || checkpoint == bytes32(0) || (height == 0 && checkpoint != genesis)
            || emitter == address(0) || consumer == address(0) || kinds == 0 || kinds > 15) revert BadCheckpointRoute();
        localChain = block.chainid;
        remoteChain = fromChain;
        remoteGenesis = genesis;
        checkpointHeight = height;
        checkpointHash = checkpoint;
        remoteEmitter = emitter;
        localConsumer = consumer;
        kindMask = kinds;
    }

    function proves(uint256 chain, address emitter, uint8 kind, bytes32 order, bytes32 data, bytes calldata proof)
        external view returns (bool)
    {
        if (block.chainid != localChain || chain != remoteChain || emitter != remoteEmitter || msg.sender != localConsumer
            || kind == 0 || kind > 4 || (kindMask & (uint8(1) << (kind - 1))) == 0 || order == bytes32(0)
            || ((kind == 1 || kind == 4) && data != bytes32(0))) return false;
        return _verify(SettlementReceipt.Claim(emitter, kind, order, data), proof);
    }

    function _verify(SettlementReceipt.Claim memory claim, bytes calldata proof) private view returns (bool) {
        ReceiptEvidence.Shape memory s = ReceiptEvidence.read(proof);
        (bytes32 root, uint256 pos) = ExecutionHeaderChain.receiptsRoot(proof, s.headers,
            ExecutionHeaderChain.Anchor(checkpointHeight, checkpointHash, remoteGenesis));
        bytes calldata receipt = ExecutionReceiptTrie.value(proof, pos, root, s.txIndex, s.nodes);
        return SettlementReceipt.matches(receipt, s.logIndex, claim);
    }
}
