pragma circom 2.2.3;

include "circomlib/circuits/bitify.circom";
include "./merkleTree.circom";

template NonZero() {
    signal input value;
    signal inverse <-- value != 0 ? 1 / value : 0;
    value * inverse === 1;
}

// A note is spent in full. Its value is the vault's immutable denomination,
// included in the domain along with chain ID and vault address. There is no
// user-supplied noteAmount or FHE attestation involved in authorization.
template Withdraw(depth) {
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input domain;

    signal input nullifier;
    signal input secret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component nullifierBits = Num2Bits(248);
    component secretBits = Num2Bits(248);
    component recipientBits = Num2Bits(160);
    nullifierBits.in <== nullifier;
    secretBits.in <== secret;
    recipientBits.in <== recipient;
    _ <== nullifierBits.out;
    _ <== secretBits.out;
    _ <== recipientBits.out;
    NonZero()(nullifier);
    NonZero()(secret);
    NonZero()(recipient);

    signal commitment <== Poseidon(4)([1, domain, nullifier, secret]);
    NonZero()(commitment);
    signal digest <== Poseidon(3)([2, domain, nullifier]);
    nullifierHash === digest;
    NonZero()(nullifierHash);

    component merkle = MerkleRoot(depth);
    merkle.leaf <== commitment;
    merkle.pathElements <== pathElements;
    merkle.pathIndices <== pathIndices;
    root === merkle.root;
}

component main { public [root, nullifierHash, recipient, domain] } = Withdraw(20);
