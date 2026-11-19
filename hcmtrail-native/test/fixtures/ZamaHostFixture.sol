// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FheType} from "@fhevm/solidity/lib/FheType.sol";
import {FhevmECDSA} from "@fhevm/solidity/lib/cryptography/FhevmECDSA.sol";

// Only for an isolated EDR VM using Zama's local addresses. This is NOT Zama host bytecode.
// Inputs, type/ACL behavior, and signed callbacks are fixtures. No encryption or cleartext arithmetic here.
abstract contract LocalHostAddresses {
    address internal constant ACL = 0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D;
    address internal constant EXECUTOR = 0xe3a9105a3a932253A70F126eb1E3b589C643dD24;
}

contract FixtureACL is LocalHostAddresses {
    mapping(bytes32 => mapping(address => bool)) public persistent;
    mapping(bytes32 => bool) public isAllowedForDecryption;

    function isAllowed(bytes32 handle, address who) public view returns (bool permitted) {
        bytes32 key = keccak256(abi.encode(handle, who));
        assembly ("memory-safe") { permitted := tload(key) }
        return permitted || persistent[handle][who];
    }

    function allowTransient(bytes32 handle, address who) external {
        require(msg.sender == EXECUTOR || isAllowed(handle, msg.sender), "fixture transient ACL");
        bytes32 key = keccak256(abi.encode(handle, who));
        assembly ("memory-safe") { tstore(key, 1) }
    }

    function allow(bytes32 handle, address who) external {
        require(isAllowed(handle, msg.sender), "fixture persistent ACL");
        persistent[handle][who] = true;
    }

    function allowForDecryption(bytes32[] calldata handles) external {
        for (uint256 i; i < handles.length; ++i) {
            require(isAllowed(handles[i], msg.sender), "fixture decrypt ACL");
            isAllowedForDecryption[handles[i]] = true;
        }
    }
}

contract FixtureExecutor is LocalHostAddresses {
    bytes32 private constant INPUT_DOMAIN = keccak256("hcmtrail.test.fhe-input.v1");
    address private constant INPUT_SIGNER = 0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69; // Public test key 3.

    enum Op { Constant, Mul, Div, Le, Gt, Ge, Eq, And, Select }
    event Operation(bytes32 indexed out, Op op, FheType kind, bytes32 a, bytes32 b, bytes32 control, bytes1 scalar);
    error BadInputProof();
    error WrongType();

    function verifyInput(bytes32 handle, address user, bytes calldata proof, FheType kind) external returns (bytes32) {
        checkHandleType(handle, kind);
        (bytes32 first, bytes32 second, bytes memory sig) = abi.decode(proof, (bytes32, bytes32, bytes));
        bytes32 digest = keccak256(abi.encode(INPUT_DOMAIN, block.chainid, msg.sender, user, first, second));
        (address signer,,) = FhevmECDSA.tryRecover(digest, sig);
        if ((handle != first && handle != second) || signer != INPUT_SIGNER) revert BadInputProof();
        FixtureACL(ACL).allowTransient(handle, msg.sender);
        return handle;
    }

    function checkHandleType(bytes32 handle, FheType kind) public pure {
        if (handle == 0 || uint8(handle[30]) != uint8(kind)) revert WrongType();
    }

    function trivialEncrypt(uint256 value, FheType kind) external returns (bytes32) {
        require(kind == FheType.Uint256 || (kind == FheType.Uint128 && value <= type(uint128).max));
        return _emit(Op.Constant, kind, bytes32(value), 0, 0, 0x01);
    }

    function fheMul(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        return _binary(Op.Mul, a, b, scalar, FheType.Uint128, FheType.Uint128);
    }

    function fheDiv(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        require(scalar == 0x01 && b != 0);
        return _binary(Op.Div, a, b, scalar, FheType.Uint128, FheType.Uint128);
    }

    function fheLe(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        return _binary(Op.Le, a, b, scalar, FheType.Uint128, FheType.Bool);
    }

    function fheGt(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        return _binary(Op.Gt, a, b, scalar, FheType.Uint128, FheType.Bool);
    }

    function fheGe(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        return _binary(Op.Ge, a, b, scalar, FheType.Uint128, FheType.Bool);
    }

    function fheEq(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        return _binary(Op.Eq, a, b, scalar, FheType.Uint256, FheType.Bool);
    }

    function fheBitAnd(bytes32 a, bytes32 b, bytes1 scalar) external returns (bytes32) {
        return _binary(Op.And, a, b, scalar, FheType.Bool, FheType.Bool);
    }

    function fheIfThenElse(bytes32 control, bytes32 a, bytes32 b) external returns (bytes32) {
        _operand(control, FheType.Bool);
        _operand(a, FheType.Uint128);
        _operand(b, FheType.Uint128);
        return _emit(Op.Select, FheType.Uint128, a, b, control, 0);
    }

    function _operand(bytes32 handle, FheType kind) private view {
        checkHandleType(handle, kind);
        require(FixtureACL(ACL).isAllowed(handle, msg.sender), "fixture operand ACL");
    }

    function _binary(Op op, bytes32 a, bytes32 b, bytes1 scalar, FheType kind, FheType outKind)
        private returns (bytes32)
    {
        _operand(a, kind);
        if (scalar == 0) _operand(b, kind);
        else require(scalar == 0x01 && (kind != FheType.Uint128 || uint256(b) <= type(uint128).max));
        return _emit(op, outKind, a, b, 0, scalar);
    }

    function _emit(Op op, FheType kind, bytes32 a, bytes32 b, bytes32 control, bytes1 scalar)
        private returns (bytes32 out)
    {
        // Deliberately deduplicate equal operations regardless of caller, even across blocks.
        out = bytes32(bytes30(keccak256(abi.encode(op, kind, a, b, control, scalar))))
            | bytes32(uint256(uint8(kind)) << 8);
        FixtureACL(ACL).allowTransient(out, msg.sender);
        emit Operation(out, op, kind, a, b, control, scalar);
    }
}

contract FixtureKMS is LocalHostAddresses {
    bytes32 private constant DOMAIN_TYPE = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RESULT_TYPE = keccak256("PublicDecryptVerification(bytes32[] ctHandles,bytes decryptedResult,bytes extraData)");
    address private constant FIRST = 0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718; // Public test key 4.
    address private constant SECOND = 0xe1AB8145F7E55DC933d51a18c793F901A3A0b276; // Public test key 5.

    function verifyDecryptionEIP712KMSSignatures(bytes32[] calldata handles, bytes calldata cleartext, bytes calldata proof)
        external view returns (bool)
    {
        if (handles.length != 1 || cleartext.length != 32 || proof.length != 131 || proof[0] != 0x02
            || !FixtureACL(ACL).isAllowedForDecryption(handles[0])) return false;
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPE, keccak256("FixtureKMS"), keccak256("1"), block.chainid, address(this)));
        bytes32 result = keccak256(abi.encode(RESULT_TYPE, keccak256(abi.encodePacked(handles)), keccak256(cleartext), keccak256("")));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, result));
        (address first,,) = FhevmECDSA.tryRecoverCalldata(digest, proof[1:66]);
        (address second,,) = FhevmECDSA.tryRecoverCalldata(digest, proof[66:131]);
        return (first == FIRST && second == SECOND) || (first == SECOND && second == FIRST);
    }
}
