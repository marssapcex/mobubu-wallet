// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";
import {PoseidonGoldilocks} from "../vendor/nonos/PoseidonGoldilocks.sol";
import {NativeNoteTree} from "./NativeNoteTree.sol";

struct DepositNote {
    uint64 amount;
    bytes32 ownerCommit;
}

/// @dev A proof amount is a field element; a vault balance is not. Split a large
/// deposit into independently spendable notes without truncating or reducing any amount.
abstract contract NativeNoteDepositsCore is NativeNoteTree {
    uint256 private constant NOTE_DOMAIN = 0x4e4f5445;
    uint8 public constant asset = 0; // ETH, the only supported native asset

    event Deposited(uint64 indexed index, bytes32 indexed note, uint256 amount);
    event DepositBatch(uint64 indexed firstIndex, uint256 count, uint256 gross, uint256 net);
    error InvalidAmount();
    error InvalidCommitment();

    constructor(bytes32 domain_, PoseidonGoldilocks hasher) NativeNoteTree(domain_, hasher) {}

    function maxNoteValue() public pure returns (uint256) {
        return Goldilocks.MAX_VALUE;
    }

    function commitment(uint256 amount, bytes32 ownerCommit) public view returns (bytes32 note) {
        if (amount == 0 || amount > maxNoteValue()) revert InvalidAmount();
        if (ownerCommit == bytes32(0) || !Goldilocks.isCanonicalDigest(ownerCommit)) revert InvalidCommitment();
        uint256 header = uint32(amount) | ((amount >> 32) << 64) | (uint256(asset) << 128) | (NOTE_DOMAIN << 192);
        note = poseidon.hash2(bytes32(header), ownerCommit);
        if (note == bytes32(0) || note == domainLeaf) revert InvalidCommitment();
    }

    function _depositNote(uint256 value, bytes32 ownerCommit) internal returns (uint64 index, bytes32 note) {
        note = commitment(value, ownerCommit);
        index = _append(note, bytes32(0), false);
        emit Deposited(index, note, value);
    }

    /// @dev Apply the fee once before splitting; every unit of net funding must be attributed.
    function _depositNotes(uint256 net, DepositNote[] calldata notes) internal returns (uint64 firstIndex) {
        uint256 n = notes.length;
        firstIndex = leafCount;
        if (n == 0 || net == 0) revert InvalidAmount();
        if (uint256(firstIndex) + n > (uint256(1) << TREE_DEPTH)) revert NoteTreeFull();
        uint256 left = net;
        for (uint256 i; i < n; ++i) {
            uint256 value = notes[i].amount;
            if (value == 0 || value > maxNoteValue() || value > left) revert InvalidAmount();
            left -= value;
        }
        if (left != 0) revert InvalidAmount();
        // Pair adjacent leaves so each pair publishes only one root and uses one full depth walk.
        for (uint256 i; i + 1 < n; i += 2) {
            DepositNote calldata a = notes[i];
            DepositNote calldata b = notes[i + 1];
            bytes32 first = commitment(a.amount, a.ownerCommit);
            bytes32 second = commitment(b.amount, b.ownerCommit);
            uint64 index = _append(first, second, true);
            emit Deposited(index, first, a.amount);
            emit Deposited(index + 1, second, b.amount);
        }
        if (n % 2 != 0) _depositNote(notes[n - 1].amount, notes[n - 1].ownerCommit);
        emit DepositBatch(firstIndex, n, msg.value, net);
    }
}
