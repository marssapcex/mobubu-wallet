// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WithdrawalTerms, IFinalizedEvents} from "./WithdrawalTerms.sol";

/// @notice TESTNET transport adapter. Two of three independent signers attest the exact finalized log.
/// @dev This is NOT a consensus proof. A dishonest quorum can lie for reserved/locked orders. Do not use
/// with real funds. No admin or signer rotation. Mainnet requires a verified finality adapter instead.
contract ReceiptQuorum is IFinalizedEvents {
    bytes32 private constant TYPE_HASH = keccak256(
        "FinalizedWithdrawalLog(uint256 remoteChain,address emitter,uint8 kind,bytes32 order,bytes32 data,uint64 blockNumber,bytes32 blockHash,bytes32 transactionHash,uint32 logIndex,address consumer)"
    );
    bytes32 private constant EIP712_DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct LogPosition { uint64 blockNumber; bytes32 blockHash; bytes32 transactionHash; uint32 logIndex; }
    struct Signature { bytes32 r; bytes32 s; uint8 v; }

    uint256 public immutable homeChain;
    bytes32 public immutable domainSeparator;
    address[3] public witnesses;
    error BadWitnesses();

    constructor(address[3] memory allowed) {
        WithdrawalTerms.asset(block.chainid);
        if (allowed[0] == address(0) || allowed[0] >= allowed[1] || allowed[1] >= allowed[2]) revert BadWitnesses();
        witnesses = allowed;
        homeChain = block.chainid;
        domainSeparator = keccak256(abi.encode(EIP712_DOMAIN, keccak256("Hcmtrail Withdrawal Finality"),
            keccak256("1"), block.chainid, address(this)));
    }

    function digest(uint256 remoteChain, address emitter, uint8 kind, bytes32 order, bytes32 data,
        LogPosition memory at, address consumer) public view returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator,
            keccak256(abi.encode(TYPE_HASH, remoteChain, emitter, kind, order, data, at, consumer))));
    }

    function proves(uint256 remoteChain, address emitter, uint8 kind, bytes32 order, bytes32 data,
        bytes calldata proof) external view returns (bool)
    {
        if (block.chainid != homeChain || remoteChain == homeChain || emitter == address(0) || order == bytes32(0)
            || kind < WithdrawalTerms.RESERVED || kind > WithdrawalTerms.CANCELLED || proof.length != 320) return false;
        (LogPosition memory at, Signature[2] memory sigs) = abi.decode(proof, (LogPosition, Signature[2]));
        if (at.blockNumber == 0 || at.blockHash == bytes32(0) || at.transactionHash == bytes32(0)) return false;
        bytes32 h = digest(remoteChain, emitter, kind, order, data, at, msg.sender);
        address a = _recover(h, sigs[0]);
        address b = _recover(h, sigs[1]);
        return a < b && _witness(a) && _witness(b);
    }

    function _recover(bytes32 h, Signature memory s) private pure returns (address) {
        if (uint256(s.s) == 0 || uint256(s.s) > HALF_ORDER || (s.v != 27 && s.v != 28)) return address(0);
        return ecrecover(h, s.v, s.r, s.s);
    }

    function _witness(address a) private view returns (bool) {
        return a == witnesses[0] || a == witnesses[1] || a == witnesses[2];
    }
}
