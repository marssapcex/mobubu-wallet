pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "./merkleTree.circom";

/**
 * @title Withdrawal Circuit (Circom 2, real)
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
template Withdraw(levels, nBits) {
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
    signal input pathElements[levels];
    signal input pathIndices[levels];
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
    component tree = MerkleTreeInclusionProof(levels);
    tree.leaf <== commitment;
    for (let i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    root === tree.root;

    // 4. Amount check: 0 < amount <= noteAmount
    component amountCheck = LessEqThan(nBits);
    amountCheck.in[0] <== amount;
    amountCheck.in[1] <== noteAmount;
    amountCheck.out === 1;

    component positive = GreaterThan(nBits);
    positive.in[0] <== amount;
    positive.in[1] <== 0;
    positive.out === 1;
}

component main {public [root, nullifierHash, recipient, relayer, fee, amount]} = Withdraw(20, 32);
