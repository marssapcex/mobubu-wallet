// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Runtime pins for solc and tron-solc 0.8.24 / paris / optimizer 200 / metadata hash none.
/// Rebuild with `node scripts/build-vault.mjs --dao-pins [--tvm]`.
library HcmtPins {
    function token(bool tvm) internal pure returns (bytes32) {
        return tvm ? bytes32(0xd06b59c858a8d99127f507fa54af181514b8df6f408a756351f985ad4882ddc2) : bytes32(0x2ea4917d3683ba2db67216eff5fee104db8fbe9a862526a7e39068b7694acecf);
    }

    function treasury(bool tvm) internal pure returns (bytes32) {
        return tvm ? bytes32(0x3b2c0cf2308318db0eccf2b834947d902bee9f86c2d9ef9abdbfbeb5b967b9fc) : bytes32(0x3145a42affbda956e3c7170bd6391beaad03b091731b5e66d1964368c41faf08);
    }
}
