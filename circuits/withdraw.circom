include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "./merkleTree.circom";

/**
 * @title Withdrawal Circuit (Circom 0.5.x)
 * @dev ZK-SNARK circuit cho anonymous withdrawal.
 *
 * Public inputs: root, nullifierHash, recipient, relayer, fee, amount
 * Private inputs: nullifier, secret, pathElements, pathIndices, noteAmount
 *
 * Ràng buộc:
 *   commitment = Poseidon(nullifier, secret)
 *   nullifierHash = Poseidon(nullifier)
 *   commitment nằm trong Merkle tree (root)
 *   0 < amount <= noteAmount
 */
template Withdraw() {
    // === Public inputs ===
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input relayer;
    signal input fee;
    signal input amount;

    // === Private inputs ===
    signal input nullifier;
    signal input secret;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal input noteAmount;

    // 1. Commitment = Poseidon(nullifier, secret)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;
    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. NullifierHash = Poseidon(nullifier)
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // 3. Merkle inclusion proof
    component tree = MerkleTreeInclusionProof(20);
    tree.leaf <== commitment;
    tree.root <== root;
    for (var i = 0; i < 20; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // 4. Amount check: 0 < amount <= noteAmount
    component amountCheck = LessEqThan(32);
    amountCheck.in[0] <== amount;
    amountCheck.in[1] <== noteAmount;
    amountCheck.out === 1;

    component positive = GreaterThan(32);
    positive.in[0] <== amount;
    positive.in[1] <== 0;
    positive.out === 1;
}

component main = Withdraw();
