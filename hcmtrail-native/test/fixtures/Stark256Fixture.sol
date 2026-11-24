// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Blake2b512} from "../../contracts/research/stark256/Blake2b512.sol";
import {GoldilocksFp8} from "../../contracts/research/stark256/GoldilocksFp8.sol";
import {WideTranscript256} from "../../contracts/research/stark256/WideTranscript256.sol";

contract Stark256Fixture {
    function digest(bytes memory input) external view returns (bytes memory) { return Blake2b512.digest(input); }
    function sample(bytes memory input) external pure returns (bool, uint64[8] memory) { return WideTranscript256.sample(input); }
    function challenge(bytes memory context, uint8 label) external view returns (uint64[8] memory, bytes memory) {
        return WideTranscript256.challenge(WideTranscript256.start(context), label);
    }
    function multiply(uint64[8] memory a, uint64[8] memory b) external pure returns (uint64[8] memory) {
        return GoldilocksFp8.multiply(a, b);
    }
}
