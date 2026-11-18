pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

// Zero is the empty leaf. Path indices are given from leaf to root, LSB first.
// A 0 puts the current node on the left, a 1 puts it on the right.
template MerkleRoot(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal running[depth + 1];
    signal offset[depth];
    component hashes[depth];
    running[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        offset[i] <== (pathElements[i] - running[i]) * pathIndices[i];
        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== running[i] + offset[i];
        hashes[i].inputs[1] <== pathElements[i] - offset[i];
        running[i + 1] <== hashes[i].out;
    }
    root <== running[depth];
}
