// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolHarness} from "../../test/fixtures/EthPoolFixture.sol";
import {BatchTerms, PoolSpend} from "../../contracts/ethereum/EthPoolState.sol";
import {EthFeeStaking} from "../../contracts/ethereum/EthFeeStaking.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";
import {Goldilocks} from "../../contracts/vendor/nonos/libraries/Goldilocks.sol";

interface VaultAuditVm {
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
}

contract VaultSolidityTest {
    VaultAuditVm private constant vm = VaultAuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EthPoolHarness private pool;
    EthFeeStaking private staking;
    HcmtToken private coin;

    function setUp() public {
        vm.warp(600);
        vm.deal(address(this), 100 ether);
        coin = new HcmtToken(address(this));
        pool = new EthPoolHarness(address(coin));
        staking = pool.feeStaking();
    }

    function testFuzz_SameGrossSameFeeAndExactWei(uint64 gross) public view {
        (uint256 fee, uint256 net) = pool.quoteFee(gross);
        assert(fee == uint256(gross) * 9 / 10_000);
        assert(net + fee == gross);
    }

    // Fixture authorizes exactly the public statement. Never use this in a real vault.
    function _reserve(uint256 i, bytes32 root) private {
        uint64 value = 0.5 ether;
        PoolSpend memory s = PoolSpend(root, [bytes32(4 * i + 101), bytes32(4 * i + 102)],
            [bytes32(4 * i + 103), bytes32(4 * i + 104)], 600);
        BatchTerms memory terms = BatchTerms(value, 1, 20, payable(address(uint160(0xd000 + i))), bytes32(i + 1));
        bytes32 refund = bytes32(i + 201);
        bytes32 id = keccak256(abi.encode(pool.domain(), terms));
        uint256 tag = uint256(keccak256(abi.encode(keccak256("hcmtrail.eth-pool.reserve.v3"), id, refund)));
        uint256[] memory words = new uint256[](37);
        for (uint256 j; j < 4; ++j) {
            words[j] = words[j + 4] = Goldilocks.limb(root, j);
            words[j + 8] = Goldilocks.limb(s.nullifiers[0], j);
            words[j + 12] = Goldilocks.limb(s.nullifiers[1], j);
            words[j + 16] = Goldilocks.limb(s.change[0], j);
            words[j + 20] = Goldilocks.limb(s.change[1], j);
            words[j + 28] = uint48(((1 << 128) | (tag >> 128)) >> (48 * j));
            words[j + 32] = uint48(((1 << 128) | uint128(tag)) >> (48 * j));
        }
        words[24] = value - 1;
        words[25] = 1;
        words[27] = 1;
        words[36] = s.notBefore;
        pool.reserve(abi.encode(keccak256(abi.encode(words))), s, terms, value, refund);
    }

    function test_BatchAccountingAndRelayCap() public {
        address operator = address(0xbeef);
        assert(coin.transfer(operator, 100 ether));
        vm.prank(operator);
        coin.approve(address(staking), 100 ether);
        vm.prank(operator);
        staking.stake(100 ether);
        assert(!staking.relayEligible(operator));
        vm.warp(staking.start() + 30 days);
        assert(staking.relayEligible(operator));

        pool.deposit{value: 11 ether}(bytes32(uint256(1_001)));
        uint256 depositFee = 0.0099 ether;
        assert(staking.fundedWei() == depositFee);
        bytes32 root = pool.currentRoot();
        for (uint256 i; i < 20; ++i) _reserve(i, root);
        assert(pool.reservedNative() == 10 ether && pool.reservedRefundLeaves() == 20);
        assert(address(pool).balance == pool.shieldedNative() + pool.reservedNative());
        vm.prank(operator);
        pool.executeBatch(0.5 ether, 1);
        for (uint256 i; i < 20; ++i) assert(address(uint160(0xd000 + i)).balance == 0.49955 ether);
        assert(pool.reservedNative() == 0 && pool.reservedRefundLeaves() == 0);
        assert(staking.relayCredit(operator) == 0.003 ether);
        assert(staking.fundedWei() == depositFee + 0.006 ether);
        assert(address(pool).balance + address(staking).balance + 9.991 ether == 11 ether);
    }
}
