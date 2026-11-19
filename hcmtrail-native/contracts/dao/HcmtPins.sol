// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Runtime pins for solc and tron-solc 0.8.24 / paris / optimizer 200 / metadata hash none.
/// Rebuild with `node scripts/build-vault.mjs --dao-pins [--tvm]`.
library HcmtPins {
    function token(bool tvm) internal pure returns (bytes32) {
        return tvm ? bytes32(0xd06b59c858a8d99127f507fa54af181514b8df6f408a756351f985ad4882ddc2) : bytes32(0x2ea4917d3683ba2db67216eff5fee104db8fbe9a862526a7e39068b7694acecf);
    }

    function treasury(bool tvm) internal pure returns (bytes32) {
        return tvm ? bytes32(0x1f744707b7cc1526daaa92f1750734f81a3d58723e25b7895884bff5a3a215cc) : bytes32(0x32af5f8524a78affe00d9fd689c79b8f06eb9aa0d1b8534095415bbd18c9c388);
    }
}
