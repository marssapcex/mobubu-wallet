// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {NativeAsset, NativeAssets} from "../NativeAssets.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";
import {NativeNoteTree} from "../vault/NativeNoteTree.sol";
import {NativeExit} from "../vault/NativeVault.sol";
import {HcmtTreasury} from "./HcmtTreasury.sol";
import {HcmtPolicy} from "./HcmtPolicy.sol";
import {HcmtPins} from "./HcmtPins.sol";
import {NativeStark} from "../vault/NativeStark.sol";

/// @notice Native testnet custody with immediate DAO fees and optional bonded paid relay.
/// @dev NativeExit.amount is the gross payout. NativeExit.fee is solely the broadcaster fee.
/// The STARK's public amount and conservation relation are unchanged; the gross leg is split in Solidity.
abstract contract HcmtFeeVault is NativeStark, NativeNoteTree {
    uint256 private constant NOTE_DOMAIN = 0x4e4f5445;
    uint256 public constant TIME_GRID = 600;
    uint256 public constant DAO_FEE_BPS = HcmtPolicy.FEE_BPS;
    HcmtTreasury public immutable treasury;
    uint256 public immutable minRelayFee;
    uint256 public immutable maxRelayFee;

    NativeAsset public immutable asset;
    uint256 public immutable homeChainId;
    uint256 public immutable unitsPerCoin;
    uint256 public immutable custodyCap;

    uint256 public accountedNative;
    mapping(bytes32 nullifier => bool) public spent;
    bool private entered;

    event Deposited(uint64 indexed index, bytes32 indexed note, uint256 amount);
    event Withdrawn(bytes32 indexed nullifier0, bytes32 indexed nullifier1,
        address indexed recipient, uint256 amount, address feeRecipient, uint256 fee);

    /// @dev Emitted even for smaller-than-one-base-unit fees, rounded to zero.
    event DaoFeePaid(bool indexed withdrawal, uint256 gross, uint256 fee);

    error WrongChain();
    error WrongTreasury();
    error UnauthorizedBroadcaster();
    error InvalidRelayFee();
    error Reentrant();
    error InvalidAmount();
    error InvalidCommitment();
    error InvalidRecipient();
    error InvalidTime();
    error UnknownRoot();
    error InvalidNullifier();
    error AlreadySpent();
    error InsufficientBacking();
    error PayoutFailed();

    constructor(NativeAsset asset_, uint256 chainId_, address prepare, address walk, address[3] memory chunks,
        HcmtTreasury treasury_)
        NativeStark(asset_ == NativeAsset.TRX, prepare, walk, chunks)
        NativeNoteTree(_domain(asset_, chainId_))
    {
        asset = asset_;
        homeChainId = chainId_;
        uint256 units = NativeAssets.units(asset_);
        unitsPerCoin = units;
        minRelayFee = units / 100_000;
        maxRelayFee = units / 10_000;
        bool tvm = asset_ == NativeAsset.TRX;
        if (address(treasury_).codehash != HcmtPins.treasury(tvm) || treasury_.homeChainId() != chainId_
            || address(treasury_.hcmt()).codehash != HcmtPins.token(tvm)
            || treasury_.hcmt().homeChainId() != chainId_) revert WrongTreasury();
        treasury = treasury_;
        // Base units, not the wider integer envelope of the separate pricing contracts.
        custodyCap = asset_ == NativeAsset.TRX ? uint64(type(int64).max) : Goldilocks.MAX_VALUE;
    }

    function _domain(NativeAsset a, uint256 chainId_) private view returns (bytes32) {
        if (block.chainid != chainId_) revert WrongChain();
        return keccak256(abi.encode("HCMTRAIL-NATIVE-LOCAL-EXIT-v1", block.chainid, address(this), a, STARK_IMAGE));
    }

    modifier transition() {
        if (block.chainid != homeChainId) revert WrongChain();
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function daoFee(uint256 gross) public pure returns (uint256) {
        return HcmtPolicy.fee(gross);
    }

    /// @notice Deposit gross msg.value; commit only the net note value.
    function deposit(bytes32 ownerCommit) external payable transition returns (uint64 index, bytes32 note) {
        uint256 gross = msg.value;
        if (gross == 0 || gross > custodyCap) revert InvalidAmount();
        uint256 levy = daoFee(gross);
        uint256 net = gross - levy;
        uint256 next = accountedNative + net;
        if (next > custodyCap) revert InvalidAmount();
        note = commitment(net, ownerCommit);
        accountedNative = next;
        index = _append(note, bytes32(0), false);
        if (levy != 0) _pay(payable(address(treasury)), levy);
        emit DaoFeePaid(false, gross, levy);
        emit Deposited(index, note, net);
    }

    function commitment(uint256 amount, bytes32 ownerCommit) public view returns (bytes32 note) {
        if (amount == 0 || amount > custodyCap) revert InvalidAmount();
        if (ownerCommit == bytes32(0) || !Goldilocks.isCanonicalDigest(ownerCommit)) revert InvalidCommitment();
        uint256 header = uint32(amount) | ((amount >> 32) << 64) | (uint256(asset) << 128) | (NOTE_DOMAIN << 192);
        note = poseidon.hash2(bytes32(header), ownerCommit);
        if (note == bytes32(0) || note == domainLeaf) revert InvalidCommitment();
    }

    /// @notice Relay fee zero permits fee-free self submission. A paid proof must be sent by
    /// its proof-bound fee recipient with at least 100 currently active HCMT staked.
    function withdraw(bytes calldata proof, NativeExit calldata exit) external transition {
        if (!knownRoot[exit.root]) revert UnknownRoot();
        if (exit.notBefore == 0 || exit.notBefore >= Goldilocks.P || exit.notBefore % TIME_GRID != 0
            || exit.notBefore > block.timestamp) revert InvalidTime();
        if (exit.recipient == address(0) || exit.recipient == address(this) || exit.recipient == address(treasury)
            || exit.feeRecipient == address(this) || ((exit.fee == 0) != (exit.feeRecipient == address(0)))) {
            revert InvalidRecipient();
        }
        if (exit.fee != 0) {
            if (exit.fee < minRelayFee || exit.fee > maxRelayFee) revert InvalidRelayFee();
            if (msg.sender != exit.feeRecipient || !treasury.isBroadcaster(msg.sender)) revert UnauthorizedBroadcaster();
        }
        uint256 debit = uint256(exit.amount) + exit.fee;
        if (exit.amount == 0 || debit > custodyCap) revert InvalidAmount();
        (bytes32 n0, bytes32 n1) = (exit.nullifiers[0], exit.nullifiers[1]);
        if (n0 == n1 || n0 == bytes32(0) || n1 == bytes32(0)) revert InvalidNullifier();
        if (spent[n0] || spent[n1]) revert AlreadySpent();
        if (debit > accountedNative || address(this).balance < accountedNative) revert InsufficientBacking();
        if (exit.change[0] == domainLeaf || exit.change[1] == domainLeaf) revert InvalidCommitment();
        _verifyStark(proof, _publicLimbs(exit));

        // All effects precede the calls. Failure of either payment rolls back the nullifiers,
        // change, recipient transfers and balance accounting atomically.
        spent[n0] = true;
        spent[n1] = true;
        accountedNative -= debit;
        _append(exit.change[0], exit.change[1], true);
        uint256 levy = daoFee(exit.amount);
        uint256 net = exit.amount - levy;
        if (levy != 0) _pay(payable(address(treasury)), levy);
        _pay(exit.recipient, net);
        if (exit.fee != 0) _pay(exit.feeRecipient, exit.fee);
        emit DaoFeePaid(true, exit.amount, levy);
        emit Withdrawn(n0, n1, exit.recipient, net, exit.feeRecipient, exit.fee);
    }

    function _pay(address payable to, uint256 value) private {
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert PayoutFailed();
    }

    /// @dev Exact NON-OS NotBefore public layout. This local profile uses the note tree as
    /// the association tree; no arbitrary ACL root or price is supplied by the caller.
    function _publicLimbs(NativeExit calldata exit) private view returns (uint256[] memory limbs) {
        limbs = new uint256[](37);
        _digest(limbs, 0, exit.root);
        _digest(limbs, 4, exit.root);
        _digest(limbs, 8, exit.nullifiers[0]);
        _digest(limbs, 12, exit.nullifiers[1]);
        _digest(limbs, 16, exit.change[0]);
        _digest(limbs, 20, exit.change[1]);
        limbs[24] = exit.amount; // gross allocation = recipient net + immutable DAO fee
        limbs[25] = exit.fee;
        limbs[26] = uint256(asset);
        // Limb 27 (clearing_price) is zero; there is no swap in this relation.
        _address(limbs, 28, exit.recipient);
        _address(limbs, 32, exit.feeRecipient);
        limbs[36] = exit.notBefore;
    }

    function _digest(uint256[] memory limbs, uint256 at, bytes32 d) private pure {
        if (d == bytes32(0) || !Goldilocks.isCanonicalDigest(d)) revert InvalidCommitment();
        for (uint256 i; i < 4; ++i) limbs[at + i] = Goldilocks.limb(d, i);
    }

    function _address(uint256[] memory limbs, uint256 at, address to) private pure {
        uint256 x = uint160(to);
        for (uint256 i; i < 4; ++i) limbs[at + i] = uint48(x >> (i * 48));
    }
}
