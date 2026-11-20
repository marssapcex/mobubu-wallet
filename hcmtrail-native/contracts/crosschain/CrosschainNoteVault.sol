// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ChainlinkPriceEpochs} from "../ChainlinkPriceEpochs.sol";
import {NativeAsset, NativeAssets} from "../NativeAssets.sol";
import {HcmtPins} from "../dao/HcmtPins.sol";
import {HcmtPolicy} from "../dao/HcmtPolicy.sol";
import {HcmtTreasury} from "../dao/HcmtTreasury.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";
import {NativeExit} from "../vault/NativeVault.sol";
import {NativeNoteTree} from "../vault/NativeNoteTree.sol";
import {SpendGate} from "./SpendGate.sol";
import {SpendGatePins} from "./SpendGatePins.sol";
import {WithdrawalOrder, WithdrawalRate, WithdrawalTerms, IFinalizedEvents} from "./WithdrawalTerms.sol";

struct CrosschainSpend { bytes32 root; bytes32[2] nullifiers; bytes32[2] change; uint64 notBefore; }

/// @notice Opt-in testnet custody profile. Existing local vaults do not get a new spending path.
contract CrosschainNoteVault is NativeNoteTree {
    uint256 private constant NOTE_DOMAIN = 0x4e4f5445;
    uint256 private constant TIME_GRID = 600;
    uint8 private constant LOCKED = 1;
    uint8 private constant COMPLETED = 2;
    uint8 private constant REFUNDED = 3;
    bytes32 public constant STARK_IMAGE = 0x4364151e9f54797f3bbf9c8d28465f5a7dcf8ca1aafa9c9b48eb43cedf4e2429;

    NativeAsset public immutable asset;
    uint256 public immutable homeChainId;
    uint256 public immutable custodyCap;
    uint256 public immutable minRelayFee;
    uint256 public immutable maxRelayFee;
    HcmtTreasury public immutable treasury;
    ChainlinkPriceEpochs public immutable oracle;
    SpendGate public immutable gate;
    IFinalizedEvents public immutable finality;
    bytes32 public immutable gateCodeHash;

    struct Escrow { bytes32 rateHash; bytes32 refundLeaf; uint8 status; }
    mapping(bytes32 order => Escrow) public escrows;
    mapping(bytes32 nullifier => bool) public spent;
    mapping(address provider => uint256) public liquidityCredit;
    uint256 public accountedNative;
    uint256 public escrowNative;
    uint256 public creditedNative;
    uint64 public pendingRefundSlots;
    bool private entered;

    event Deposited(uint64 indexed index, bytes32 indexed note, uint256 amount);
    event Withdrawn(bytes32 indexed nullifier0, bytes32 indexed nullifier1,
        address indexed recipient, uint256 amount, address feeRecipient, uint256 fee);
    event DaoFeePaid(bool indexed withdrawal, uint256 gross, uint256 fee);
    event SettlementMessage(uint8 indexed kind, bytes32 indexed order, bytes32 data);
    event WithdrawalLocked(bytes32 indexed order, WithdrawalRate rate);
    event WithdrawalRefunded(bytes32 indexed order, uint64 index, bytes32 leaf, uint64 amount);
    event WithdrawalCompleted(bytes32 indexed order, address indexed provider, uint64 amount);

    error BadConfig();
    error InvalidAmount();
    error InvalidCommitment();
    error WrongState();
    error InvalidSpend();
    error InvalidRelay();
    error PayoutFailed();

    constructor(HcmtTreasury box, ChainlinkPriceEpochs prices, SpendGate verifier, IFinalizedEvents receipts)
        NativeNoteTree(keccak256(abi.encode("hcmtrail.crosschain-native-notes.v1", block.chainid, address(this), STARK_IMAGE)))
    {
        NativeAsset a = WithdrawalTerms.asset(block.chainid);
        if (address(box).codehash != HcmtPins.treasury(a == NativeAsset.TRX) || box.homeChainId() != block.chainid
            || address(prices).code.length == 0 || prices.oracleChainId() != block.chainid || prices.feeBps() != 0
            || address(receipts).code.length == 0) revert BadConfig();
        SpendGatePins.check(address(verifier), a == NativeAsset.TRX);
        asset = a;
        homeChainId = block.chainid;
        custodyCap = a == NativeAsset.TRX ? uint256(uint64(type(int64).max)) : Goldilocks.MAX_VALUE;
        minRelayFee = NativeAssets.units(a) / 100_000;
        maxRelayFee = NativeAssets.units(a) / 10_000;
        treasury = box;
        oracle = prices;
        gate = verifier;
        gateCodeHash = address(verifier).codehash;
        finality = receipts;
    }

    modifier guard() {
        if (entered || block.chainid != homeChainId) revert WrongState();
        entered = true;
        _;
        entered = false;
    }

    /// No oracle call on deposit. The user holds the source asset, not a USD or target-asset IOU.
    function deposit(bytes32 ownerCommit) external payable guard returns (uint64 index, bytes32 leaf) {
        if (msg.value == 0 || msg.value > custodyCap) revert InvalidAmount();
        uint256 fee = HcmtPolicy.fee(msg.value);
        uint256 net = msg.value - fee;
        if (accountedNative + escrowNative + net > custodyCap) revert InvalidAmount();
        leaf = commitment(net, ownerCommit);
        _room(1);
        accountedNative += net;
        index = _append(leaf, bytes32(0), false);
        if (fee != 0) _pay(payable(address(treasury)), fee);
        emit DaoFeePaid(false, msg.value, fee);
        emit Deposited(index, leaf, net);
    }

    function commitment(uint256 amount, bytes32 ownerCommit) public view returns (bytes32 leaf) {
        if (amount == 0 || amount > custodyCap) revert InvalidAmount();
        if (ownerCommit == bytes32(0) || !Goldilocks.isCanonicalDigest(ownerCommit)) revert InvalidCommitment();
        uint256 header = uint32(amount) | ((amount >> 32) << 64) | (uint256(asset) << 128) | (NOTE_DOMAIN << 192);
        leaf = poseidon.hash2(bytes32(header), ownerCommit);
        if (leaf == bytes32(0) || leaf == domainLeaf) revert InvalidCommitment();
    }

    /// Same-asset exit, no oracle. A fee-free proof can also be sponsored by any signer.
    function withdraw(bytes calldata proof, NativeExit calldata exit) external guard {
        if (exit.recipient == address(0) || exit.recipient == address(this) || exit.recipient == address(treasury)
            || exit.feeRecipient == address(this) || (exit.fee == 0) != (exit.feeRecipient == address(0))) revert InvalidSpend();
        if (exit.fee != 0 && (exit.fee < minRelayFee || exit.fee > maxRelayFee || msg.sender != exit.feeRecipient
            || !treasury.isBroadcaster(msg.sender))) revert InvalidRelay();
        _consume(proof, exit);
        uint256 fee = HcmtPolicy.fee(exit.amount);
        if (fee != 0) _pay(payable(address(treasury)), fee);
        _pay(exit.recipient, uint256(exit.amount) - fee);
        if (exit.fee != 0) _pay(exit.feeRecipient, exit.fee);
        emit DaoFeePaid(true, exit.amount, fee);
        emit Withdrawn(exit.nullifiers[0], exit.nullifiers[1], exit.recipient, uint256(exit.amount) - fee, exit.feeRecipient, exit.fee);
    }

    function quote(WithdrawalOrder calldata o) public view returns (WithdrawalRate memory r, uint96 fee, uint96 net) {
        _source(o);
        WithdrawalTerms.acceptanceOpen(o);
        ChainlinkPriceEpochs.Epoch memory e = oracle.activeEpoch();
        r.epoch = e.id;
        r.priceIn18 = e.rounds[uint8(asset)].price18;
        r.priceOut18 = e.rounds[uint8(WithdrawalTerms.asset(o.destinationChain))].price18;
        r.acceptedAt = uint64(block.timestamp);
        (r.grossOut, fee, net) = WithdrawalTerms.payout(o, r.priceIn18, r.priceOut18);
    }

    /// @notice Recompute the quote at execution time. The STARK binds all order terms including minNetOut,
    /// but deliberately not the epoch, which can change while the wallet computes its proof.
    function lockWithdrawal(WithdrawalOrder calldata o, CrosschainSpend calldata s, bytes calldata proof,
        bytes calldata reservation) external guard returns (WithdrawalRate memory r)
    {
        (r,,) = quote(o);
        bytes32 id = WithdrawalTerms.id(o);
        if (escrows[id].status != 0 || o.sourceLP == address(treasury)) revert WrongState();
        WithdrawalTerms.authenticated(finality, o.destinationChain, o.destinationVault, WithdrawalTerms.RESERVED,
            id, bytes32(0), reservation);
        // Two 128-bit data slots bind the full order hash. Fee leg 1 is **not paid**. It cannot be
        // replayed into local withdraw, where 1 is below the strictly enforced relay fee floor.
        uint256 h = uint256(id);
        NativeExit memory exit = NativeExit(s.root, s.nullifiers, s.change,
            payable(address(uint160((1 << 128) | (h >> 128)))), payable(address(uint160((1 << 128) | uint128(h)))),
            o.amountIn - 1, 1, s.notBefore);
        ++pendingRefundSlots; // protect space for a future refund against concurrent deposits
        _consume(proof, exit);
        escrowNative += o.amountIn;
        bytes32 rateHash = keccak256(abi.encode(r));
        escrows[id] = Escrow(rateHash, commitment(o.amountIn, o.refundOwnerCommit), LOCKED);
        emit WithdrawalLocked(id, r);
        emit SettlementMessage(WithdrawalTerms.LOCKED, id, rateHash);
    }

    /// @notice A proven destination payout makes the input available to its LP, not to a gas signer.
    function complete(WithdrawalOrder calldata o, bytes calldata payment) external guard {
        _source(o);
        bytes32 id = WithdrawalTerms.id(o);
        Escrow storage e = escrows[id];
        if (e.status != LOCKED) revert WrongState();
        WithdrawalTerms.authenticated(finality, o.destinationChain, o.destinationVault, WithdrawalTerms.PAID, id, e.rateHash, payment);
        e.status = COMPLETED;
        --pendingRefundSlots;
        escrowNative -= o.amountIn;
        creditedNative += o.amountIn;
        liquidityCredit[o.sourceLP] += o.amountIn;
        emit WithdrawalCompleted(id, o.sourceLP, o.amountIn);
    }

    /// @notice A terminal destination cancel (not a timeout or absent receipt) reissues the principal
    /// as a backed note. Old nullifiers stay spent and no new deposit fee is charged.
    function refund(WithdrawalOrder calldata o, bytes calldata cancellation) external guard {
        _source(o);
        bytes32 id = WithdrawalTerms.id(o);
        Escrow storage e = escrows[id];
        if (e.status != LOCKED) revert WrongState();
        WithdrawalTerms.authenticated(finality, o.destinationChain, o.destinationVault, WithdrawalTerms.CANCELLED,
            id, bytes32(0), cancellation);
        e.status = REFUNDED;
        --pendingRefundSlots;
        escrowNative -= o.amountIn;
        accountedNative += o.amountIn;
        uint64 index = _append(e.refundLeaf, bytes32(0), false);
        emit WithdrawalRefunded(id, index, e.refundLeaf, o.amountIn);
    }

    function withdrawLiquidity(uint256 amount, address payable recipient) external guard {
        if (amount == 0 || amount > custodyCap || amount > liquidityCredit[msg.sender]
            || recipient == address(0) || recipient == address(this)) revert InvalidAmount();
        liquidityCredit[msg.sender] -= amount;
        creditedNative -= amount;
        _pay(recipient, amount);
    }

    function _source(WithdrawalOrder calldata o) private view {
        WithdrawalTerms.validate(o);
        if (o.sourceChain != homeChainId || o.sourceVault != address(this)) revert BadConfig();
    }

    function _consume(bytes calldata proof, NativeExit memory e) private {
        uint256 debit = uint256(e.amount) + e.fee;
        (bytes32 n0, bytes32 n1) = (e.nullifiers[0], e.nullifiers[1]);
        if (e.amount == 0 || debit > accountedNative || address(this).balance < accountedNative + escrowNative + creditedNative
            || !knownRoot[e.root] || n0 == n1 || spent[n0] || spent[n1] || e.change[0] == domainLeaf || e.change[1] == domainLeaf
            || e.notBefore == 0 || e.notBefore >= Goldilocks.P || e.notBefore > block.timestamp || e.notBefore % TIME_GRID != 0) revert InvalidSpend();
        _room(2);
        if (address(gate).codehash != gateCodeHash || !gate.verify(proof, uint8(asset), e)) revert InvalidSpend();
        spent[n0] = true;
        spent[n1] = true;
        accountedNative -= debit;
        _append(e.change[0], e.change[1], true);
    }

    function _room(uint256 n) private view {
        if (uint256(leafCount) + pendingRefundSlots + n > (1 << TREE_DEPTH)) revert NoteTreeFull();
    }

    function _pay(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }
}
