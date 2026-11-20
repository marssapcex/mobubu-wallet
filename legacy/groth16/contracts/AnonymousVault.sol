// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWithdrawalVerifier} from "./WithdrawalVerifier.sol";
import {IPoseidon2, MerkleTree} from "./lib/MerkleTree.sol";

/// @notice Research vault: one native asset, one denomination, one EVM network.
/// Do not fund a deployment without independently audited bytecode and ceremony.
contract AnonymousVault {
    using MerkleTree for MerkleTree.Tree;

    uint256 public constant SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant TREE_DEPTH = MerkleTree.DEPTH;
    uint256 public constant ROOT_HISTORY = MerkleTree.ROOT_HISTORY;
    bytes32 public constant DOMAIN_TAG = keccak256("mobubu-native-vault-v2");

    IWithdrawalVerifier public immutable verifier;
    IPoseidon2 public immutable hasher;
    uint256 public immutable denomination;
    uint256 public immutable domain;
    uint256 public immutable deploymentChainId;

    mapping(uint256 => bool) public depositedCommitments;
    mapping(uint256 => bool) public spentNullifiers;
    uint256 public totalLocked;
    MerkleTree.Tree private tree;
    bool private withdrawing;

    error InvalidConfiguration();
    error WrongChain();
    error IncorrectDepositValue();
    error InvalidCommitment();
    error DuplicateCommitment();
    error InvalidWithdrawal();
    error UnknownRoot();
    error NullifierSpent();
    error InvalidProof();
    error ReentrantWithdrawal();
    error NativeTransferFailed();

    event Deposit(uint256 indexed commitment, uint32 indexed leafIndex, uint256 root);
    event Withdrawal(uint256 indexed nullifierHash, address indexed recipient);

    constructor(uint256 noteValue, IPoseidon2 poseidon, IWithdrawalVerifier groth16Verifier) {
        if (noteValue == 0 || address(poseidon).code.length == 0 || address(groth16Verifier).code.length == 0) {
            revert InvalidConfiguration();
        }
        denomination = noteValue;
        hasher = poseidon;
        verifier = groth16Verifier;
        deploymentChainId = block.chainid;
        domain = uint256(keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), noteValue))) % SCALAR_FIELD;
        tree.initialize(poseidon);
    }

    function latestRoot() external view returns (uint256) {
        return tree.roots[tree.rootIndex];
    }

    function leafCount() external view returns (uint32) {
        return tree.leafCount;
    }

    function isKnownRoot(uint256 root) external view returns (bool) {
        return tree.isKnownRoot(root);
    }

    function deposit(uint256 commitment) external payable {
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (msg.value != denomination) revert IncorrectDepositValue();
        if (commitment == 0 || commitment >= SCALAR_FIELD) revert InvalidCommitment();
        if (depositedCommitments[commitment]) revert DuplicateCommitment();

        depositedCommitments[commitment] = true;
        totalLocked += denomination;
        (uint32 index, uint256 root) = tree.insert(hasher, commitment);
        emit Deposit(commitment, index, root);
    }

    function withdraw(
        address payable recipient,
        uint256 root,
        uint256 nullifierHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        if (block.chainid != deploymentChainId) revert WrongChain();
        if (withdrawing) revert ReentrantWithdrawal();
        if (recipient == address(0) || nullifierHash == 0 || nullifierHash >= SCALAR_FIELD || totalLocked < denomination) {
            revert InvalidWithdrawal();
        }
        if (spentNullifiers[nullifierHash]) revert NullifierSpent();
        if (!tree.isKnownRoot(root)) revert UnknownRoot();
        if (!verifier.verifyProof(a, b, c, [root, nullifierHash, uint256(uint160(address(recipient))), domain])) {
            revert InvalidProof();
        }

        // No commitment disclosed or accepted on withdrawal. A reverting
        // recipient rolls back both the transfer and all spent bookkeeping.
        spentNullifiers[nullifierHash] = true;
        totalLocked -= denomination;
        withdrawing = true;
        (bool sent,) = recipient.call{value: denomination}("");
        if (!sent) revert NativeTransferFailed();
        withdrawing = false;
        emit Withdrawal(nullifierHash, recipient);
    }
}
