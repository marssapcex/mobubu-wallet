/**
 * @title Merkle Tree Checker (Circom v2)
 * @dev Xác minh một leaf nằm trong Merkle tree với root cho trước.
 *      Dùng Pedersen hash từ circomlib.
 */

include "circomlib/circuits/pedersen.circom";
include "circomlib/circuits/poseidon.circom";

// Hash hai node con thành node cha (Pedersen)
template HashTwo() {
    signal input left;
    signal input right;
    signal output hash;

    component hasher = Pedersen(2);
    hasher.in[0] <== left;
    hasher.in[1] <== right;
    hash <== hasher.out[0];
}

// DualMux: chọn trái/phải dựa trên bit s
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Kiểm tra merkle proof: leaf + pathElements + pathIndices -> root
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component selectors[levels];
    component hashers[levels];

    for (let i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i - 1].hash;
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = HashTwo();
        hashers[i].left <== selectors[i].out[0];
        hashers[i].right <== selectors[i].out[1];
    }

    root === hashers[levels - 1].hash;
}

// Commitment hasher: commitment = Pedersen(nullifier, secret)
template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;

    component hasher = Pedersen(2);
    hasher.in[0] <== nullifier;
    hasher.in[1] <== secret;
    commitment <== hasher.out[0];
}

// Nullifier hasher: nullifierHash = Pedersen(nullifier, 0)
template NullifierHasher() {
    signal input nullifier;
    signal output nullifierHash;

    component hasher = Pedersen(2);
    hasher.in[0] <== nullifier;
    hasher.in[1] <== 0;
    nullifierHash <== hasher.out[0];
}
