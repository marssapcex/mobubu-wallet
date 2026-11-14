/**
 * @title Withdrawal Circuit (Circom sketch)
 * @dev ZK-SNARK circuit for anonymous withdrawal.
 *
 * Public inputs:
 *   commitment      - hash of the note (in merkle tree)
 *   nullifier       - H(secret, "withdraw"), prevents double spend
 *   amount          - amount user wants to withdraw (public)
 *
 * Private inputs (witness):
 *   secret          - secret key opening the commitment
 *   noteAmount      - amount inside the note (must be >= amount)
 *   merklePath      - path to commitment in merkle tree
 *   merkleRoot      - root of the merkle tree (public or private depending on design)
 *   fheCiphertext   - FHE-encrypted note amount (for consistency check off-chain)
 *
 * Constraints:
 *   commitment == poseidon(secret, noteAmount, chainId, assetId)
 *   nullifier == poseidon(secret, "withdraw")
 *   noteAmount >= amount   (range check)
 *   merklePath verifies commitment is in tree
 */

template WithdrawalProof() {
    // Public inputs
    signal input commitment;
    signal input nullifier;
    signal input amount;

    // Private inputs
    signal input secret;
    signal input noteAmount;
    signal input merklePath[32]; // example depth
    signal input merkleRoot;

    // commitment = H(secret, noteAmount, ...)
    // For sketch purposes, using Poseidon-like hash placeholder
    // In real Circom, use Poseidon or SHA256 template
    signal commitmentCheck;
    commitmentCheck <== secret * noteAmount; // placeholder, replace with real hash

    // nullifier = H(secret, "withdraw")
    signal nullifierCheck;
    nullifierCheck <== secret + 1; // placeholder

    // Range check: noteAmount >= amount
    signal enoughBalance;
    enoughBalance <== (noteAmount - amount); // must be >= 0, Circom enforces non-negative

    // Outputs / public signal constraints
    commitmentCheck === commitment;
    nullifierCheck === nullifier;
    enoughBalance >= 0;
}

component main = WithdrawalProof();
