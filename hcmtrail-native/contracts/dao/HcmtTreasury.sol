// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HcmtPolicy} from "./HcmtPolicy.sol";
import {HcmtPins} from "./HcmtPins.sol";
import {HcmtToken} from "./HcmtToken.sol";

/// @notice Immutable local native-fee treasury and HCMT stake escrow. No keys, transfers across chains, or sweep.
/// Positions are effective from the next period. Ended-period rewards use these historical weights.
contract HcmtTreasury {
    uint256 public constant PERIOD = HcmtPolicy.PERIOD;
    uint256 public constant RELAY_BOND = HcmtPolicy.RELAY_BOND;
    uint256 public constant MAX_CLOSE = 24;
    uint256 public constant MAX_CLAIM = 32;

    struct Checkpoint { uint64 period; uint192 weight; }
    struct Unlock { uint64 period; uint192 amount; }
    struct Reward { uint256 pot; uint256 weight; uint256 claimedWeight; uint256 remaining; }

    HcmtToken public hcmt;
    uint256 public homeChainId;
    uint256 public startedAt;
    uint64 public nextToClose;
    uint256 public carryNative;
    uint256 public reservedNative;
    mapping(uint64 => uint256) public receiptsByPeriod;
    mapping(uint64 => Reward) public rewards;
    mapping(uint64 => mapping(address => bool)) public claimed;
    mapping(address => Unlock) public unlocks;
    mapping(address => Checkpoint[]) private accounts;
    Checkpoint[] private aggregate;
    bool private entered;

    event Revenue(uint64 indexed period, address indexed from, uint256 amount);
    event StakeScheduled(address indexed staker, uint64 indexed effectivePeriod, uint256 weight);
    event StakeReleased(address indexed staker, uint256 amount);
    event PeriodClosed(uint64 indexed period, uint256 pot, uint256 weight, uint256 carried);
    event RoundingRecycled(uint64 indexed period, uint256 amount);
    event RewardClaimed(uint64 indexed period, address indexed staker, uint256 amount);
    error WrongChain();
    error WrongToken();
    error InvalidAmount();
    error PendingUnlock();
    error StillLocked();
    error InvalidBatch();
    error PeriodNotClosed();
    error NothingToClaim();
    error AlreadyClaimed();
    error NativeTransferFailed();
    error Reentrant();

    constructor(HcmtToken token) {
        uint256 chain = block.chainid;
        if (!HcmtPolicy.supported(chain)) revert WrongChain();
        if (address(token).codehash != HcmtPins.token(chain == 0xcd8690dc)
            || token.homeChainId() != chain || token.totalSupply() != HcmtPolicy.LOCAL_SUPPLY) revert WrongToken();
        hcmt = token;
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

    function stake(uint256 amount) external guard {
        if (amount == 0 || amount > HcmtPolicy.LOCAL_SUPPLY) revert InvalidAmount();
        uint64 next = currentPeriod() + 1;
        _schedule(msg.sender, next, stakeAt(msg.sender, next) + amount, totalAt(next) + amount);
        if (!hcmt.transferFrom(msg.sender, address(this), amount)) revert InvalidAmount();
    }

    function requestUnstake(uint256 amount) external guard {
        uint64 next = currentPeriod() + 1;
        uint256 weight = stakeAt(msg.sender, next);
        if (amount == 0 || amount > weight) revert InvalidAmount();
        Unlock storage u = unlocks[msg.sender];
        if (u.amount != 0 && u.period != next) revert PendingUnlock();
        u.period = next;
        u.amount += uint192(amount);
        _schedule(msg.sender, next, weight - amount, totalAt(next) - amount);
    }

    function releaseStake() external guard {
        Unlock memory u = unlocks[msg.sender];
        if (u.amount == 0 || currentPeriod() < u.period) revert StillLocked();
        delete unlocks[msg.sender];
        if (!hcmt.transfer(msg.sender, u.amount)) revert InvalidAmount();
        emit StakeReleased(msg.sender, u.amount);
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

    /// @notice Claim multiple periods together; payout always goes to the staker (no redirect parameter).
    function claim(uint64[] calldata periods) external guard returns (uint256 paid) {
        if (periods.length == 0 || periods.length > MAX_CLAIM) revert InvalidBatch();
        for (uint256 i; i < periods.length; ++i) {
            uint64 period = periods[i];
            if (period == 0 || period >= nextToClose) revert PeriodNotClosed();
            if (claimed[period][msg.sender]) revert AlreadyClaimed();
            Reward storage r = rewards[period];
            uint256 weight = stakeAt(msg.sender, period);
            if (weight == 0 || r.weight == 0) revert NothingToClaim();
            uint256 due = _share(r.pot, weight, r.weight);
            claimed[period][msg.sender] = true;
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
            emit RewardClaimed(period, msg.sender, due);
        }
        if (paid != 0) {
            (bool sent,) = payable(msg.sender).call{value: paid}("");
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
