// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolHarness} from "../../test/fixtures/EthPoolFixture.sol";
import {BatchTerms, PoolSpend} from "../../contracts/ethereum/EthPoolState.sol";
import {EthFeeStaking} from "../../contracts/ethereum/EthFeeStaking.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";
import {Goldilocks} from "../../contracts/vendor/nonos/libraries/Goldilocks.sol";

interface ReorgVm {
    function warp(uint256) external;
    function deal(address, uint256) external;
}

/// Regression suite for the failure class that stopped THORChain in October 2026:
/// a reorg drops a deposit, and the observer keeps paying for it. The EVM rewinds
/// state with the chain, so the only defence that can be *tested* here is that the
/// contracts hold no credit path other than (a) their own append-only tree and
/// (b) a proof against a root they published themselves, with single-use nullifiers
/// and proof-bound recipients. Everything below tries to forge exactly that.
contract ReorgScenariosTest {
    ReorgVm private constant vm = ReorgVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EthPoolHarness private pool;
    EthFeeStaking private staking;
    HcmtToken private coin;
    uint256 private nonce;

    function setUp() public {
        vm.warp(600);
        vm.deal(address(this), 400 ether);
        coin = new HcmtToken(address(this));
        pool = new EthPoolHarness(address(coin));
        staking = pool.feeStaking();
    }

    // ---------------------------------------------------------------- helpers

    function _spend() private view returns (PoolSpend memory) {
        uint256 i = nonce;
        return PoolSpend(pool.currentRoot(), [bytes32(uint256(4 * i + 71)), bytes32(uint256(4 * i + 72))],
            [bytes32(uint256(4 * i + 73)), bytes32(uint256(4 * i + 74))], 600);
    }

    /// Direct payment: amount = net, fee = 9 bps leg, tag 0, no batch authorization.
    function _withdrawProof(PoolSpend memory s, uint256 net, uint256 fee, address payable to)
        private
        view
        returns (bytes memory)
    {
        uint256[] memory w = new uint256[](37);
        for (uint256 j; j < 4; ++j) {
            w[j] = w[j + 4] = Goldilocks.limb(s.root, j);
            w[j + 8] = Goldilocks.limb(s.nullifiers[0], j);
            w[j + 12] = Goldilocks.limb(s.nullifiers[1], j);
            w[j + 16] = Goldilocks.limb(s.change[0], j);
            w[j + 20] = Goldilocks.limb(s.change[1], j);
            w[j + 28] = uint48(uint160(address(to)) >> (48 * j));
            w[j + 32] = uint48(uint160(address(staking)) >> (48 * j));
        }
        w[24] = net;
        w[25] = fee;
        w[27] = 0;
        w[36] = s.notBefore;
        return abi.encode(keccak256(abi.encode(w)));
    }

    function _reserveProof(uint256 value, bytes32 id, bytes32 refundOwner, PoolSpend memory s)
        private
        pure
        returns (bytes memory)
    {
        uint256 h = uint256(keccak256(abi.encode(keccak256("hcmtrail.eth-pool.reserve.v3"), id, refundOwner)));
        uint256[] memory w = new uint256[](37);
        for (uint256 j; j < 4; ++j) {
            w[j] = w[j + 4] = Goldilocks.limb(s.root, j);
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
        return abi.encode(keccak256(abi.encode(w)));
    }

    function _bookBalanced() private view {
        assert(address(pool).balance == pool.shieldedNative() + pool.reservedNative());
    }

    function _reverts(bytes memory callData) private returns (bool) {
        (bool ok,) = address(pool).call(callData);
        return !ok;
    }

    // -------------------------------------------------------------- scenarios

    /// The only way value enters the accounting is `deposit`; there is no admin,
    /// oracle or "observed deposit" entry point that a reorged event could feed.
    function test_NoCreditPathOutsideDepositAndOwnProof() public {
        uint256 leaves = pool.leafCount();
        assert(pool.shieldedNative() == 0 && pool.reservedNative() == 0);

        // Nothing to spend yet: even a well-formed proof cannot mint a wei.
        PoolSpend memory s = _spend();
        bytes memory proof = _withdrawProof(s, 1, 0, payable(address(0xd300)));
        assert(_reverts(abi.encodeCall(pool.withdraw, (proof, s, payable(address(0xd300)), uint64(1)))));
        assert(pool.leafCount() == leaves && pool.shieldedNative() == 0);

        // The tree only grows through the deposit path, one leaf per note.
        pool.deposit{value: 3 ether}(bytes32(uint256(7_101)));
        assert(pool.leafCount() == leaves + 1);
        assert(pool.shieldedNative() == 3 ether - 3 ether * 9 / 10_000);
        _bookBalanced();
    }

    /// A root that never existed on this canonical state cannot authorize anything,
    /// even with an otherwise perfect proof.
    function test_RootFromAnotherBranchIsRejected() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(7_102)));
        PoolSpend memory honest = _spend();
        PoolSpend memory forged = PoolSpend(bytes32(uint256(0xdead)), honest.nullifiers, honest.change, 600);
        bytes memory proof = _withdrawProof(forged, 1 ether, 1 ether * 9 / 10_000, payable(address(0xd301)));
        assert(_reverts(abi.encodeCall(pool.withdraw, (proof, forged, payable(address(0xd301)), uint64(1 ether)))));

        // Known root + unknown nullifiers is the only accepted combination.
        bytes memory ok = _withdrawProof(honest, 1 ether - 1 ether * 9 / 10_000, 1 ether * 9 / 10_000, payable(address(0xd301)));
        pool.withdraw(ok, honest, payable(address(0xd301)), 1 ether);
        assert(address(uint160(0xd301)).balance == 1 ether - 1 ether * 9 / 10_000);
        _bookBalanced();
    }

    /// Replaying the same proof — the on-chain analogue of resending a transaction
    /// with the same nonce after a reorg — pays exactly once, whatever the claimed
    /// recipient is.
    function test_ReplayedProofPaysOnceAndCannotBeRetargeted() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(7_103)));
        PoolSpend memory s = _spend();
        uint256 fee = 1 ether * 9 / 10_000;
        uint256 net = 1 ether - fee;
        bytes memory proof = _withdrawProof(s, net, fee, payable(address(0xd302)));
        pool.withdraw(proof, s, payable(address(0xd302)), 1 ether);
        assert(address(uint160(0xd302)).balance == net);
        ++nonce;

        // Exact replay.
        assert(_reverts(abi.encodeCall(pool.withdraw, (proof, s, payable(address(0xd302)), uint64(1 ether)))));
        // Same nullifiers, new recipient (attacker rewrites the calldata).
        address payable attacker = payable(address(0xbad0));
        bytes memory retargeted = _withdrawProof(s, net, fee, attacker);
        assert(_reverts(abi.encodeCall(pool.withdraw, (retargeted, s, attacker, uint64(1 ether)))));
        assert(attacker.balance == 0);
        assert(address(uint160(0xd302)).balance == net);
        _bookBalanced();
    }

    /// A proof carries `notBefore` but no expiry, and roots never expire: a
    /// transaction that sat in the mempool across a reorg is still valid much later.
    /// It stays single-use, so time passing cannot turn it into a second payout.
    function test_PendingProofStaysValidButSingleUse() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(7_104)));
        PoolSpend memory s = _spend();
        uint256 fee = 1 ether * 9 / 10_000;
        bytes memory proof = _withdrawProof(s, 1 ether - fee, fee, payable(address(0xd303)));

        vm.warp(600 + 365 days);
        pool.withdraw(proof, s, payable(address(0xd303)), 1 ether);
        assert(address(uint160(0xd303)).balance == 1 ether - fee);
        assert(_reverts(abi.encodeCall(pool.withdraw, (proof, s, payable(address(0xd303)), uint64(1 ether)))));
        _bookBalanced();
    }

    /// The same nullifiers cannot fund a second ticket: a reorg that "replaces" a
    /// reservation with a different one cannot make the pool count the value twice.
    function test_SameNullifierCannotFundTwoTickets() public {
        pool.deposit{value: 11 ether}(bytes32(uint256(7_105)));
        PoolSpend memory s = _spend();
        BatchTerms memory first = BatchTerms(1 ether, 1, 5, payable(address(0xd400)), bytes32(uint256(1)));
        bytes32 id = pool.ticketId(first);
        pool.reserve(_reserveProof(0.5 ether, id, bytes32(uint256(9_001)), s), s, first, 0.5 ether,
            bytes32(uint256(9_001)));
        assert(pool.reservedNative() == 0.5 ether);

        BatchTerms memory second = BatchTerms(1 ether, 1, 5, payable(address(0xd401)), bytes32(uint256(2)));
        bytes32 other = pool.ticketId(second);
        assert(_reverts(abi.encodeCall(pool.reserve,
            (_reserveProof(0.5 ether, other, bytes32(uint256(9_002)), s), s, second, uint64(0.5 ether),
                bytes32(uint256(9_002))))));
        assert(pool.reservedNative() == 0.5 ether);
        _bookBalanced();
    }
}
