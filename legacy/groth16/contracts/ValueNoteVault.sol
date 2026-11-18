// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidon2, MerkleTree} from "./lib/MerkleTree.sol";

/// @dev Verifier generated from circuits/spendNote.circom, not withdraw.circom.
interface INoteSpendVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[6] calldata publicSignals
    ) external view returns (bool);
}

/// @notice Local research vault for arbitrary native amounts and one change note.
/// It cannot authorize a payout on another chain. Do not fund with real money.
contract ValueNoteVault {
    using MerkleTree for MerkleTree.Tree;

    uint256 public constant SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant AMOUNT_LIMIT = 1 << 128;
    bytes32 public constant DOMAIN_TAG = keccak256("mobubu-native-value-v3");

    IPoseidon2 public immutable hasher;
    INoteSpendVerifier public immutable verifier;
    uint256 public immutable domain;
    uint256 public immutable deploymentChainId;
    mapping(uint256 => bool) public commitments;
    mapping(uint256 => bool) public spentNullifiers;
    uint256 public totalLocked;
    MerkleTree.Tree private tree;
    bool private withdrawing;

    error InvalidConfiguration();
    error WrongChain();
    error InvalidDeposit();
    error InvalidCommitment();
    error DuplicateCommitment();
    error InvalidWithdrawal();
    error UnknownRoot();
    error NullifierSpent();
    error InvalidProof();
    error ReentrantWithdrawal();
    error NativeTransferFailed();

    /// @dev Shared index stream: both deposits and change append to the tree.
    event NoteInserted(uint256 indexed commitment, uint32 indexed leafIndex, uint256 root);
    event Withdrawal(uint256 indexed nullifierHash, address indexed recipient, uint256 amount);

    constructor(IPoseidon2 poseidon, INoteSpendVerifier spendVerifier) {
        if (address(poseidon).code.length == 0 || address(spendVerifier).code.length == 0) {
            revert InvalidConfiguration();
        }
        hasher = poseidon;
        verifier = spendVerifier;
        deploymentChainId = block.chainid;
        domain = uint256(keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this)))) % SCALAR_FIELD;
        tree.initialize(poseidon);
    }

    function latestRoot() external view returns (uint256) { return tree.roots[tree.rootIndex]; }
    function leafCount() external view returns (uint32) { return tree.leafCount; }
    function isKnownRoot(uint256 root) external view returns (bool) { return tree.isKnownRoot(root); }

    function deposit(uint256 noteKey) external payable {
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (noteKey == 0 || noteKey >= SCALAR_FIELD || msg.value == 0 || msg.value >= AMOUNT_LIMIT) {
            revert InvalidDeposit();
        }
        // Bind the leaf to actual value received. Never accept the depositor's
        // claim about the note value (or a fully formed leaf) as input.
        _insert(hasher.poseidon([noteKey, msg.value]));
        totalLocked += msg.value;
    }

    function withdraw(
        address payable recipient,
        uint256 amount,
        uint256 root,
        uint256 nullifierHash,
        uint256 changeCommitment,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (withdrawing) revert ReentrantWithdrawal();
        if (recipient == address(0) || amount == 0 || amount >= AMOUNT_LIMIT || amount > totalLocked ||
            nullifierHash == 0 || nullifierHash >= SCALAR_FIELD || changeCommitment >= SCALAR_FIELD) {
            revert InvalidWithdrawal();
        }
        if (spentNullifiers[nullifierHash]) revert NullifierSpent();
        if (!tree.isKnownRoot(root)) revert UnknownRoot();
        if (!verifier.verifyProof(a, b, c, [
            root, nullifierHash, uint256(uint160(address(recipient))), amount, changeCommitment, domain
        ])) revert InvalidProof();

        spentNullifiers[nullifierHash] = true;
        totalLocked -= amount;
        if (changeCommitment != 0) _insert(changeCommitment);
        withdrawing = true;
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert NativeTransferFailed(); // Rolls back note, change, and accounting.
        withdrawing = false;
        emit Withdrawal(nullifierHash, recipient, amount);
    }

    function _insert(uint256 commitment) private {
        if (commitment == 0 || commitment >= SCALAR_FIELD) revert InvalidCommitment();
        if (commitments[commitment]) revert DuplicateCommitment();
        commitments[commitment] = true;
        (uint32 index, uint256 root) = tree.insert(hasher, commitment);
        emit NoteInserted(commitment, index, root);
    }
}
