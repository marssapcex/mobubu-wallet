pragma circom 2.2.3;

include "circomlib/circuits/bitify.circom";
include "./merkleTree.circom";

template NoteNonZero() {
    signal input value;
    signal inverse <-- value != 0 ? 1 / value : 0;
    value * inverse === 1;
}

template NoteFits(bits) {
    signal input value;
    component range = Num2Bits(bits);
    range.in <== value;
    _ <== range.out;
}

// v3, single input note, optional change. Both sides of the amount equation
// are range-checked so subtraction is integer conservation, not field wrap.
// The ledger MUST insert Poseidon(2)(noteKey, actual paid amount), never a
// client-supplied leaf, and use a distinct domain per ledger and source asset.
template SpendNote(depth) {
    signal input root;
    signal input nullifierHash;
    signal input payoutBinding;
    signal input amount;
    signal input changeCommitment;
    signal input domain;

    signal input noteValue;
    signal input nullifier;
    signal input secret;
    signal input changeNullifier;
    signal input changeSecret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    NoteFits(128)(noteValue);
    NoteFits(128)(amount);
    NoteNonZero()(amount);
    signal changeValue <== noteValue - amount;
    NoteFits(128)(changeValue);

    // Direct EVM withdrawal uses the address; the simulated router uses the
    // hash of the exact payout terms. The verifier derives this public input.
    NoteFits(248)(payoutBinding);
    NoteNonZero()(payoutBinding);
    NoteFits(248)(nullifier);
    NoteFits(248)(secret);
    NoteNonZero()(nullifier);
    NoteNonZero()(secret);

    signal noteKey <== Poseidon(4)([3, domain, nullifier, secret]);
    NoteNonZero()(noteKey);
    signal leaf <== Poseidon(2)([noteKey, noteValue]);
    NoteNonZero()(leaf);
    signal digest <== Poseidon(4)([4, domain, nullifier, leaf]);
    nullifierHash === digest;
    NoteNonZero()(nullifierHash);

    component merkle = MerkleRoot(depth);
    merkle.leaf <== leaf;
    merkle.pathElements <== pathElements;
    merkle.pathIndices <== pathIndices;
    root === merkle.root;

    // Zero amount means strictly no change leaf. Otherwise require a usable
    // commitment and conserve every input base unit in the new note.
    signal zeroChange <== IsZero()(changeValue);
    signal hasChange <== 1 - zeroChange;
    NoteFits(248)(changeNullifier);
    NoteFits(248)(changeSecret);
    changeNullifier * (1 - hasChange) === 0;
    changeSecret * (1 - hasChange) === 0;
    NoteNonZero()(changeNullifier + 1 - hasChange);
    NoteNonZero()(changeSecret + 1 - hasChange);
    signal changeKey <== Poseidon(4)([3, domain, changeNullifier, changeSecret]);
    NoteNonZero()(changeKey);
    signal changeLeaf <== Poseidon(2)([changeKey, changeValue]);
    changeCommitment === hasChange * changeLeaf;
    NoteNonZero()(changeCommitment + 1 - hasChange);
}

component main { public [root, nullifierHash, payoutBinding, amount, changeCommitment, domain] } = SpendNote(20);
