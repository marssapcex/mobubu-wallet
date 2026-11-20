// SPDX-License-Identifier: ISC
pragma solidity 0.8.24;

import {SlhDsaSha2_128s} from "./lib/SlhDsaSha2_128s.sol";

/// @dev Implementations must verify a pinned transparent ZK program, not an attester's signature.
interface IShieldedStarkVerifier {
    function verify(bytes32 programId, bytes32 journalHash, bytes calldata proof) external view returns (bool);
}

/// @notice Local-only vault for native ETH or BNB notes. No quote on deposit; no admin spend path.
/// @dev The verifier and exact program are deployment dependencies. This repo does not yet
/// ship a verified EVM implementation of IShieldedStarkVerifier for the guest.
contract ShieldedNativePoolDevnet {
    uint32 public constant CAPACITY = 1 << 20;
    uint128 public constant MAX_NOTE = type(uint96).max;
    bytes32 public constant EXIT_DOMAIN = keccak256("mobubu:shielded-pool:exit:v1");

    IShieldedStarkVerifier public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    bytes32 public immutable programId;
    bytes32 public immutable domain;
    uint32 public count;
    bytes32 public root;
    uint256 public escrowed;
    mapping(bytes32 => uint32) public rootCount;
    mapping(bytes32 => bool) public usedLeaf;
    mapping(bytes32 => bool) public spent;
    bytes32[21] private zeros;
    bytes32[20] private frontier;
    bool private locked;

    struct Exit {
        bytes32 root;
        uint32 count;
        bytes32 nullifier;
        uint128 debit;
        bytes32 change;
        bytes32 destination;
        bytes32 recipient;
        uint128 amountOut;
        bytes32 quote;
        bytes32 key;
        uint64 deadline;
        address submitter;
    }

    error DevnetOnly();
    error InvalidVerifier();
    error InvalidNote();
    error InvalidExit();
    error InvalidSignature();
    error InvalidProof();
    error AlreadySpent();
    error TransferFailed();
    error Reentry();
    event LeafInserted(uint32 indexed index, bytes32 indexed leaf, bytes32 root);
    event Deposited(uint32 indexed index, bytes32 indexed leaf, uint128 amount);
    event Withdrawn(bytes32 indexed nullifier, address indexed recipient, uint128 amount);

    constructor(IShieldedStarkVerifier v, bytes32 expectedCodeHash, bytes32 expectedProgram) {
        // Deliberately incompatible with Ethereum mainnet and BSC mainnet.
        if (block.chainid != 31337 && block.chainid != 31338) revert DevnetOnly();
        if (address(v).code.length == 0 || address(v).codehash != expectedCodeHash || expectedProgram == bytes32(0)) {
            revert InvalidVerifier();
        }
        verifier = v;
        verifierCodeHash = expectedCodeHash;
        programId = expectedProgram;
        domain = sha256(abi.encodePacked(uint8(5), block.chainid, address(this)));
        for (uint256 i = 0; i < 20; i++) zeros[i + 1] = _parent(zeros[i], zeros[i]);
        root = zeros[20];
    }

    modifier guard() {
        if (locked) revert Reentry();
        locked = true;
        _;
        locked = false;
    }

    /// @notice Insert a leaf committing to the ACTUAL amount received. No recipient, quote, or SLH key is registered.
    function deposit(bytes32 noteKey) external payable guard returns (uint32 index, bytes32 leaf) {
        if (noteKey == bytes32(0) || msg.value == 0 || msg.value > MAX_NOTE) revert InvalidNote();
        leaf = sha256(abi.encodePacked(uint8(2), domain, noteKey, uint128(msg.value)));
        index = _insert(leaf);
        escrowed += msg.value;
        emit Deposited(index, leaf, uint128(msg.value));
    }

    function exitMessage(Exit calldata e) public view returns (bytes memory) {
        return abi.encode(EXIT_DOMAIN, domain, e);
    }

    function _journalHash(Exit calldata e, bytes memory message) private view returns (bytes32) {
        return sha256(abi.encode(domain, e.root, e.count, e.nullifier, e.debit, e.change, sha256(message)));
    }

    function journalHash(Exit calldata e) external view returns (bytes32) {
        return _journalHash(e, exitMessage(e));
    }

    /// @notice Same-chain proof-gated exit. Source burn/foreign payout intentionally not wired here.
    function withdraw(Exit calldata e, address recipient, bytes calldata userSignature, bytes calldata proof) external guard {
        if (e.destination != domain || e.amountOut != e.debit || e.quote != bytes32(0) || e.key == bytes32(0) ||
            e.deadline <= block.timestamp || e.submitter != msg.sender || recipient == address(0) || recipient == address(this) ||
            e.recipient != sha256(abi.encodePacked(recipient)) || e.count == 0 || rootCount[e.root] != e.count ||
            e.nullifier == bytes32(0) || e.debit == 0 || e.debit > MAX_NOTE || e.debit > escrowed) revert InvalidExit();
        if (spent[e.nullifier]) revert AlreadySpent();
        if (proof.length == 0 || proof.length > 512 * 1024 || address(verifier).codehash != verifierCodeHash) revert InvalidProof();
        bytes memory message = exitMessage(e);
        if (!SlhDsaSha2_128s.verify(e.key, message, userSignature)) revert InvalidSignature();
        if (!verifier.verify(programId, _journalHash(e, message), proof)) revert InvalidProof();

        spent[e.nullifier] = true;
        escrowed -= e.debit;
        if (e.change != bytes32(0)) _insert(e.change);
        (bool ok, ) = recipient.call{value: e.debit, gas: 100_000}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(e.nullifier, recipient, e.debit);
    }

    function _parent(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return sha256(abi.encodePacked(uint8(4), left, right));
    }

    function _insert(bytes32 leaf) private returns (uint32 index) {
        index = count;
        if (leaf == bytes32(0) || usedLeaf[leaf] || index >= CAPACITY) revert InvalidNote();
        usedLeaf[leaf] = true;
        bytes32 node = leaf;
        uint256 cursor = index;
        for (uint256 level = 0; level < 20; level++) {
            if ((cursor & 1) == 0) {
                frontier[level] = node;
                node = _parent(node, zeros[level]);
            } else {
                node = _parent(frontier[level], node);
            }
            cursor >>= 1;
        }
        count = index + 1;
        root = node;
        rootCount[node] = count;
        emit LeafInserted(index, leaf, node);
    }
}
