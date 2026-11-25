// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthFeeStaking} from "../../contracts/ethereum/EthFeeStaking.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";

contract StakeActor {
    receive() external payable {}

    function add(HcmtToken coin, EthFeeStaking s, uint128 amount) external {
        assert(coin.approve(address(s), amount));
        s.stake(amount);
    }
    function exit(EthFeeStaking s, uint128 amount) external { s.requestUnstake(amount); }
    function withdraw(EthFeeStaking s, uint128 amount) external { s.withdrawStake(amount, address(this)); }
    function claim(EthFeeStaking s) external returns (uint256) { return s.claim(payable(this)); }
    function relayClaim(EthFeeStaking s) external returns (uint256) { return s.claimRelayReward(payable(this)); }
}

/// Independent per-epoch, per-account reference. Unlike production, this
/// deliberately walks every elapsed epoch AND every account. Small closed model.
/// Payout fees enter through the real EthFeeStaking API, with this test harness
/// as the immutable feeSource. Vault integration is checked separately.
contract StakeCampaign {
    uint256 private constant SCALE = 1 << 128;
    uint256 private constant WALLET = 1_000 ether;
    uint256 private constant PERIOD = 30 days;
    uint256 private constant MIN = 100 ether;
    uint256 private constant CAP = 0.003 ether;
    HcmtToken internal immutable coin;
    EthFeeStaking internal immutable staking;
    StakeActor[3] private actors;

    struct Account {
        uint128 active;
        uint128 next;
        uint128 exiting;
        uint128 unlocked;
        uint256 fractions;
        uint256 relay;
    }
    Account[3] private model;
    uint64 private epoch;
    uint256 private pot;
    uint256 private funded;
    uint256 private claimed;
    uint256 private relayFunded;
    uint256 private relayClaimed;

    constructor() payable {
        coin = new HcmtToken(address(this));
        staking = new EthFeeStaking(address(coin));
        assert(staking.relayEnabled() == (block.chainid == 31337));
        for (uint256 i; i < 3; ++i) {
            actors[i] = new StakeActor();
            assert(coin.transfer(address(actors[i]), WALLET));
        }
    }

    function _sync() internal {
        uint256 elapsed = (block.timestamp - staking.start()) / PERIOD;
        while (epoch < elapsed) {
            uint256 shares = uint256(model[0].active) + model[1].active + model[2].active;
            uint256 portion;
            if (shares != 0) {
                portion = pot / shares;
                pot -= portion * shares;
            }
            for (uint256 i; i < 3; ++i) {
                Account storage a = model[i];
                a.fractions += uint256(a.active) * portion;
                a.active = a.next;
                a.unlocked += a.exiting;
                a.exiting = 0;
            }
            ++epoch;
        }
    }

    function step(uint256 seed) external {
        _sync();
        uint256 i = (seed >> 8) % 3;
        uint256 op = uint8(seed) % 8;
        uint256 raw = seed >> 16;
        Account storage a = model[i];
        StakeActor actor = actors[i];
        if (op == 0) {
            uint256 free = WALLET - uint256(a.next) - a.exiting - a.unlocked;
            uint256 top = free > 400 ether ? 400 ether : free;
            if (top != 0) {
                uint128 amount = uint128(raw % top + 1);
                actor.add(coin, staking, amount);
                a.next += amount;
            }
        } else if (op == 1 && a.next != 0) {
            uint128 amount = uint128(raw % a.next + 1);
            actor.exit(staking, amount);
            a.next -= amount;
            a.exiting += amount;
        } else if (op == 2 && a.unlocked != 0) {
            uint128 amount = uint128(raw % a.unlocked + 1);
            actor.withdraw(staking, amount);
            a.unlocked -= amount;
        } else if (op == 3 || op == 4) {
            uint256 amount = raw % 0.05 ether + 1;
            if (address(this).balance >= amount) {
                if (op == 3) staking.fundFees{value: amount}();
                else {
                    uint256 reward = _expectedRelay(a, amount);
                    assert(staking.quoteRelayReward(address(actor), amount) == reward);
                    staking.fundPayoutFees{value: amount}(address(actor));
                    a.relay += reward;
                    relayFunded += reward;
                    amount -= reward;
                }
                funded += amount;
                pot += amount * SCALE;
            }
        } else if (op == 5) {
            uint256 amount = a.fractions / SCALE;
            uint256 beforeBalance = address(actor).balance;
            assert(actor.claim(staking) == amount);
            assert(address(actor).balance - beforeBalance == amount);
            claimed += amount;
            a.fractions %= SCALE;
        } else if (op == 6) {
            uint256 amount = a.relay;
            uint256 beforeBalance = address(actor).balance;
            assert(actor.relayClaim(staking) == amount);
            assert(address(actor).balance - beforeBalance == amount);
            a.relay = 0;
            relayClaimed += amount;
        } else if (op == 7) {
            staking.checkpoint();
        }
        _assertPositions();
    }

    function _expectedRelay(Account storage a, uint256 amount) private view returns (uint256) {
        if (block.chainid != 31337 || a.active < MIN) return 0;
        uint256 half = amount / 2;
        return half > CAP ? CAP : half;
    }

    function _assertPositions() internal view {
        (uint64 period, , uint128 active, uint128 scheduled, uint256 waiting) = staking.epochState();
        assert(period == epoch && waiting == pot / SCALE);
        assert(active == uint256(model[0].active) + model[1].active + model[2].active);
        assert(scheduled == uint256(model[0].next) + model[1].next + model[2].next);
        for (uint256 i; i < 3; ++i) _assertAccount(i);
        assert(echidna_staking_backing());
    }

    function _assertAccount(uint256 i) private view {
        Account storage a = model[i];
        address owner = address(actors[i]);
        (uint128 active, uint128 next, uint128 exiting, uint128 unlocked, uint256 eth) = staking.position(owner);
        assert(active == a.active && next == a.next && exiting == a.exiting && unlocked == a.unlocked);
        assert(eth == a.fractions / SCALE && staking.relayCredit(owner) == a.relay);
        assert(staking.relayEligible(owner) == (block.chainid == 31337 && a.active >= MIN));
        assert(coin.balanceOf(owner) == WALLET - uint256(next) - exiting - unlocked);
    }

    function echidna_staking_backing() public view returns (bool) {
        uint256 held;
        uint256 rebate;
        for (uint256 i; i < 3; ++i) {
            held += uint256(model[i].next) + model[i].exiting + model[i].unlocked;
            rebate += model[i].relay;
        }
        return coin.totalSupply() == 100_000 ether && staking.heldStake() == held && coin.balanceOf(address(staking)) == held
            && staking.fundedWei() == funded && staking.claimedWei() == claimed && claimed <= funded
            && staking.relayFundedWei() == relayFunded && staking.relayClaimedWei() == relayClaimed
            && relayClaimed <= relayFunded && rebate == relayFunded - relayClaimed
            && address(staking).balance == funded - claimed + rebate;
    }
}
