// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HcmtToken} from "./HcmtToken.sol";

interface IStakeToken {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// One immutable ERC-20 stake token, ETH rewards, no owner or sweep. Epochs are
/// fixed 30-day intervals from deployment. Stake and exit requests take effect at
/// the next boundary, so the shares used to distribute each month are constant.
contract EthFeeStaking {
    uint256 public constant PERIOD = 30 days;
    uint256 private constant SCALE = 1 << 128;
    uint256 public constant MIN_RELAY_STAKE = 100 ether; // 100 HCMT (18 decimals)
    uint256 public constant MAX_RELAY_REWARD = 0.003 ether; // per successful payout; one cap per batch
    uint256 public immutable start;
    address public immutable feeSource;
    bool public immutable relayEnabled;
    IStakeToken public immutable stakeToken;

    uint64 public settledEpoch;
    uint128 public activeStake;
    uint128 public nextStake;
    uint128 public heldStake;
    uint128 public fundedWei;
    uint128 public claimedWei;
    uint256 public rewardIndex;
    uint256 public relayFundedWei;
    uint256 public relayClaimedWei;
    mapping(address relayer => uint256 amount) public relayCredit;
    uint256 private undistributed;
    bool private entered;

    struct Position {
        uint128 active;
        uint128 next;
        uint128 exiting;
        uint128 withdrawable;
        uint64 changesAt;
        uint256 index;
        uint256 credit;
    }

    struct Projection {
        uint64 epoch;
        uint256 boundaryIndex;
        uint256 index;
        uint256 remaining;
    }

    mapping(uint64 epoch => uint256 index) private indexAt;
    mapping(address account => Position) private positions;

    event FeesFunded(uint64 indexed epoch, address indexed from, uint256 amount);
    event EpochAdvanced(uint64 indexed epoch, uint128 active, uint256 index, uint256 unassignedWei);
    event StakeScheduled(address indexed account, uint64 indexed epoch, uint128 amount);
    event ExitScheduled(address indexed account, uint64 indexed epoch, uint128 amount);
    event StakeWithdrawn(address indexed account, address indexed to, uint128 amount);
    event RewardClaimed(address indexed account, address indexed to, uint256 amount);
    event RelayRewardCredited(address indexed executor, uint256 totalFee, uint256 reward);
    event RelayRewardClaimed(address indexed executor, address indexed to, uint256 reward);

    error InvalidToken();
    error InvalidAmount();
    error InvalidRecipient();
    error TokenTransferFailed();
    error EthTransferFailed();
    error Reentrant();
    error InvalidFeeSource();

    constructor(address token) {
        if (token.code.length == 0) revert InvalidToken();
        stakeToken = IStakeToken(token);
        feeSource = msg.sender;
        // Only the Ethereum lab uses HCMT. Synthetic LAB on the other two
        // lanes never qualifies for relay rewards. No token/admin can opt in.
        relayEnabled = block.chainid == 31337 && token.codehash == keccak256(type(HcmtToken).runtimeCode);
        start = block.timestamp;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function currentEpoch() public view returns (uint64) {
        return uint64((block.timestamp - start) / PERIOD);
    }

    /// @notice Pool fees go straight into the current epoch. The same entry point
    /// accepts voluntary ETH funding. Forced ETH does not create rewards.
    function fundFees() external payable nonReentrant {
        _fundFees(msg.value);
    }

    function relayEligible(address executor) public view returns (bool) {
        if (!relayEnabled) return false;
        Position storage p = positions[executor];
        uint128 active = p.changesAt != 0 && p.changesAt <= currentEpoch() ? p.next : p.active;
        return active >= MIN_RELAY_STAKE;
    }

    function quoteRelayReward(address executor, uint256 totalFee) public view returns (uint256) {
        if (!relayEligible(executor)) return 0;
        uint256 reward = totalFee / 2;
        return reward > MAX_RELAY_REWARD ? MAX_RELAY_REWARD : reward;
    }

    /// @notice Only the pool calls this for actual payouts, once per batch.
    /// The user pays the same fee with or without a relayer. Deposits, refunds
    /// and message delivery have no rebate. No calls to relayer code here.
    function fundPayoutFees(address executor) external payable nonReentrant {
        if (msg.sender != feeSource) revert InvalidFeeSource();
        uint256 reward = quoteRelayReward(executor, msg.value);
        _fundFees(msg.value - reward);
        if (reward != 0) {
            relayCredit[executor] += reward;
            relayFundedWei += reward;
            emit RelayRewardCredited(executor, msg.value, reward);
        }
    }

    /// Claim earned relay credit independently of the monthly staking reward.
    /// Exiting stake disables future rebates, not these earned credits.
    function claimRelayReward(address payable to) external nonReentrant returns (uint256 amount) {
        _checkRecipient(to);
        amount = relayCredit[msg.sender];
        if (amount == 0) return 0;
        relayCredit[msg.sender] = 0;
        relayClaimedWei += amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit RelayRewardClaimed(msg.sender, to, amount);
    }

    function _fundFees(uint256 amount) private {
        // The lifetime bound ensures all scaled values, including the sum of every
        // index increment, fit in 256 bits even with only one unit of stake.
        if (amount == 0 || amount > type(uint128).max - fundedWei) revert InvalidAmount();
        _roll();
        fundedWei += uint128(amount);
        undistributed += amount * SCALE;
        emit FeesFunded(settledEpoch, msg.sender, amount);
    }

    function checkpoint() external nonReentrant {
        _roll();
    }

    function stake(uint128 amount) external nonReentrant {
        if (amount == 0 || amount > type(uint128).max - heldStake) revert InvalidAmount();
        Position memory p = _load(msg.sender);
        p.next += amount;
        p.changesAt = settledEpoch + 1;
        nextStake += amount;
        heldStake += amount;
        positions[msg.sender] = p;
        uint256 beforeBalance = stakeToken.balanceOf(address(this));
        _transfer(abi.encodeCall(IStakeToken.transferFrom, (msg.sender, address(this), uint256(amount))));
        if (stakeToken.balanceOf(address(this)) != beforeBalance + amount) revert TokenTransferFailed();
        emit StakeScheduled(msg.sender, p.changesAt, amount);
    }

    /// Schedule an exit without giving up the rewards of the current epoch. The
    /// tokens stay escrowed until the same boundary that reduces reward shares.
    function requestUnstake(uint128 amount) external nonReentrant {
        Position memory p = _load(msg.sender);
        if (amount == 0 || amount > p.next) revert InvalidAmount();
        p.next -= amount;
        p.exiting += amount;
        p.changesAt = settledEpoch + 1;
        nextStake -= amount;
        positions[msg.sender] = p;
        emit ExitScheduled(msg.sender, p.changesAt, amount);
    }

    function withdrawStake(uint128 amount, address to) external nonReentrant {
        _checkRecipient(to);
        Position memory p = _load(msg.sender);
        if (amount == 0 || amount > p.withdrawable) revert InvalidAmount();
        p.withdrawable -= amount;
        heldStake -= amount;
        positions[msg.sender] = p;
        uint256 beforeBalance = stakeToken.balanceOf(address(this));
        uint256 beforeRecipient = stakeToken.balanceOf(to);
        _transfer(abi.encodeCall(IStakeToken.transfer, (to, uint256(amount))));
        if (stakeToken.balanceOf(address(this)) != beforeBalance - amount
            || stakeToken.balanceOf(to) != beforeRecipient + amount) revert TokenTransferFailed();
        emit StakeWithdrawn(msg.sender, to, amount);
    }

    /// @notice Collect all whole wei earned in closed epochs, without touching
    /// principal. Fractional credit is retained; ETH is never sent in a loop.
    function claim(address payable to) external nonReentrant returns (uint256 amount) {
        _checkRecipient(to);
        Position memory p = _load(msg.sender);
        amount = p.credit / SCALE;
        p.credit %= SCALE;
        positions[msg.sender] = p;
        if (amount == 0) return 0;
        claimedWei += uint128(amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit RewardClaimed(msg.sender, to, amount);
    }

    /// Includes elapsed boundaries even when no keeper or user has sent a tx.
    function epochState() external view returns (uint64 epoch, uint256 closesAt, uint128 active, uint128 scheduled, uint256 potWei) {
        Projection memory q = _project();
        return (q.epoch, start + (uint256(q.epoch) + 1) * PERIOD,
            q.epoch == settledEpoch ? activeStake : nextStake, nextStake, q.remaining / SCALE);
    }

    function position(address account) external view returns (uint128 active, uint128 scheduled, uint128 exiting, uint128 withdrawable, uint256 claimable) {
        Position memory p = _measure(positions[account], _project());
        return (p.active, p.next, p.exiting, p.withdrawable, p.credit / SCALE);
    }

    function _project() private view returns (Projection memory q) {
        q = Projection(currentEpoch(), rewardIndex, rewardIndex, undistributed);
        if (q.epoch == settledEpoch) return q;
        (q.boundaryIndex, q.remaining) = _distribute(q.index, q.remaining, activeStake);
        q.index = q.boundaryIndex;
        // At most one queued global change can be outstanding. No transaction can
        // fund an intervening epoch without rolling first. If that next epoch has
        // also ended, distribute any carry (e.g. the first month had no stake).
        // Further skipped epochs have the same stake and no new whole rewards.
        if (q.epoch - settledEpoch > 1) {
            (q.index, q.remaining) = _distribute(q.index, q.remaining, nextStake);
        }
    }

    function _distribute(uint256 index, uint256 amount, uint128 shares) private pure returns (uint256, uint256) {
        if (shares == 0) return (index, amount);
        return (index + amount / shares, amount % shares);
    }

    function _roll() private {
        Projection memory q = _project();
        if (q.epoch == settledEpoch) return;
        // Accounts only ever queue changes for this next boundary. Write its
        // index before skipping to the current epoch, to split their accrual.
        indexAt[settledEpoch + 1] = q.boundaryIndex;
        activeStake = nextStake;
        settledEpoch = q.epoch;
        rewardIndex = q.index;
        undistributed = q.remaining;
        emit EpochAdvanced(q.epoch, activeStake, rewardIndex, q.remaining / SCALE);
    }

    function _load(address account) private returns (Position memory) {
        _roll();
        return _measure(positions[account], Projection(settledEpoch, rewardIndex, rewardIndex, undistributed));
    }

    function _measure(Position memory p, Projection memory q) private view returns (Position memory) {
        if (p.changesAt != 0 && p.changesAt <= q.epoch) {
            uint256 cut = p.changesAt > settledEpoch ? q.boundaryIndex : indexAt[p.changesAt];
            p.credit += uint256(p.active) * (cut - p.index);
            p.index = cut;
            p.active = p.next;
            p.withdrawable += p.exiting;
            p.exiting = 0;
            p.changesAt = 0;
        }
        p.credit += uint256(p.active) * (q.index - p.index);
        p.index = q.index;
        return p;
    }

    function _checkRecipient(address to) private view {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
    }

    function _transfer(bytes memory data) private {
        (bool ok, bytes memory result) = address(stakeToken).call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenTransferFailed();
    }
}
