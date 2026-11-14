// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MerkleTree
 * @dev Merkle tree on-chain cho AnonymousVault.
 *      Lưu leaves (commitments), tính root, xác minh inclusion proof.
 *      Hash dùng keccak256 (thay bằng Poseidon precompile khi có).
 */
library MerkleTree {
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant ZERO_VALUE = 0;

    /**
     * @dev Tính Merkle root từ mảng leaves.
     */
    function computeRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "MT: empty leaves");
        require(
            leaves.length <= (1 << TREE_DEPTH),
            "MT: too many leaves"
        );

        bytes32[] memory tree = new bytes32[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            tree[i] = leaves[i];
        }

        uint256 size = leaves.length;
        while (size > 1) {
            uint256 newSize = (size + 1) / 2;
            for (uint256 i = 0; i < newSize; i++) {
                bytes32 left = tree[2 * i];
                bytes32 right = (2 * i + 1 < size) ? tree[2 * i + 1] : ZERO_VALUE;
                tree[i] = keccak256(abi.encodePacked(left, right));
            }
            size = newSize;
        }
        return tree[0];
    }

    /**
     * @dev Xác minh inclusion proof: leaf + pathElements + pathIndices -> root.
     *      pathIndices[i] = 0 nếu pathElements[i] ở bên trái, 1 nếu ở bên phải.
     */
    function verifyProof(
        bytes32 leaf,
        bytes32 root,
        bytes32[] calldata pathElements,
        uint256[] calldata pathIndices
    ) internal pure returns (bool) {
        require(pathElements.length == pathIndices.length, "MT: path mismatch");
        require(pathElements.length == TREE_DEPTH, "MT: wrong depth");

        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < pathElements.length; i++) {
            if (pathIndices[i] == 0) {
                computedHash = keccak256(abi.encodePacked(computedHash, pathElements[i]));
            } else {
                computedHash = keccak256(abi.encodePacked(pathElements[i], computedHash));
            }
        }
        return computedHash == root;
    }

    /**
     * @dev Hash đơn giản cho commitment (thay bằng Poseidon precompile khi có).
     */
    function hashCommitment(bytes32 nullifier, bytes32 secret) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nullifier, secret));
    }

    function hashNullifier(bytes32 nullifier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nullifier, 0));
    }
}
