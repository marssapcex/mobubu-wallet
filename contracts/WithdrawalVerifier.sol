// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title WithdrawalVerifier
 * @dev On-chain verifier cho ZK-SNARK withdrawal proof.
 *      Public inputs: [root, nullifierHash, amount]
 */
interface WithdrawalVerifier {
    function verifyProof(
        bytes calldata proof,
        uint256[3] calldata input
    ) external view returns (bool);
}
