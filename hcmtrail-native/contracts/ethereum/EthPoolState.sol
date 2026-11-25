// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";
import {PoseidonGoldilocks} from "../vendor/nonos/PoseidonGoldilocks.sol";
import {NativeNoteDepositsCore, DepositNote} from "../vault/NativeNoteDeposits.sol";
import {NativeStark} from "../vault/NativeStark.sol";
import {EthFeeStaking} from "./EthFeeStaking.sol";

struct PoolSpend {
    bytes32 root;
    bytes32[2] nullifiers;
    bytes32[2] change;
    uint64 notBefore;
}

struct BatchTerms {
    uint256 amount; // gross debit per ticket, possibly funded by several proofs
    uint64 round;   // unique, increasing per exact amount
    uint8 target;
    address payable recipient;
    bytes32 salt;
}

/// @dev The state machine is separate so tests can exercise 100-way settlement without
/// generating 100 STARKs. The deployed EthShieldedPool has only the pinned verifier.
abstract contract EthPoolState is NativeNoteDepositsCore {
    uint256 public constant MIN_DEPOSIT = 0.01 ether;
    uint256 public constant FEE_BPS = 9; // 0.09%, floored to whole wei
    uint8 public constant MIN_TARGET = 5;
    uint8 public constant MAX_TARGET = 100;
    uint256 public constant BATCH_LIFETIME = 1 days;
    uint256 public constant BATCH_RECEIVE_GAS = 35_000;
    uint256 public constant TIME_GRID = 600;
    bytes32 private constant BATCH_TAG = keccak256("hcmtrail.eth-pool.reserve.v3");

    struct Batch {
        uint64 expiresAt;
        uint8 target;
        bool paid;
        bytes32[] entries; // only completely funded tickets count
        mapping(address recipient => bool) queuedRecipient;
    }
    struct Ticket {
        uint256 funded;
        uint64 parts;
        address payable recipient;
    }
    struct Refund {
        bytes32 ticket;
        bytes32 leaf;
        uint64 value;
    }

    uint256 public immutable homeChainId;
    EthFeeStaking public immutable feeStaking;
    uint256 public shieldedNative;
    uint256 public reservedNative;
    uint64 public reservedRefundLeaves;
    mapping(bytes32 nullifier => bool) public spent;
    mapping(uint256 amount => uint64) public latestRound;
    mapping(uint256 amount => mapping(uint64 round => Batch)) private batches;
    mapping(bytes32 id => Ticket) public tickets;
    mapping(bytes32 nullifier => Refund) public refunds;
    bool private entered;

    event NullifiersSpent(bytes32 indexed first, bytes32 indexed second);
    event Paid(bytes32 indexed nullifier, address indexed recipient, uint64 gross, uint64 net, uint64 fee);
    event BatchOpened(uint256 indexed amount, uint64 indexed round, uint8 target, uint64 expiresAt);
    event PartReserved(bytes32 indexed ticket, bytes32 indexed nullifier, uint64 value, bytes32 refundLeaf);
    event TicketQueued(uint256 indexed amount, uint64 indexed round, bytes32 indexed ticket);
    event BatchFilled(uint256 indexed amount, uint64 indexed round);
    event BatchPaid(uint256 indexed amount, uint64 indexed round, uint8 count, uint256 total, uint256 fee);
    event Refunded(bytes32 indexed nullifier, bytes32 indexed leaf, uint64 index, uint64 value);

    error WrongChain();
    error Reentrant();
    error InvalidRecipient();
    error InvalidTime();
    error UnknownRoot();
    error InvalidNullifier();
    error AlreadySpent();
    error InvalidBatch();
    error BatchNotReady();
    error RefundUnavailable();
    error PayoutFailed(uint256 position);

    constructor(uint256 chainId_, bytes32 image, PoseidonGoldilocks hasher, address stakeToken)
        NativeNoteDepositsCore(keccak256(abi.encode("HCMTRAIL-ETH-POOL-v3", chainId_, address(this), image)), hasher)
    {
        // Concrete implementations additionally pin the allowed lab chain IDs.
        if (chainId_ != block.chainid) revert WrongChain();
        homeChainId = chainId_;
        feeStaking = new EthFeeStaking(stakeToken);
    }

    modifier transition() {
        if (block.chainid != homeChainId) revert WrongChain();
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function quoteFee(uint256 gross) public pure returns (uint256 fee, uint256 net) {
        // Split the quotient and remainder before multiplying, including for uint256 gross.
        fee = gross / 10_000 * FEE_BPS + (gross % 10_000) * FEE_BPS / 10_000;
        net = gross - fee;
    }

    function deposit(bytes32 ownerCommit) external payable transition {
        if (msg.value < MIN_DEPOSIT) revert InvalidAmount();
        _spaceFor(1);
        (uint256 fee, uint256 net) = quoteFee(msg.value);
        shieldedNative += net;
        _depositNote(net, ownerCommit);
        _fundFee(fee);
    }

    function depositBatch(DepositNote[] calldata notes) external payable transition {
        if (msg.value < MIN_DEPOSIT) revert InvalidAmount();
        _spaceFor(notes.length);
        (uint256 fee, uint256 net) = quoteFee(msg.value);
        shieldedNative += net;
        _depositNotes(net, notes);
        _fundFee(fee);
    }

    /// @notice Spend `gross` from a private note. The proof authorizes the net
    /// payment and the exact immutable staking fee, never the caller's address.
    function withdraw(bytes calldata proof, PoolSpend calldata spend, address payable to, uint64 gross) external transition {
        _recipient(to);
        (uint256 fee, uint256 net) = quoteFee(gross);
        _consume(proof, spend, uint64(net), uint64(fee), 0, to, fee == 0 ? address(0) : address(feeStaking));
        _fundPayoutFee(fee);
        (bool ok,) = to.call{value: net}("");
        if (!ok) revert PayoutFailed(0);
        emit Paid(spend.nullifiers[0], to, gross, uint64(net), uint64(fee));
    }

    function _fundFee(uint256 fee) internal {
        if (fee != 0) feeStaking.fundFees{value: fee}();
    }

    function _fundPayoutFee(uint256 fee) internal {
        if (fee != 0) feeStaking.fundPayoutFees{value: fee}(msg.sender);
    }

    function getBatch(uint256 amount, uint64 round) external view returns (uint64 expiresAt, uint8 target, uint8 count, bool paid) {
        Batch storage b = batches[amount][round];
        return (b.expiresAt, b.target, uint8(b.entries.length), b.paid);
    }

    function ticketId(BatchTerms calldata terms) public view returns (bytes32) {
        return keccak256(abi.encode(domain, terms));
    }

    /// @notice Verify one slice of a ticket and move its value from the private book to escrow.
    /// The first proved reservation opens the batch. No empty queue can block an amount.
    /// PoolSpend.change stays private. refundOwner opens a fresh note of exactly `value` if the batch fails.
    function reserve(bytes calldata proof, PoolSpend calldata spend, BatchTerms calldata terms,
        uint64 value, bytes32 refundOwner) external transition
    {
        _recipient(terms.recipient);
        Batch storage b = _openOrJoin(terms);
        bytes32 id = ticketId(terms);
        Ticket storage t = tickets[id];
        if (value == 0 || value > terms.amount - t.funded) revert InvalidAmount();
        bytes32 refundLeaf = commitment(value, refundOwner);
        _reserveSpend(proof, spend, id, value, refundOwner);
        refunds[spend.nullifiers[0]] = Refund(id, refundLeaf, value);
        reservedNative += value;
        t.funded += value;
        ++t.parts;
        if (t.funded == terms.amount) {
            if (b.queuedRecipient[terms.recipient]) revert InvalidBatch();
            b.queuedRecipient[terms.recipient] = true;
            t.recipient = terms.recipient;
            b.entries.push(id);
            emit TicketQueued(terms.amount, terms.round, id);
            if (b.entries.length == b.target) emit BatchFilled(terms.amount, terms.round);
        }
        emit PartReserved(id, spend.nullifiers[0], value, refundLeaf);
    }

    /// @notice Permissionless single-transaction settlement. A failed payment reverts **every**
    /// payment. Bounded gas per receiver prevents one callback from monopolizing the transaction.
    function executeBatch(uint256 amount, uint64 round) external transition {
        Batch storage b = batches[amount][round];
        uint256 n = b.entries.length;
        if (b.paid || block.timestamp >= b.expiresAt || n != b.target || n == 0) revert BatchNotReady();
        b.paid = true;
        (uint256 fee, uint256 net) = quoteFee(amount);
        reservedNative -= amount * n;
        uint64 release;
        for (uint256 i; i < n; ++i) release += tickets[b.entries[i]].parts;
        reservedRefundLeaves -= release;
        _fundPayoutFee(fee * n); // equal per ticket, with one bounded relayer rebate for the batch
        for (uint256 i; i < n; ++i) {
            (bool ok,) = tickets[b.entries[i]].recipient.call{value: net, gas: BATCH_RECEIVE_GAS}("");
            if (!ok) revert PayoutFailed(i);
        }
        emit BatchPaid(amount, round, uint8(n), net * n, fee * n);
    }

    /// @notice After expiry, or on settlement that excluded this incomplete ticket, anyone can
    /// restore this slice to its proof-bound private note. The keeper never learns the opening.
    function refundPart(BatchTerms calldata terms, bytes32 nullifier) external transition {
        Refund memory r = refunds[nullifier];
        if (r.value == 0 || r.ticket != ticketId(terms)) revert RefundUnavailable();
        Batch storage b = batches[terms.amount][terms.round];
        if (b.paid ? tickets[r.ticket].funded == terms.amount : block.timestamp < b.expiresAt) revert RefundUnavailable();
        delete refunds[nullifier];
        --reservedRefundLeaves;
        reservedNative -= r.value;
        shieldedNative += r.value;
        uint64 at = _append(r.leaf, bytes32(0), false);
        emit Refunded(nullifier, r.leaf, at, r.value);
    }

    function _openOrJoin(BatchTerms calldata terms) private returns (Batch storage b) {
        uint64 last = latestRound[terms.amount];
        Batch storage previous = batches[terms.amount][last];
        bool live = !previous.paid && block.timestamp < previous.expiresAt;
        if (live) {
            if (terms.round != last || terms.target != previous.target || previous.entries.length == previous.target) {
                revert InvalidBatch();
            }
            return previous;
        }
        if (terms.amount == 0 || terms.round != last + 1 || terms.target < MIN_TARGET || terms.target > MAX_TARGET) {
            revert InvalidBatch();
        }
        latestRound[terms.amount] = terms.round;
        b = batches[terms.amount][terms.round];
        b.target = terms.target;
        b.expiresAt = uint64(block.timestamp + BATCH_LIFETIME);
        emit BatchOpened(terms.amount, terms.round, terms.target, b.expiresAt);
    }

    function _reserveSpend(bytes calldata proof, PoolSpend calldata spend, bytes32 id, uint64 value, bytes32 refundOwner) private {
        uint256 h = uint256(keccak256(abi.encode(BATCH_TAG, id, refundOwner)));
        ++reservedRefundLeaves;
        // Nonzero limb 27 separates reservations from direct payments. Never pay these
        // synthetic addresses. Normally they carry all 256 binding bits; at 1 wei there
        // is no second amount leg, so limb 27 and one address carry 223 bits instead.
        if (value == 1) {
            _consume(proof, spend, 1, 0, 1 + uint64((h >> 160) & (type(uint64).max >> 1)), address(uint160(h)), address(0));
        } else {
            _consume(proof, spend, value - 1, 1, 1,
                address(uint160((1 << 128) | (h >> 128))), address(uint160((1 << 128) | uint128(h))));
        }
    }

    function _consume(bytes calldata proof, PoolSpend calldata s, uint64 amount, uint64 fee, uint64 tag,
        address recipient, address feeRecipient) internal
    {
        uint256 debit = uint256(amount) + fee;
        if (amount == 0 || debit > maxNoteValue() || debit > shieldedNative) revert InvalidAmount();
        if (!knownRoot[s.root]) revert UnknownRoot();
        if (s.notBefore == 0 || s.notBefore % TIME_GRID != 0 || s.notBefore > block.timestamp || s.notBefore >= Goldilocks.P) {
            revert InvalidTime();
        }
        if (s.nullifiers[0] == s.nullifiers[1]) revert InvalidNullifier();
        if (spent[s.nullifiers[0]] || spent[s.nullifiers[1]]) revert AlreadySpent();
        if (s.change[0] == domainLeaf || s.change[1] == domainLeaf) revert InvalidCommitment();
        _spaceFor(2);
        uint256[] memory w = new uint256[](37);
        _limbs(w, 0, s.root);
        _limbs(w, 4, s.root);
        _limbs(w, 8, s.nullifiers[0]);
        _limbs(w, 12, s.nullifiers[1]);
        _limbs(w, 16, s.change[0]);
        _limbs(w, 20, s.change[1]);
        w[24] = amount;
        w[25] = fee;
        // Asset limb 26 is 0 (Ethereum native ETH). Limb 27 is an authorization tag, not a price.
        w[27] = tag;
        _address(w, 28, recipient);
        _address(w, 32, feeRecipient);
        w[36] = s.notBefore;
        _verifyNote(proof, w);
        spent[s.nullifiers[0]] = true;
        spent[s.nullifiers[1]] = true;
        emit NullifiersSpent(s.nullifiers[0], s.nullifiers[1]);
        shieldedNative -= debit;
        _append(s.change[0], s.change[1], true);
    }

    function _spaceFor(uint256 leaves) private view {
        if (uint256(leafCount) + reservedRefundLeaves + leaves > (1 << TREE_DEPTH)) revert NoteTreeFull();
    }

    function _recipient(address to) internal view {
        if (to == address(0) || to == address(this) || to == address(feeStaking)) revert InvalidRecipient();
    }

    function _limbs(uint256[] memory w, uint256 at, bytes32 d) private pure {
        if (d == bytes32(0) || !Goldilocks.isCanonicalDigest(d)) revert InvalidCommitment();
        for (uint256 i; i < 4; ++i) w[at + i] = Goldilocks.limb(d, i);
    }

    function _address(uint256[] memory w, uint256 at, address to) private pure {
        for (uint256 i; i < 4; ++i) w[at + i] = uint48(uint160(to) >> (i * 48));
    }

    function _verifyNote(bytes calldata proof, uint256[] memory words) internal view virtual;
}

/// Shared constructor checks for the legacy lab verifier and ETH note tree.
abstract contract EthPoolVerified is NativeStark, EthPoolState {
    // solc 0.8.24, Paris, optimizer 200, metadata bytecodeHash none.
    bytes32 public constant POSEIDON_CODEHASH = 0x9d4eb630ae4b1e0d86c3cdc3f909ab54fd0a65bd512063ca514a29c3f30515cf;
    error WrongPoseidonCode();
    error LegacyProfileLocalOnly();

    function _pinnedHasher(address hasher) internal view returns (PoseidonGoldilocks) {
        if (hasher.codehash != POSEIDON_CODEHASH) revert WrongPoseidonCode();
        return PoseidonGoldilocks(hasher);
    }

    function _verifyNote(bytes calldata proof, uint256[] memory words) internal view override {
        _verifyStark(proof, words);
    }
}
