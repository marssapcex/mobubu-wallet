// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolHarness} from "../../test/fixtures/EthPoolFixture.sol";
import {BatchTerms, PoolSpend} from "../../contracts/ethereum/EthPoolState.sol";
import {EthFeeStaking} from "../../contracts/ethereum/EthFeeStaking.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";
import {Goldilocks} from "../../contracts/vendor/nonos/libraries/Goldilocks.sol";

/// Stateful target for Medusa and Echidna.
///
/// Scope: pool accounting, batch settlement, refunds and the staking fee ledger.
/// The note verifier used here is the *fixture* one, so nothing in this file proves
/// STARK soundness. Every action reverts politely instead of aborting the campaign.
contract StatefulProperties {
    EthPoolHarness public immutable pool;
    EthFeeStaking public immutable staking;
    HcmtToken public immutable coin;

    uint256 public attempts;
    uint256 public settlements;
    uint256 public refunds;
    uint256 public nextIndex;
    uint256 public creditedNet;

    struct Slot {
        uint64 round;
        uint8 filled;
        uint256 parts;
    }

    mapping(uint8 => Slot) public slots;
    mapping(uint256 => BatchTerms) private ticketTerms;
    mapping(uint256 => bytes32) private ticketNullifier;

    constructor() {
        coin = new HcmtToken(address(this));
        pool = new EthPoolHarness(address(coin));
        staking = pool.feeStaking();
    }

    receive() external payable {}

    // ---------------------------------------------------------------- helpers

    function amountOf(uint8 slot) public pure returns (uint256) {
        return slot == 0 ? 0.5 ether : 2 ether;
    }

    function _reserve(uint8 slot) private returns (bool ok) {
        if (slots[slot].filled == 5) return false;
        uint256 amount = amountOf(slot);
        uint64 last = pool.latestRound(amount);
        if (slots[slot].round == 0 || slots[slot].round != last) {
            if (last != 0 && slots[slot].round != 0 && slots[slot].filled != 0) {
                // The pool opened or expired another batch for this amount; start fresh.
                slots[slot].filled = 0;
                slots[slot].parts = 0;
            }
            slots[slot].round = last + 1;
        }
        uint256 i = nextIndex++;
        bytes32 root = pool.currentRoot();
        PoolSpend memory s = PoolSpend(root, [bytes32(4 * i + 101), bytes32(4 * i + 102)],
            [bytes32(4 * i + 103), bytes32(4 * i + 104)], 600);
        BatchTerms memory terms = BatchTerms(amount, slots[slot].round, 5,
            payable(address(uint160(0xd000 + i))), bytes32(i + 1));
        bytes32 refund = bytes32(i + 201);
        bytes32 id = keccak256(abi.encode(pool.domain(), terms));
        uint256 h = uint256(keccak256(abi.encode(keccak256("hcmtrail.eth-pool.reserve.v3"), id, refund)));
        uint256[] memory w = new uint256[](37);
        for (uint256 j; j < 4; ++j) {
            w[j] = w[j + 4] = Goldilocks.limb(root, j);
            w[j + 8] = Goldilocks.limb(s.nullifiers[0], j);
            w[j + 12] = Goldilocks.limb(s.nullifiers[1], j);
            w[j + 16] = Goldilocks.limb(s.change[0], j);
            w[j + 20] = Goldilocks.limb(s.change[1], j);
            w[j + 28] = uint48(((1 << 128) | (h >> 128)) >> (48 * j));
            w[j + 32] = uint48(((1 << 128) | uint128(h)) >> (48 * j));
        }
        w[24] = amount - 1;
        w[25] = 1;
        w[27] = 1;
        w[36] = s.notBefore;
        try pool.reserve(abi.encode(keccak256(abi.encode(w))), s, terms, uint64(amount), refund) {
            ticketTerms[i] = terms;
            ticketNullifier[i] = s.nullifiers[0];
            slots[slot].filled += 1;
            slots[slot].parts += 1;
            ok = true;
        } catch {
            ok = false;
        }
        ++attempts;
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint96 value) public {
        uint256 want = uint256(value) % 6 ether;
        if (want < pool.MIN_DEPOSIT()) want = pool.MIN_DEPOSIT();
        if (want > address(this).balance) want = address(this).balance;
        if (want < pool.MIN_DEPOSIT()) return;
        try pool.deposit{value: want}(bytes32(uint256(0xbeef))) {} catch {}
        ++attempts;
    }

    function reserveTicket(uint8 slot) external {
        _reserve(slot % 2);
    }

    function settle(uint8 slot) external {
        slot = slot % 2;
        uint256 amount = amountOf(slot);
        uint64 round = slots[slot].round;
        if (round == 0) return;
        (uint256 fee, uint256 net) = pool.quoteFee(amount);
        try pool.executeBatch(amount, round) {
            require(net + fee == amount, "fee split");
            creditedNet += net * 5;
            slots[slot].filled = 0;
            slots[slot].parts = 0;
            ++settlements;
        } catch {}
        ++attempts;
    }

    function refundTicket(uint256 i) external {
        i = i % (nextIndex == 0 ? 1 : nextIndex);
        BatchTerms memory terms = ticketTerms[i];
        bytes32 nullifier = ticketNullifier[i];
        if (nullifier == bytes32(0)) return;
        try pool.refundPart(terms, nullifier) {
            ticketNullifier[i] = bytes32(0);
            ++refunds;
        } catch {}
        ++attempts;
    }

    function stake(uint96 value) external {
        uint256 want = 1 + uint256(value) % 400 ether;
        uint256 held = coin.balanceOf(address(this));
        if (held == 0) return;
        if (want > held) want = held;
        coin.approve(address(staking), want);
        try staking.stake(uint128(want)) {} catch {}
        ++attempts;
    }

    function requestUnstake(uint96 value) external {
        (, uint128 scheduled, , , ) = staking.position(address(this));
        if (scheduled == 0) return;
        uint128 want = uint128(1 + uint256(value) % scheduled);
        try staking.requestUnstake(want) {} catch {}
        ++attempts;
    }

    function withdrawStake(uint96 value) external {
        (, , , uint128 withdrawable, ) = staking.position(address(this));
        if (withdrawable == 0) return;
        uint128 want = uint128(1 + uint256(value) % withdrawable);
        try staking.withdrawStake(want, address(this)) {} catch {}
        ++attempts;
    }

    function claimFees() external {
        try staking.claim(payable(address(this))) {} catch {}
        ++attempts;
    }

    function claimRelay() external {
        try staking.claimRelayReward(payable(address(this))) {} catch {}
        ++attempts;
    }

    // -------------------------------------------------------------- properties

    function _poolSolvent() internal view returns (bool) {
        return address(pool).balance >= pool.shieldedNative() + pool.reservedNative();
    }

    function _stakingSolvent() internal view returns (bool) {
        return address(staking).balance + staking.claimedWei() + staking.relayClaimedWei()
            >= uint256(staking.fundedWei()) + staking.relayFundedWei();
    }

    function _claimsBounded() internal view returns (bool) {
        return staking.claimedWei() <= staking.fundedWei() && staking.relayClaimedWei() <= staking.relayFundedWei();
    }

    function _treeBound() internal view returns (bool) {
        return uint256(pool.leafCount()) + pool.reservedRefundLeaves() <= (uint256(1) << 32);
    }

    function _supplyFixed() internal view returns (bool) {
        return coin.totalSupply() == 100_000e18;
    }

    /// Spent nullifiers may never be reused; the pool exposes this one by one.
    function _noDoubleSettlement(uint8 slot) internal view returns (bool) {
        Slot memory s = slots[slot];
        if (s.round == 0) return true;
        (, , uint8 count, bool paid) = pool.getBatch(amountOf(slot), s.round);
        return !(paid && s.filled < 5 && count < 5);
    }

    function property_poolSolvent() public view returns (bool) { return _poolSolvent(); }
    function property_stakingSolvent() public view returns (bool) { return _stakingSolvent(); }
    function property_claimsBounded() public view returns (bool) { return _claimsBounded(); }
    function property_treeBound() public view returns (bool) { return _treeBound(); }
    function property_supplyFixed() public view returns (bool) { return _supplyFixed(); }
    function property_batchBookkeeping() public view returns (bool) {
        return _noDoubleSettlement(0) && _noDoubleSettlement(1);
    }

    function echidna_pool_solvent() public view returns (bool) { return _poolSolvent(); }
    function echidna_staking_solvent() public view returns (bool) { return _stakingSolvent(); }
    function echidna_claims_bounded() public view returns (bool) { return _claimsBounded(); }
    function echidna_tree_bound() public view returns (bool) { return _treeBound(); }
    function echidna_supply_fixed() public view returns (bool) { return _supplyFixed(); }
    function echidna_batch_bookkeeping() public view returns (bool) {
        return _noDoubleSettlement(0) && _noDoubleSettlement(1);
    }
}
