// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Generated: node scripts/build-crosschain.mjs --config-pins (with pinned TRON_SOLC).
// solc and tron-solc 0.8.24, Paris, optimizer 200, metadata bytecodeHash none.
library WithdrawalConfigPinData {
    function oracle(bool tvm) internal pure returns (uint256, bytes32, bytes memory) {
        if (tvm) return (6689, bytes32(0x103cfd758e37f651f9b38a2b383fb0f7202dc962311111c2ce23f0ff2944fd64), hex"0300f307ec0e8f02013404800301df1350138c02021e0f88030253085d0eef0202bb1456");
        return (6663, bytes32(0x53c96faea58b99ff8334d55743d44a363b4337c9a8332c056983ca50bc9c41f1), hex"0300d907d20e7502011a04660301c5133613720202040f6e03023908430ed50202a1143c");
    }

    function quorum(bool tvm) internal pure returns (uint256, bytes32, bytes memory) {
        if (tvm) return (2133, bytes32(0x946da355e5f08634f7a8d79dfc14b13a9fdd3d6e4bb63f108d14584d7f8d507a), hex"0300ef013c016602011602a8");
        return (2090, bytes32(0x447f26ed31a6a071644efa5a82c8796e31bb96c8c11a9aa26ce60783926170c9), hex"0300d50122014c0200fc028e");
    }
}
