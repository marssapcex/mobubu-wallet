// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolHarness} from "../../test/fixtures/EthPoolFixture.sol";
import {BatchTerms, PoolSpend} from "../../contracts/ethereum/EthPoolState.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";
import {Goldilocks} from "../../contracts/vendor/nonos/libraries/Goldilocks.sol";

interface RefundVm {
    function warp(uint256) external;
    function deal(address, uint256) external;
}

/// Attempts to break the refund path of a settled batch and of an expired batch.
/// Both attempts are expected to fail: recorded here as checked negative results.
contract RefundFindingTest {
    RefundVm private constant vm = RefundVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EthPoolHarness private pool;
    HcmtToken private coin;

    function setUp() public {
        vm.warp(600);
        vm.deal(address(this), 100 ether);
        coin = new HcmtToken(address(this));
        pool = new EthPoolHarness(address(coin));
    }

    function _reserve(uint256 index, uint256 amount, uint64 round, uint8 target, uint64 value) private {
        bytes32 root = pool.currentRoot();
        PoolSpend memory s = PoolSpend(root, [bytes32(4 * index + 101), bytes32(4 * index + 102)],
            [bytes32(4 * index + 103), bytes32(4 * index + 104)], 600);
        BatchTerms memory terms = BatchTerms(amount, round, target, payable(address(uint160(0xd000 + index))), bytes32(index + 1));
        bytes32 refund = bytes32(index + 201);
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
        w[24] = value - 1;
        w[25] = 1;
        w[27] = 1;
        w[36] = s.notBefore;
        pool.reserve(abi.encode(keccak256(abi.encode(w))), s, terms, value, refund);
    }

    function _termsOf(uint256 index) private pure returns (BatchTerms memory) {
        return BatchTerms(0.5 ether, 1, 5, payable(address(uint160(0xd000 + index))), bytes32(index + 1));
    }

    /// A paid batch must not return already-paid value as a private note.
    function test_RefundAfterPaidBatchIsRejected() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_001)));
        for (uint256 i; i < 5; ++i) _reserve(i, 0.5 ether, 1, 5, 0.5 ether);
        pool.executeBatch(0.5 ether, 1);
        assert(address(uint160(0xd000)).balance == 0.49955 ether);

        _reserve(10, 2 ether, 1, 5, 1.5 ether); // unrelated live escrow
        uint256 shielded = pool.shieldedNative();
        uint256 reserved = pool.reservedNative();
        uint256 leaves = pool.reservedRefundLeaves();

        bool reverted;
        try pool.refundPart(_termsOf(0), bytes32(uint256(101))) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        assert(pool.shieldedNative() == shielded);
        assert(pool.reservedNative() == reserved);
        assert(pool.reservedRefundLeaves() == leaves);
    }

    /// After expiry an unfilled batch can be refunded exactly once per part.
    function test_RefundAfterExpiryIsExactlyOnce() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(1_002)));
        _reserve(20, 0.5 ether, 1, 5, 0.5 ether); // one complete ticket, batch never fills
        uint256 shielded = pool.shieldedNative();
        vm.warp(block.timestamp + 1 days + 1);

        pool.refundPart(_termsOf(20), bytes32(uint256(4 * 20 + 101)));
        assert(pool.shieldedNative() == shielded + 0.5 ether);

        bool reverted;
        try pool.refundPart(_termsOf(20), bytes32(uint256(4 * 20 + 101))) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        assert(pool.shieldedNative() == shielded + 0.5 ether);
    }
}
