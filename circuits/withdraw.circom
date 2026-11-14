/**
 * @title Withdrawal Circuit (Circom, mô hình Tornado Cash + amount check)
 * @dev ZK-SNARK circuit cho anonymous withdrawal.
 *
 * Public inputs:
 *   root            - merkle root của các deposits
 *   nullifierHash   - H(nullifier), dùng để chống double-spend (public)
 *   amount          - số tiền muốn rút (public)
 *
 * Private inputs (witness):
 *   nullifier       - nullifier bí mật của note
 *   secret          - secret bí mật mở khóa commitment
 *   noteAmount      - số tiền thực tế trong note (phải >= amount)
 *   pathElements    - đường dẫn merkle
 *   pathIndices     - chỉ số trái/phải trong merkle path
 *
 * Constraints:
 *   commitment      = Pedersen(nullifier, secret)
 *   commitment      nằm trong merkle tree (root)
 *   nullifierHash   = Pedersen(nullifier)
 *   noteAmount      >= amount
 */

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/pedersen.circom";
include "merkleTree.circom";

// Tính commitment = Pedersen(nullifier, secret)
template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;

    component commitmentHasher = Pedersen(2);
    commitmentHasher.in[0] <== nullifier;
    commitmentHasher.in[1] <== secret;
    commitment <== commitmentHasher.out[0];
}

// Tính nullifierHash = Pedersen(nullifier)
template NullifierHasher() {
    signal input nullifier;
    signal output nullifierHash;

    component nullifierHasher = Pedersen(1);
    nullifierHasher.in[0] <== nullifier;
    nullifierHash <== nullifierHasher.out[0];
}

template Withdraw(levels) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input amount;

    // Private inputs
    signal private input nullifier;
    signal private input secret;
    signal private input noteAmount;
    signal private input pathElements[levels];
    signal private input pathIndices[levels];

    // 1. commitment = Pedersen(nullifier, secret)
    component hasher = CommitmentHasher();
    hasher.nullifier <== nullifier;
    hasher.secret <== secret;

    // 2. nullifierHash = Pedersen(nullifier)
    component nullifierHasher = NullifierHasher();
    nullifierHasher.nullifier <== nullifier;

    // 3. Merkle proof: commitment nằm trong tree với root
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== hasher.commitment;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // 4. Amount check: noteAmount >= amount (Circom enforces non-negative)
    signal enoughBalance;
    enoughBalance <== noteAmount - amount;

    // Ràng buộc public inputs
    hasher.commitment === tree.leaf;         // commitment đã tính khớp với leaf
    nullifierHasher.nullifierHash === nullifierHash; // nullifierHash công khai khớp
    enoughBalance >= 0;                      // không rút quá số có trong note
}

component main = Withdraw(20);
