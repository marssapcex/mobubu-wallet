// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Runtime templates for solc/tron-solc 0.8.24, Paris, optimizer 200, metadata hash none.
/// `build-crosschain.mjs --pins [--tvm]` prints the templates' hashes and immutable offsets.
/// Check the whole verifier graph; a getter that merely advertises the right image is not proof.
library SpendGatePins {
    error WrongSpendStack();

    function check(address gate, bool tvm) internal view {
        bytes memory code = gate.code;
        if (code.length != (tvm ? 3348 : 3306)) revert WrongSpendStack();
        if (_pair(code, tvm ? 317 : 291, tvm ? 443 : 417) != block.chainid) revert WrongSpendStack();
        address walk = _address(_pair(code, tvm ? 219 : 193, tvm ? 1978 : 1952));
        address evaluator = _address(_pair(code, tvm ? 356 : 330, tvm ? 2166 : 2140));
        if (keccak256(code) != (tvm
            ? bytes32(0xd4511cb89e88bb8781de67e6342185a5d44c49800eda899dfb49384481eeffd6)
            : bytes32(0x3419c15097897be8601be0d269529db624a021e496710a510a93240f0020169f))) revert WrongSpendStack();
        _walk(walk, tvm);
        _evaluate(evaluator, tvm);
    }

    function _walk(address walk, bool tvm) private view {
        bytes memory code = walk.code;
        if (code.length != (tvm ? 21242 : 21199)) revert WrongSpendStack();
        address prep = _address(_pair(code, tvm ? 90 : 64, tvm ? 193 : 167));
        if (keccak256(code) != (tvm
            ? bytes32(0x87a96a0fb2fcb43ecf51e81567fb13ac75eac791da11ab386177c05c3e9473ad)
            : bytes32(0x93b3da94ead31c3d9510d732cdf01b6099fd464641d32665af821fe0f7750077))
            || prep.codehash != (tvm
                ? bytes32(0x920b3caf49a04f033c1c047a38f14a38d157515c43778245267f67b1d42a9e84)
                : bytes32(0x9a9a87266bcc6253f97643a698561d7a769d3b7df3c059ff9a349ba5b217be5f))) revert WrongSpendStack();
    }

    function _evaluate(address evaluator, bool tvm) private view {
        bytes memory code = evaluator.code;
        if (code.length != (tvm ? 22966 : 22940)) revert WrongSpendStack();
        address c0 = _address(_pair(code, tvm ? 220 : 194, tvm ? 475 : 449));
        address c1 = _address(_pair(code, tvm ? 304 : 278, tvm ? 512 : 486));
        address c2 = _address(_pair(code, tvm ? 388 : 362, tvm ? 549 : 523));
        if (keccak256(code) != (tvm
            ? bytes32(0x0cfb84f8ae6a2abd116b8fcc1a89bd94350a06f69a1e6d601586873304ff65d5)
            : bytes32(0xe7895b809e2fe25b276957d7d48fcbcabddd1ce4b52b2ad6e12beffbb66d47d5))
            || c0.codehash != 0x93287206aec4bcb328581607e3ee57364acfcbdeccf88b2a1f7c18cbd4e86769
            || c1.codehash != 0x49c63cd661201d82ac248b39a760fb592ebb5cc8f50e51f9d9763870cb61ccf8
            || c2.codehash != 0x58ecbd2cdd3c419089384ec5a2a57e18e45baa881231ac9e07e6a4f554d3f63c) revert WrongSpendStack();
    }

    function _address(uint256 n) private pure returns (address) {
        if (n == 0 || n > type(uint160).max) revert WrongSpendStack();
        return address(uint160(n));
    }

    function _pair(bytes memory code, uint256 a, uint256 b) private pure returns (uint256 w) {
        // All offsets above are checked against the release artifact and known code lengths.
        uint256 other;
        assembly ("memory-safe") {
            let x := add(add(code, 32), a)
            let y := add(add(code, 32), b)
            w := mload(x)
            other := mload(y)
            mstore(x, 0)
            mstore(y, 0)
        }
        if (w != other) revert WrongSpendStack();
    }
}
