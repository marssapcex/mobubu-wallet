// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NbStraightEvaluatorAt} from "../vendor/nonos/verifier/nb/NbStraightEvaluatorAt.sol";
import {WalkNb_A} from "../vendor/nonos/verifier/nb/WalkNb_A.sol";

/// Direct Goldilocks/Keccak DEEP-FRI verifier for the pinned 37-limb local spend relation.
/// No signed results, proxies, proof digests, or caller-chosen program/shape.
abstract contract NativeStark {
    bytes32 public constant STARK_IMAGE = 0x4364151e9f54797f3bbf9c8d28465f5a7dcf8ca1aafa9c9b48eb43cedf4e2429;
    bytes32 public constant STARK_PARAMS = 0xccba76ed5748b5ee54dfd62935fd1d10998b5c0f84e35a9dc899905cfb1eadb5;
    uint256 public constant MAX_PROOF_BYTES = 128_000;
    bytes8 private constant HEADER = 0x4e4f585007000100; // NOXP, format 7, protocol 1, little-endian IDs

    // Absolute offsets for the one supported shape (19 queries, 59 periodic columns).
    uint256 private constant BODY = 40;
    uint256 private constant HEAD_END = BODY + 5_716;
    uint256 private constant TAIL_START = HEAD_END + 19 * 384;
    uint256 private constant TAIL_END = TAIL_START + 92;
    uint256 private constant CLAIMS_START = TAIL_END + 19 * 368;
    uint256 private constant CLAIMS_END = CLAIMS_START + 4 + 59 * 16 + 8;
    uint256 private constant MIN_PROOF_BYTES = CLAIMS_END + 19 * 59 * 8;

    WalkNb_A public immutable starkWalk;
    NbStraightEvaluatorAt public immutable starkEvaluator;

    error WrongStarkCode();
    error InvalidStarkProof();

    constructor(address prepare, address walk, address evaluator) {
        if (prepare.codehash != 0x9a9a87266bcc6253f97643a698561d7a769d3b7df3c059ff9a349ba5b217be5f) {
            revert WrongStarkCode();
        }
        bytes memory code = walk.code;
        if (code.length != 21_199 || _extract(code, 64, 167) != prepare
            || keccak256(code) != 0x93b3da94ead31c3d9510d732cdf01b6099fd464641d32665af821fe0f7750077) {
            revert WrongStarkCode();
        }
        // Deploy the evaluator separately so all pool initcodes stay below EIP-3860.
        // Pin the exact template AND all six address words, not a getter response.
        code = evaluator.code;
        if (code.length != 22_940
            || _extract(code, 194, 449).codehash != 0x93287206aec4bcb328581607e3ee57364acfcbdeccf88b2a1f7c18cbd4e86769
            || _extract(code, 278, 486).codehash != 0x49c63cd661201d82ac248b39a760fb592ebb5cc8f50e51f9d9763870cb61ccf8
            || _extract(code, 362, 523).codehash != 0x58ecbd2cdd3c419089384ec5a2a57e18e45baa881231ac9e07e6a4f554d3f63c
            || keccak256(code) != 0xe7895b809e2fe25b276957d7d48fcbcabddd1ce4b52b2ad6e12beffbb66d47d5) {
            revert WrongStarkCode();
        }
        starkEvaluator = NbStraightEvaluatorAt(evaluator);
        starkWalk = WalkNb_A(walk);
    }

    function _extract(bytes memory code, uint256 first, uint256 second) private pure returns (address linked) {
        uint256 a;
        uint256 b;
        assembly ("memory-safe") {
            let p := add(code, 32)
            a := mload(add(p, first))
            b := mload(add(p, second))
            mstore(add(p, first), 0)
            mstore(add(p, second), 0)
        }
        if (a != b || a > type(uint160).max) revert WrongStarkCode();
        linked = address(uint160(a));
    }

    function _verifyStark(bytes calldata proof, uint256[] memory limbs) internal view {
        if (
            proof.length < MIN_PROOF_BYTES || proof.length > MAX_PROOF_BYTES
                || bytes8(proof[:8]) != HEADER || bytes32(proof[8:BODY]) != STARK_PARAMS
        ) revert InvalidStarkProof();
        bytes memory head = bytes.concat(proof[BODY:HEAD_END], proof[TAIL_START:TAIL_END]);
        bytes memory queries = bytes.concat(
            proof[HEAD_END:TAIL_START], proof[TAIL_END:CLAIMS_START], proof[CLAIMS_END:]
        );
        try starkWalk.verifyWholeComposed(head, proof[CLAIMS_START:CLAIMS_END], queries, limbs, address(starkEvaluator))
            returns (bool ok)
        {
            if (ok) return;
        } catch {}
        revert InvalidStarkProof();
    }
}
