// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolHarness, RejectEth} from "../../test/fixtures/EthPoolFixture.sol";
import {BatchTerms, PoolSpend} from "../../contracts/ethereum/EthPoolState.sol";
import {DepositNote} from "../../contracts/vault/NativeNoteDeposits.sol";
import {EthFeeStaking} from "../../contracts/ethereum/EthFeeStaking.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";
import {Goldilocks} from "../../contracts/vendor/nonos/libraries/Goldilocks.sol";

interface DeepVm {
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
}

/// Targeted multi-condition scenarios. Random fuzzing reaches almost none of these
/// states because each one needs several independent facts at once (full queue,
/// a second round already open, a rejecting recipient, an unstake queued exactly on
/// a boundary, a one-wei part inside a large ticket...). Every scenario asserts the
/// full ETH book after the fact, not just the local effect.
contract DeepScenariosTest {
    DeepVm private constant vm = DeepVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EthPoolHarness private pool;
    EthFeeStaking private staking;
    HcmtToken private coin;
    uint256 private nonce;

    address private constant OPERATOR = address(0xBEEF);
    uint256 private constant TICKET = 2 ether;

    function setUp() public {
        vm.warp(600);
        vm.deal(address(this), 400 ether);
        coin = new HcmtToken(address(this));
        pool = new EthPoolHarness(address(coin));
        staking = pool.feeStaking();
        assert(coin.transfer(OPERATOR, 400 ether));
    }

    // ------------------------------------------------------------- helpers

    function _reserve(uint256 amount, uint64 round, uint8 target, uint64 value, address payable recipient) private {
        uint256 i = nonce++;
        bytes32 root = pool.currentRoot();
        PoolSpend memory s = PoolSpend(root, [bytes32(4 * i + 101), bytes32(4 * i + 102)],
            [bytes32(4 * i + 103), bytes32(4 * i + 104)], 600);
        BatchTerms memory terms = BatchTerms(amount, round, target, recipient, bytes32(i + 1));
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
        }
        if (value == 1) {
            w[24] = 1;
            w[25] = 0;
            w[27] = 1 + uint64((h >> 160) & (type(uint64).max >> 1));
            for (uint256 j; j < 4; ++j) w[j + 28] = uint48(uint160(h) >> (48 * j));
        } else {
            w[24] = value - 1;
            w[25] = 1;
            w[27] = 1;
            for (uint256 j; j < 4; ++j) {
                w[j + 28] = uint48(((1 << 128) | (h >> 128)) >> (48 * j));
                w[j + 32] = uint48(((1 << 128) | uint128(h)) >> (48 * j));
            }
        }
        w[36] = s.notBefore;
        pool.reserve(abi.encode(keccak256(abi.encode(w))), s, terms, value, refund);
    }

    function _terms(uint256 amount, uint64 round, uint8 target, address payable recipient, uint256 salt)
        private
        pure
        returns (BatchTerms memory)
    {
        return BatchTerms(amount, round, target, recipient, bytes32(salt));
    }

    function _bookBalanced() private view {
        assert(address(pool).balance == pool.shieldedNative() + pool.reservedNative());
    }

    function _tryExecute(uint256 amount, uint64 round) private returns (bool ok) {
        try pool.executeBatch(amount, round) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    // ------------------------------------------------- F-1: full queue must not lock

    function test_FullQueueOpensNextRoundAndKeepsPriorSettleable() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_001)));
        for (uint256 i; i < 5; ++i) _reserve(TICKET / 4, 1, 5, uint64(TICKET / 4), payable(address(uint160(0xd000 + i))));
        (,, uint8 count, bool paid) = pool.getBatch(TICKET / 4, 1);
        assert(count == 5 && !paid);

        // The queue is full: round 2 must open immediately, without waiting for
        // settlement or the one-day expiry.
        _reserve(TICKET / 4, 2, 5, uint64(TICKET / 4), payable(address(0xd100)));
        (,, uint8 nextCount,) = pool.getBatch(TICKET / 4, 2);
        assert(nextCount == 1);
        assert(pool.latestRound(TICKET / 4) == 2);

        // Round 1 stays payable even though the pointer moved on.
        assert(_tryExecute(TICKET / 4, 1));
        assert(address(uint160(0xd000)).balance == 0.49955 ether);
        assert(pool.reservedNative() == TICKET / 4);
        assert(pool.reservedRefundLeaves() == 1);
        _bookBalanced();

        // The unsettled round 2 keeps its escrow and can still be refunded after expiry.
        uint256 shielded = pool.shieldedNative();
        vm.warp(block.timestamp + 1 days + 1);
        pool.refundPart(_terms(TICKET / 4, 2, 5, payable(address(0xd100)), 6), bytes32(uint256(4 * 5 + 101)));
        assert(pool.shieldedNative() == shielded + TICKET / 4);
        assert(pool.reservedNative() == 0 && pool.reservedRefundLeaves() == 0);
        _bookBalanced();
    }

    function test_StaleRoundCannotBeJoinedAndRoundThreeNeedsTwo() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_002)));
        pool.deposit{value: 11 ether}(bytes32(uint256(1_003)));
        for (uint256 i; i < 5; ++i) _reserve(TICKET, 1, 5, uint64(TICKET), payable(address(uint160(0xe000 + i))));
        _reserve(TICKET, 2, 5, uint64(TICKET), payable(address(0xe100)));

        // Joining the full round 1, or skipping straight to round 3, must revert.
        bool reverted;
        try pool.reserve(hex"00", _spend(uint256(0)), _terms(TICKET, 1, 5, payable(address(0xe200)), 9), uint64(TICKET), bytes32(uint256(9))) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        reverted = false;
        try pool.reserve(hex"00", _spend(uint256(1)), _terms(TICKET, 3, 5, payable(address(0xe300)), 10), uint64(TICKET), bytes32(uint256(10))) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
    }

    function _spend(uint256 i) private view returns (PoolSpend memory) {
        return PoolSpend(pool.currentRoot(), [bytes32(4 * i + 901), bytes32(4 * i + 902)],
            [bytes32(4 * i + 903), bytes32(4 * i + 904)], 600);
    }

    // ------------------------------------------------ rejecting recipient is atomic

    function test_RejectingRecipientRevertsWholeBatchThenRefunds() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_003)));
        RejectEth hostile = new RejectEth();
        for (uint256 i; i < 4; ++i) _reserve(TICKET, 1, 5, uint64(TICKET), payable(address(uint160(0xf000 + i))));
        _reserve(TICKET, 1, 5, uint64(TICKET), payable(address(hostile)));
        assert(pool.reservedNative() == 5 * TICKET);

        assert(!_tryExecute(TICKET, 1));
        (,,, bool paid) = pool.getBatch(TICKET, 1);
        assert(!paid);
        for (uint256 i; i < 4; ++i) assert(address(uint160(0xf000 + i)).balance == 0);
        assert(pool.reservedNative() == 5 * TICKET);
        _bookBalanced();

        // Every part stays refundable to its proof-bound owner after expiry.
        uint256 shielded = pool.shieldedNative();
        vm.warp(block.timestamp + 1 days + 1);
        for (uint256 i; i < 5; ++i) {
            pool.refundPart(_terms(TICKET, 1, 5, i < 4 ? payable(address(uint160(0xf000 + i))) : payable(address(hostile)), i + 1),
                bytes32(4 * i + 101));
        }
        assert(pool.shieldedNative() == shielded + 5 * TICKET);
        assert(pool.reservedNative() == 0 && pool.reservedRefundLeaves() == 0);
        _bookBalanced();
    }

    // --------------------------------------------------------- relay economics

    function test_RelayCapAppliesPerBatchNotPerTicket() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_004)));
        pool.deposit{value: 11 ether}(bytes32(uint256(1_005)));
        pool.deposit{value: 5 ether}(bytes32(uint256(1_006)));
        vm.prank(OPERATOR);
        coin.approve(address(staking), 100 ether);
        vm.prank(OPERATOR);
        staking.stake(100 ether);
        assert(!staking.relayEligible(OPERATOR));
        vm.warp(staking.start() + 30 days);
        assert(staking.relayEligible(OPERATOR));

        uint256 depositFee = 27 ether * 9 / 10_000;
        for (uint256 round = 1; round <= 2; ++round) {
            for (uint256 i; i < 5; ++i) {
                _reserve(TICKET, uint64(round), 5, uint64(TICKET), payable(address(uint160(0x1000 + 10 * round + i))));
            }
            vm.prank(OPERATOR);
            pool.executeBatch(TICKET, uint64(round));
        }
        (uint256 fee, uint256 net) = pool.quoteFee(TICKET);
        assert(net == 1.9982 ether && fee == 0.0018 ether);
        // 5 tickets per batch pay 0.009 ETH of fees, the rebate is capped once per batch.
        assert(staking.relayCredit(OPERATOR) == 0.006 ether);
        assert(staking.relayFundedWei() == 0.006 ether);
        assert(staking.fundedWei() == depositFee + 2 * (5 * fee - 0.003 ether));
        assert(address(staking).balance == staking.fundedWei() + staking.relayFundedWei());
        _bookBalanced();
    }

    function test_RelayEligibilityDropsExactlyAtBoundaryAndKeepsEarnedCredit() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_005)));
        vm.prank(OPERATOR);
        coin.approve(address(staking), 100 ether);
        vm.prank(OPERATOR);
        staking.stake(100 ether);
        vm.warp(staking.start() + 30 days);

        for (uint256 i; i < 5; ++i) _reserve(TICKET, 1, 5, uint64(TICKET), payable(address(uint160(0x2000 + i))));
        vm.prank(OPERATOR);
        pool.executeBatch(TICKET, 1);
        uint256 earned = staking.relayCredit(OPERATOR);
        assert(earned == 0.003 ether);

        // Queueing the exit keeps this epoch's rewards and eligibility.
        vm.prank(OPERATOR);
        staking.requestUnstake(100 ether);
        assert(staking.relayEligible(OPERATOR));
        vm.warp(staking.start() + 60 days);
        assert(!staking.relayEligible(OPERATOR));

        // Earned credit survives the exit and can still be withdrawn.
        vm.prank(OPERATOR);
        uint256 claimed = staking.claimRelayReward(payable(OPERATOR));
        assert(claimed == earned && claimed == OPERATOR.balance);
        assert(staking.relayCredit(OPERATOR) == 0);
        assert(staking.relayClaimedWei() == earned);
    }

    function test_SkippedEpochsDoNotOverclaim() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_006)));
        vm.prank(OPERATOR);
        coin.approve(address(staking), 100 ether);
        vm.prank(OPERATOR);
        staking.stake(100 ether);
        vm.warp(staking.start() + 30 days);
        staking.fundFees{value: 3 ether}();

        vm.warp(staking.start() + 90 * 30 days);
        (, , uint128 active, , ) = staking.epochState();
        assert(active == 100 ether);
        // The deposit fee collected before anyone staked is carried, not burned, so the
        // pot is the 0.0099 ETH deposit fee plus the 3 ETH voluntary funding.
        uint256 pot = 9_900_000_000_000_000 + 3 ether;
        uint256 claimable = _claimable(OPERATOR);
        // Division dust stays in the pot for later epochs; it is never over-claimed.
        assert(claimable <= pot);
        assert(claimable + 1 >= pot);

        vm.prank(OPERATOR);
        uint256 paid = staking.claim(payable(OPERATOR));
        assert(paid == claimable);
        assert(_claimable(OPERATOR) == 0);
        assert(address(staking).balance == uint256(staking.fundedWei()) - staking.claimedWei());
        _bookBalanced();
    }

    function _claimable(address account) private view returns (uint256) {
        (, , , , uint256 claimable) = staking.position(account);
        return claimable;
    }

    // --------------------------------------------------- wei-level exactness

    function test_OneWeiPartIsSingleUseAndRefundsExactlyOneWei() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_007)));
        _reserve(10 ether, 1, 5, 1, payable(address(0x3000))); // one wei inside a ten-ether ticket
        _reserve(10 ether, 1, 5, 9 ether + 999, payable(address(0x3001)));
        assert(pool.reservedNative() == 9 ether + 1000);
        assert(pool.reservedRefundLeaves() == 2);

        // The proof is bound to the reservation tag; spending the same note twice fails.
        bytes32 nullifier = bytes32(uint256(101));
        bool reverted;
        vm.warp(block.timestamp + 1 days + 1);
        pool.refundPart(_terms(10 ether, 1, 5, payable(address(0x3000)), 1), nullifier);
        try pool.refundPart(_terms(10 ether, 1, 5, payable(address(0x3000)), 1), nullifier) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);

        uint256 shielded = pool.shieldedNative();
        pool.refundPart(_terms(10 ether, 1, 5, payable(address(0x3001)), 2), bytes32(uint256(4 * 1 + 101)));
        assert(pool.shieldedNative() == shielded + 9 ether + 999);
        assert(pool.reservedNative() == 0 && pool.reservedRefundLeaves() == 0);
        _bookBalanced();
    }

    function test_TinyBatchSplitsEveryWeiExactly() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_008)));
        uint256 amount = 1_112; // fee 1 wei, net 1111 wei
        (uint256 fee, uint256 net) = pool.quoteFee(amount);
        assert(fee == 1 && net == 1_111);
        for (uint256 i; i < 5; ++i) _reserve(amount, 1, 5, uint64(amount), payable(address(uint160(0x4000 + i))));
        uint256 stakingBefore = staking.fundedWei();
        pool.executeBatch(amount, 1);
        for (uint256 i; i < 5; ++i) assert(address(uint160(0x4000 + i)).balance == 1_111);
        assert(staking.fundedWei() == stakingBefore + 5);
        assert(pool.reservedNative() == 0 && pool.reservedRefundLeaves() == 0);
        _bookBalanced();
    }

    function test_FeeIsExactlyNineBpsForEveryTicket() public {
        uint256[6] memory samples = [uint256(1), 111, 1_111, 1_112, 1_111_111, 18_446_744_073_709_551_615];
        for (uint256 i; i < samples.length; ++i) {
            (uint256 fee, uint256 net) = pool.quoteFee(samples[i]);
            assert(fee + net == samples[i]);
            assert(fee == samples[i] / 10_000 * 9 + (samples[i] % 10_000) * 9 / 10_000);
        }
    }

    // -------------------------------------------- depositBatch + direct withdraw

    function test_DepositBatchSplitsEveryUnitOfNet() public {
        (uint256 fee, uint256 net) = pool.quoteFee(11 ether);
        DepositNote[] memory notes = new DepositNote[](3);
        notes[0] = DepositNote(uint64(4 ether), bytes32(uint256(0xa1)));
        notes[1] = DepositNote(uint64(4 ether), bytes32(uint256(0xa2)));
        notes[2] = DepositNote(uint64(net - 8 ether), bytes32(uint256(0xa3)));
        pool.depositBatch{value: 11 ether}(notes);
        assert(pool.shieldedNative() == net);
        assert(staking.fundedWei() == fee);
        assert(pool.leafCount() == 4); // domain leaf + three notes
        _bookBalanced();

        // Rejections: one wei of net left unattributed and an empty list.
        bool reverted;
        DepositNote[] memory short_ = new DepositNote[](1);
        short_[0] = DepositNote(uint64(net - 1), bytes32(uint256(0xa4)));
        try pool.depositBatch{value: 11 ether}(short_) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        DepositNote[] memory empty = new DepositNote[](0);
        reverted = false;
        try pool.depositBatch{value: 11 ether}(empty) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
    }

    function test_DirectWithdrawChargesExactlyNineBpsAndSharesTheRebate() public {
        vm.prank(OPERATOR);
        coin.approve(address(staking), 100 ether);
        vm.prank(OPERATOR);
        staking.stake(100 ether);
        vm.warp(staking.start() + 30 days);
        assert(staking.relayEligible(OPERATOR));

        pool.deposit{value: 11 ether}(bytes32(uint256(1_009)));
        uint64 gross = 1 ether;
        (uint256 fee, uint256 net) = pool.quoteFee(gross);
        uint256 fundedBefore = staking.fundedWei();

        uint256[] memory w = new uint256[](37);
        PoolSpend memory s = PoolSpend(pool.currentRoot(), [bytes32(uint256(9_901)), bytes32(uint256(9_902))],
            [bytes32(uint256(9_903)), bytes32(uint256(9_904))], 600);
        for (uint256 j; j < 4; ++j) {
            w[j] = w[j + 4] = Goldilocks.limb(s.root, j);
            w[j + 8] = Goldilocks.limb(s.nullifiers[0], j);
            w[j + 12] = Goldilocks.limb(s.nullifiers[1], j);
            w[j + 16] = Goldilocks.limb(s.change[0], j);
            w[j + 20] = Goldilocks.limb(s.change[1], j);
            w[j + 28] = uint48(uint160(address(0xd200)) >> (48 * j));
            w[j + 32] = uint48(uint160(address(staking)) >> (48 * j));
        }
        w[24] = net;
        w[25] = fee;
        w[27] = 0;
        w[36] = 600;

        vm.prank(OPERATOR);
        pool.withdraw(abi.encode(keccak256(abi.encode(w))), s, payable(address(0xd200)), gross);
        assert(address(uint160(0xd200)).balance == net);
        // The caller is an eligible relayer, so half the fee becomes claimable credit.
        assert(staking.fundedWei() == fundedBefore + fee - fee / 2);
        assert(staking.relayCredit(OPERATOR) == fee / 2);
        _bookBalanced();
    }

    function test_TicketIdIsDomainSeparated() public {
        BatchTerms memory a = _terms(1 ether, 1, 5, payable(address(0x1234)), 1);
        BatchTerms memory b = _terms(1 ether, 1, 5, payable(address(0x1234)), 2);
        assert(pool.ticketId(a) != pool.ticketId(b));
        assert(pool.ticketId(a) == keccak256(abi.encode(pool.domain(), a)));
    }
}
