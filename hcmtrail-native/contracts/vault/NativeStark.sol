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

    constructor(bool tvm, address prepare, address walk, address[3] memory chunks) {
        _pin(tvm, prepare, walk);
        address[] memory at = new address[](3);
        for (uint256 i; i < at.length; ++i) at[i] = chunks[i];
        // The generated evaluator checks the runtime hash of each of its three chunks.
        starkEvaluator = new NbStraightEvaluatorAt(at);
        starkWalk = WalkNb_A(walk);
    }

    /// @dev The two immutable words must equal the *pinned* prepare address. The hash of
    /// the rest of the code must be that of the exact generated walk, not a contract that
    /// merely reports the same metadata. Regenerate pins via build-vault.mjs --pins.
    function _pin(bool tvm, address prepare, address walk) private view {
        bytes32 prepHash = tvm
            ? bytes32(0x920b3caf49a04f033c1c047a38f14a38d157515c43778245267f67b1d42a9e84)
            : bytes32(0x9a9a87266bcc6253f97643a698561d7a769d3b7df3c059ff9a349ba5b217be5f);
        bytes32 walkHash = tvm
            ? bytes32(0x87a96a0fb2fcb43ecf51e81567fb13ac75eac791da11ab386177c05c3e9473ad)
            : bytes32(0x93b3da94ead31c3d9510d732cdf01b6099fd464641d32665af821fe0f7750077);
        (uint256 length, uint256 first, uint256 second) = tvm ? (21242, 90, 193) : (21199, 64, 167);
        if (prepare.codehash != prepHash || walk.code.length != length) revert WrongStarkCode();
        bytes memory code = walk.code;
        bool linked;
        assembly ("memory-safe") {
            let a := add(add(code, 32), first)
            let b := add(add(code, 32), second)
            let expected := and(prepare, 0xffffffffffffffffffffffffffffffffffffffff)
            linked := and(eq(mload(a), expected), eq(mload(b), expected))
            mstore(a, 0)
            mstore(b, 0)
        }
        if (!linked || keccak256(code) != walkHash) revert WrongStarkCode();
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
