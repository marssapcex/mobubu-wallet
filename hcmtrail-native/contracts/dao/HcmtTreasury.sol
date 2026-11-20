// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HcmtPolicy} from "./HcmtPolicy.sol";
import {HcmtPins} from "./HcmtPins.sol";
import {HcmtToken} from "./HcmtToken.sol";
import {HcmtStakeGate, StakePermit} from "./HcmtStakeGate.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";

/// @notice Immutable local native-fee treasury and STARK-authorized HCMT stake escrow. No admin or sweep.
/// Positions are effective from the next period. Ended-period rewards use these historical weights.
contract HcmtTreasury {
    uint256 public constant PERIOD = HcmtPolicy.PERIOD;
    uint256 public constant RELAY_BOND = HcmtPolicy.RELAY_BOND;
    uint256 public constant MAX_CLOSE = 24;
    uint256 public constant MAX_CLAIM = 32;

    struct Checkpoint { uint64 period; uint192 weight; }
    struct Unlock { uint64 period; uint192 amount; address recipient; }
    struct Authority { bytes32 root; uint64 nonce; }
    struct Reward { uint256 pot; uint256 weight; uint256 claimedWeight; uint256 remaining; }

    HcmtToken public hcmt;
    HcmtStakeGate public stakeGate;
    uint256 public homeChainId;
    uint256 public startedAt;
    uint64 public nextToClose;
    uint256 public carryNative;
    uint256 public reservedNative;
    mapping(uint64 => uint256) public receiptsByPeriod;
    mapping(uint64 => Reward) public rewards;
    mapping(uint64 => mapping(address => bool)) public claimed;
    mapping(address => Unlock) public unlocks;
    mapping(address => Authority) public authorities;
    mapping(address => Checkpoint[]) private accounts;
    Checkpoint[] private aggregate;
    bool private entered;

    event Revenue(uint64 indexed period, address indexed from, uint256 amount);
    event StakeScheduled(address indexed staker, uint64 indexed effectivePeriod, uint256 weight);
    event StakeAuthorityRegistered(address indexed staker, bytes32 root);
    event StakeAuthorized(address indexed staker, uint64 indexed nonce, bytes32 challenge);
    event UnlockScheduled(address indexed staker, address indexed recipient, uint64 period, uint256 amount);
    event StakeReleased(address indexed staker, address indexed recipient, uint256 amount);
    event PeriodClosed(uint64 indexed period, uint256 pot, uint256 weight, uint256 carried);
    event RoundingRecycled(uint64 indexed period, uint256 amount);
    event RewardClaimed(uint64 indexed period, address indexed staker, address indexed recipient, uint256 amount);
    error WrongChain();
    error WrongToken();
    error InvalidAuthority();
    error WrongStakeNonce();
    error WrongUnlockPeriod();
    error InvalidRecipient();
    error InvalidAmount();
    error PendingUnlock();
    error StillLocked();
    error InvalidBatch();
    error PeriodNotClosed();
    error NothingToClaim();
    error AlreadyClaimed();
    error NativeTransferFailed();
    error Reentrant();

    constructor(HcmtToken token, address prepare, address walk, address[3] memory chunks) {
        uint256 chain = block.chainid;
        if (!HcmtPolicy.supported(chain)) revert WrongChain();
        if (address(token).codehash != HcmtPins.token(chain == 0xcd8690dc)
            || token.homeChainId() != chain || token.totalSupply() != HcmtPolicy.LOCAL_SUPPLY) revert WrongToken();
        hcmt = token;
        stakeGate = new HcmtStakeGate(chain == 0xcd8690dc, prepare, walk, chunks);
        homeChainId = chain;
        startedAt = block.timestamp;
        nextToClose = 1;
    }

    modifier guard() {
        if (block.chainid != homeChainId) revert WrongChain();
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    // Each payment is attributed at receipt time, even if nobody calls close for several months.
    // Forced balance changes (e.g. SELFDESTRUCT) are not included as fee revenue.
    receive() external payable {
        if (block.chainid != homeChainId) revert WrongChain();
        uint64 period = currentPeriod();
        receiptsByPeriod[period] += msg.value;
        emit Revenue(period, msg.sender, msg.value);
    }

    function currentPeriod() public view returns (uint64) {
        return uint64((block.timestamp - startedAt) / PERIOD + 1);
    }

    function stakeAt(address who, uint64 period) public view returns (uint256) {
        return _at(accounts[who], period);
    }

    function totalAt(uint64 period) public view returns (uint256) {
        return _at(aggregate, period);
    }

    function isBroadcaster(address who) external view returns (bool) {
        return block.chainid == homeChainId && stakeAt(who, currentPeriod()) >= RELAY_BOND;
    }

    /// @notice A caller locks its own HCMT. Its independently held proof credential is fixed on first lock.
    function stake(uint256 amount, bytes32 authRoot) external guard {
        if (amount == 0 || amount > HcmtPolicy.LOCAL_SUPPLY) revert InvalidAmount();
        Authority storage auth = authorities[msg.sender];
        if (auth.root == bytes32(0)) {
            if (authRoot == bytes32(0) || !Goldilocks.isCanonicalDigest(authRoot)) revert InvalidAuthority();
            auth.root = authRoot;
            emit StakeAuthorityRegistered(msg.sender, authRoot);
        } else if (authRoot != auth.root) {
            revert InvalidAuthority();
        }
        uint64 next = currentPeriod() + 1;
        _schedule(msg.sender, next, stakeAt(msg.sender, next) + amount, totalAt(next) + amount);
        if (!hcmt.transferFrom(msg.sender, address(this), amount)) revert InvalidAmount();
    }

    /// @notice Only the proof can schedule an unlock; a gas signer cannot choose the recipient or period.
    function requestUnstake(address staker, uint256 amount, address recipient, uint64 effectivePeriod,
        bytes calldata proof, StakePermit calldata permit) external guard
    {
        _recipient(recipient);
        if (effectivePeriod != currentPeriod() + 1) revert WrongUnlockPeriod();
        uint256 weight = stakeAt(staker, effectivePeriod);
        if (amount == 0 || amount > weight) revert InvalidAmount();
        if (unlocks[staker].amount != 0) revert PendingUnlock();
        _authorize(staker, keccak256(abi.encode(uint8(1), amount, recipient, effectivePeriod)), proof, permit);
        unlocks[staker] = Unlock(effectivePeriod, uint192(amount), recipient);
        _schedule(staker, effectivePeriod, weight - amount, totalAt(effectivePeriod) - amount);
        emit UnlockScheduled(staker, recipient, effectivePeriod, amount);
    }

    /// @notice Anyone may finish a matured unlock. Amount and recipient were fixed by its proof.
    function releaseStake(address staker) external guard {
        Unlock memory u = unlocks[staker];
        if (u.amount == 0 || currentPeriod() < u.period) revert StillLocked();
        delete unlocks[staker];
        if (!hcmt.transfer(u.recipient, u.amount)) revert InvalidAmount();
        emit StakeReleased(staker, u.recipient, u.amount);
    }

    function stakeChallenge(address staker, uint64 nonce, bytes32 action) public view returns (bytes32) {
        return keccak256(abi.encode("HCMTRAIL-HCMT-STAKE-AUTH-v1", homeChainId, address(this), staker, nonce, action));
    }

    function _authorize(address staker, bytes32 action, bytes calldata proof, StakePermit calldata permit) private {
        Authority storage auth = authorities[staker];
        if (auth.root == bytes32(0)) revert InvalidAuthority();
        if (permit.nonce != auth.nonce) revert WrongStakeNonce();
        bytes32 challenge = stakeChallenge(staker, permit.nonce, action);
        stakeGate.verify(proof, auth.root, challenge, permit);
        // The reusable credential is not a money note. This nonce, not the synthetic circuit
        // nullifier, prevents replay. It is consumed atomically with the authorized transition.
        ++auth.nonce;
        emit StakeAuthorized(staker, permit.nonce, challenge);
    }

    function _recipient(address who) private view {
        if (who == address(0) || who == address(this) || who == address(hcmt)) revert InvalidRecipient();
    }

    /// @notice Anyone may close ended periods, with bounded work. Accounts never need to roll in a loop.
    /// Periods with zero stakes carry all revenue forward, without assigning it to a single caller.
    function closePeriods(uint256 count) external guard {
        uint64 end = currentPeriod();
        if (count == 0 || count > MAX_CLOSE || nextToClose >= end) revert InvalidBatch();
        while (count != 0 && nextToClose < end) {
            uint64 period = nextToClose++;
            uint256 pot = receiptsByPeriod[period] + carryNative;
            uint256 weight = totalAt(period);
            if (weight == 0) {
                carryNative = pot;
                emit PeriodClosed(period, 0, 0, pot);
            } else {
                carryNative = 0;
                reservedNative += pot;
                rewards[period] = Reward(pot, weight, 0, pot);
                emit PeriodClosed(period, pot, weight, 0);
            }
            --count;
        }
    }

    function claimable(address who, uint64 period) external view returns (uint256) {
        Reward storage r = rewards[period];
        if (period >= nextToClose || claimed[period][who] || r.weight == 0) return 0;
        return _share(r.pot, stakeAt(who, period), r.weight);
    }

    /// @notice Claim closed periods for a staker, to exactly the recipient authorized by their proof.
    function claim(address staker, address payable recipient, uint64[] calldata periods,
        bytes calldata proof, StakePermit calldata permit) external guard returns (uint256 paid)
    {
        _recipient(recipient);
        if (periods.length == 0 || periods.length > MAX_CLAIM) revert InvalidBatch();
        for (uint256 i; i < periods.length; ++i) {
            uint64 period = periods[i];
            if (period == 0 || period >= nextToClose) revert PeriodNotClosed();
            if (claimed[period][staker]) revert AlreadyClaimed();
            Reward storage r = rewards[period];
            uint256 weight = stakeAt(staker, period);
            if (weight == 0 || r.weight == 0) revert NothingToClaim();
            uint256 due = _share(r.pot, weight, r.weight);
            claimed[period][staker] = true;
            r.claimedWeight += weight;
            r.remaining -= due;
            reservedNative -= due;
            paid += due;
            // Only release rounding dust after the ENTIRE historical stake weight has claimed.
            if (r.claimedWeight == r.weight) {
                uint256 dust = r.remaining;
                r.remaining = 0;
                reservedNative -= dust;
                if (dust != 0) {
                    uint64 active = currentPeriod();
                    receiptsByPeriod[active] += dust;
                    emit RoundingRecycled(active, dust);
                }
            }
            emit RewardClaimed(period, staker, recipient, due);
        }
        _authorize(staker, keccak256(abi.encode(uint8(2), recipient, periods)), proof, permit);
        if (paid != 0) {
            (bool sent,) = recipient.call{value: paid}("");
            if (!sent) revert NativeTransferFailed();
        }
    }

    function _share(uint256 pot, uint256 weight, uint256 total) private pure returns (uint256) {
        // Exact floor(pot * weight / total). total <= 250k * 1e18, so residual multiplication fits uint256.
        return (pot / total) * weight + (pot % total) * weight / total;
    }

    function _schedule(address who, uint64 period, uint256 weight, uint256 total) private {
        if (total > HcmtPolicy.LOCAL_SUPPLY || weight > total) revert InvalidAmount();
        _write(accounts[who], period, uint192(weight));
        _write(aggregate, period, uint192(total));
        emit StakeScheduled(who, period, weight);
    }

    function _write(Checkpoint[] storage list, uint64 period, uint192 weight) private {
        uint256 n = list.length;
        if (n != 0 && list[n - 1].period == period) list[n - 1].weight = weight;
        else list.push(Checkpoint(period, weight));
    }

    function _at(Checkpoint[] storage list, uint64 period) private view returns (uint256) {
        uint256 low;
        uint256 high = list.length;
        while (low < high) {
            uint256 mid = low + (high - low) / 2;
            if (list[mid].period > period) high = mid;
            else low = mid + 1;
        }
        return low == 0 ? 0 : list[low - 1].weight;
    }
}
