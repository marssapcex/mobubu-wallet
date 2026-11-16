include "circomlib/circuits/poseidon.circom";

// Hash hai node con thành node cha (Poseidon)
template HashTwo() {
    signal input left;
    signal input right;
    signal output hash;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== left;
    hasher.inputs[1] <== right;
    hash <== hasher.out;
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

    for (var i = 0; i < levels; i++) {
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

// Commitment hasher: commitment = Poseidon(nullifier, secret)
template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== nullifier;
    hasher.inputs[1] <== secret;
    commitment <== hasher.out[0];
}

// Nullifier hasher: nullifierHash = Poseidon(nullifier)
template NullifierHasher() {
    signal input nullifier;
    signal output nullifierHash;

    component hasher = Poseidon(1);
    hasher.inputs[0] <== nullifier;
    nullifierHash <== hasher.out;
}

// Alias for withdraw.circom compatibility
template MerkleTreeInclusionProof(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== leaf;
    checker.root <== root;
    for (var i = 0; i < levels; i++) {
        checker.pathElements[i] <== pathElements[i];
        checker.pathIndices[i] <== pathIndices[i];
    }
}
