// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Matches circomlib Poseidon(2) over the BN254 scalar field.
interface IPoseidon2 {
    function poseidon(uint256[2] calldata input) external view returns (uint256);
}

/// @dev Fixed-depth incremental tree. Stores the frontier, empty subtrees,
/// and a rotating window of roots, not every leaf. Leaves are indexed by logs.
library MerkleTree {
    uint256 internal constant DEPTH = 20;
    uint256 internal constant ROOT_HISTORY = 32;

    error TreeFull();

    struct Tree {
        uint32 leafCount;
        uint8 rootIndex;
        uint256[DEPTH] empty;
        uint256[DEPTH] frontier;
        uint256[ROOT_HISTORY] roots;
    }

    function initialize(Tree storage tree, IPoseidon2 hasher) internal {
        uint256 zero;
        for (uint256 i; i < DEPTH; ++i) {
            tree.empty[i] = zero;
            zero = hasher.poseidon([zero, zero]);
        }
        tree.roots[0] = zero;
    }

    function insert(Tree storage tree, IPoseidon2 hasher, uint256 leaf)
        internal returns (uint32 index, uint256 root)
    {
        index = tree.leafCount;
        if (index >= (1 << DEPTH)) revert TreeFull();
        uint256 path = index;
        root = leaf;
        for (uint256 i; i < DEPTH; ++i) {
            if (path & 1 == 0) {
                tree.frontier[i] = root;
                root = hasher.poseidon([root, tree.empty[i]]);
            } else {
                root = hasher.poseidon([tree.frontier[i], root]);
            }
            path >>= 1;
        }
        uint8 next = uint8((uint256(tree.rootIndex) + 1) % ROOT_HISTORY);
        tree.roots[next] = root;
        tree.rootIndex = next;
        tree.leafCount = index + 1;
    }

    function isKnownRoot(Tree storage tree, uint256 root) internal view returns (bool) {
        if (root == 0) return false;
        uint256 index = tree.rootIndex;
        for (uint256 i; i < ROOT_HISTORY; ++i) {
            if (tree.roots[index] == root) return true;
            index = index == 0 ? ROOT_HISTORY - 1 : index - 1;
        }
        return false;
    }
}
