// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthNetworkHarness} from "../../test/fixtures/EthPoolFixture.sol";
import {NetworkConfig, ExitOrder} from "../../contracts/ethereum/EthNetworkState.sol";
import {EthNetworkState} from "../../contracts/ethereum/EthNetworkState.sol";
import {PoolSpend} from "../../contracts/ethereum/EthPoolState.sol";
import {MessageConfig, PacketGas} from "../../contracts/ethereum/RollupMessageTransport.sol";
import {EthFeeStaking} from "../../contracts/ethereum/EthFeeStaking.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";
import {Goldilocks} from "../../contracts/vendor/nonos/libraries/Goldilocks.sol";
import {LocalMessageTransport, LocalArbMessageBridge, LocalArbMessageOutbox} from "../../test/fixtures/LocalMessageTransport.sol";

interface NetVm {
    function warp(uint256) external;
    function deal(address, uint256) external;
}

/// Drives the real cross-lane state machine with the local transport fixture.
/// The single pool below lives on the Ethereum lab lane (31337); the Arbitrum and
/// Base peers are placeholders, so "remote" packets are injected with the exact
/// authentication shape the production transport requires (outbox/bridge pair for
/// Arbitrum, messenger for Base). No STARK is proven here: the verifier is the
/// fixture keccak one.
contract NetworkScenariosTest {
    NetVm private constant vm = NetVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EthNetworkHarness private pool;
    EthFeeStaking private staking;
    HcmtToken private coin;
    LocalMessageTransport private base;
    LocalMessageTransport private inbox;
    LocalArbMessageBridge private bridge;
    LocalArbMessageOutbox private outbox;

    address private constant ARB_PEER = address(0xA11CE);
    address private constant BASE_PEER = address(0xB0B);
    uint256 private constant ETH_LANE = 1;
    uint256 private constant ARB_LANE = 42161;
    uint64 private constant EXIT_TAG = (1 << 63) + 1;
    uint256 private nonce;

    function setUp() public {
        vm.warp(600);
        vm.deal(address(this), 400 ether);
        coin = new HcmtToken(address(this));
        outbox = new LocalArbMessageOutbox();
        bridge = new LocalArbMessageBridge(address(outbox));
        inbox = new LocalMessageTransport(address(bridge));
        base = new LocalMessageTransport(address(0));

        MessageConfig memory messages = MessageConfig(address(base), address(inbox), address(bridge), address(0));
        uint256 next = _nextNonce();
        address predicted = _createAddress(address(this), next);
        NetworkConfig memory cfg = NetworkConfig(keccak256("hcmtrail.audit.realm"),
            [predicted, ARB_PEER, BASE_PEER], messages);
        pool = new EthNetworkHarness(address(coin), cfg);
        assert(address(pool) == predicted);
        staking = pool.feeStaking();
    }

    // ------------------------------------------------------------ create address

    function _createAddress(address deployer, uint256 n) private pure returns (address) {
        bytes memory encoded;
        if (n == 0) {
            encoded = abi.encodePacked(hex"d6", hex"94", deployer, hex"80");
        } else if (n < 128) {
            encoded = abi.encodePacked(hex"d6", hex"94", deployer, uint8(n));
        } else {
            encoded = abi.encodePacked(hex"d7", hex"94", deployer, hex"81", uint8(n));
        }
        return address(uint160(uint256(keccak256(encoded))));
    }

    /// The probe consumes nonce n, so the next deployment lands at n + 1.
    function _nextNonce() private returns (uint256) {
        address probe = _deployProbe();
        for (uint256 n; n < 64; ++n) {
            if (probe == _createAddress(address(this), n)) return n + 1;
        }
        revert("nonce");
    }

    function _deployProbe() private returns (address) {
        return address(new HcmtToken(address(this)));
    }

    // ---------------------------------------------------------------- helpers

    function _order(uint64 source, uint64 destination, uint64 gross, address payable recipient, bytes32 salt)
        private
        pure
        returns (ExitOrder memory)
    {
        return ExitOrder(source, destination, gross, recipient, bytes32(uint256(7)), keccak256(abi.encodePacked(salt)), salt);
    }

    function _gas() private view returns (PacketGas memory) {
        return PacketGas(300_000, 2 gwei, 1, address(this));
    }

    function _budget() private view returns (uint256) {
        PacketGas memory bid = _gas();
        return uint256(bid.gasLimit) * bid.maxFeePerGas + bid.maxSubmissionCost;
    }

    function _spend() private view returns (PoolSpend memory) {
        return PoolSpend(pool.currentRoot(), [bytes32(uint256(4 * nonce + 101)), bytes32(uint256(4 * nonce + 102))],
            [bytes32(uint256(4 * nonce + 103)), bytes32(uint256(4 * nonce + 104))], 600);
    }

    function _exitProof(ExitOrder memory o, uint64 gross) private view returns (bytes memory) {
        uint256 h = uint256(keccak256(abi.encode(pool.domain(), pool.exitId(o))));
        PoolSpend memory s = _spend();
        uint256[] memory w = new uint256[](37);
        for (uint256 j; j < 4; ++j) {
            w[j] = w[j + 4] = Goldilocks.limb(s.root, j);
            w[j + 8] = Goldilocks.limb(s.nullifiers[0], j);
            w[j + 12] = Goldilocks.limb(s.nullifiers[1], j);
            w[j + 16] = Goldilocks.limb(s.change[0], j);
            w[j + 20] = Goldilocks.limb(s.change[1], j);
        }
        if (gross == 1) {
            w[24] = 1;
            w[25] = 0;
            w[27] = EXIT_TAG + uint64((h >> 160) & ((uint256(1) << 62) - 1));
            for (uint256 j; j < 4; ++j) w[j + 28] = uint48(uint160(h) >> (48 * j));
        } else {
            w[24] = gross - 1;
            w[25] = 1;
            w[27] = EXIT_TAG;
            for (uint256 j; j < 4; ++j) {
                w[j + 28] = uint48(((1 << 128) | (h >> 128)) >> (48 * j));
                w[j + 32] = uint48(((1 << 128) | uint128(h)) >> (48 * j));
            }
        }
        w[36] = s.notBefore;
        return abi.encode(keccak256(abi.encode(w)));
    }

    function _lockOutbound(uint64 gross) private returns (ExitOrder memory o) {
        o = _order(uint64(ETH_LANE), uint64(ARB_LANE), gross, payable(address(0xd000)), bytes32(uint256(1)));
        PoolSpend memory s = _spend();
        pool.withdrawAcross{value: _budget()}(_exitProof(o, gross), s, o, _gas());
        ++nonce;
    }

    function _deliverArb(address to, bytes memory data) private {
        outbox.deliver(ARB_PEER, bridge, to, data);
    }

    function _deliverBase(address to, bytes memory data) private {
        base.deliver(BASE_PEER, to, data);
    }

    function _bookBalanced() private view {
        assert(address(pool).balance >= pool.shieldedNative() + pool.reservedNative() + pool.outboundNative());
    }

    // ------------------------------------------------------------------ flows

    function test_LockedExitSettlesAndReplenishesLiquidity() public {
        pool.fundLiquidity{value: 5 ether}();
        pool.deposit{value: 11 ether}(bytes32(uint256(1_101)));
        uint256 liquidity = pool.liquidityNative();
        ExitOrder memory o = _lockOutbound(2 ether);

        assert(pool.exitStage(pool.exitId(o)) == EthNetworkState.Stage.Locked);
        assert(pool.outboundNative() == 2 ether && pool.liquidityNative() == liquidity);
        assert(address(uint160(0xd000)).balance == 0);
        _bookBalanced();

        // A paid packet from the destination turns the escrow into local liquidity.
        bytes memory paid = abi.encodeCall(EthNetworkState.acceptPacket, (pool.exitId(o), o, EthNetworkState.Packet.Paid));
        _deliverArb(address(pool), paid);
        assert(pool.exitStage(pool.exitId(o)) == EthNetworkState.Stage.Settled);
        assert(pool.outboundNative() == 0);
        assert(pool.liquidityNative() == liquidity + 2 ether);
        _bookBalanced();

        // Re-delivery is idempotent and a settled route can never be refunded.
        _deliverArb(address(pool), paid);
        assert(pool.liquidityNative() == liquidity + 2 ether);
        bool reverted;
        try pool.refundAcross(o) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
    }

    function test_CancelledExitRestoresExactlyOneNote() public {
        pool.fundLiquidity{value: 5 ether}();
        pool.deposit{value: 11 ether}(bytes32(uint256(1_102)));
        ExitOrder memory o = _lockOutbound(3 ether);
        uint256 shielded = pool.shieldedNative();
        uint64 leaves = pool.reservedRefundLeaves();

        bytes memory cancelled = abi.encodeCall(EthNetworkState.acceptPacket, (pool.exitId(o), o, EthNetworkState.Packet.Cancelled));
        _deliverArb(address(pool), cancelled);
        assert(pool.exitStage(pool.exitId(o)) == EthNetworkState.Stage.Refundable);

        pool.refundAcross(o);
        assert(pool.exitStage(pool.exitId(o)) == EthNetworkState.Stage.Refunded);
        assert(pool.shieldedNative() == shielded + 3 ether);
        assert(pool.outboundNative() == 0);
        assert(pool.reservedRefundLeaves() == leaves - 1);
        _bookBalanced();

        bool reverted;
        try pool.refundAcross(o) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
    }

    function test_InboundAuthorizeClaimThenRules() public {
        pool.fundLiquidity{value: 5 ether}();
        ExitOrder memory o = _order(uint64(ARB_LANE), uint64(ETH_LANE), 1 ether, payable(address(0xe000)), bytes32(uint256(2)));
        bytes32 id = pool.exitId(o);

        // Claim before the authenticated open packet must fail.
        bool reverted;
        try pool.claimAcross(o) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);

        _deliverArb(address(pool), abi.encodeCall(EthNetworkState.acceptPacket, (id, o, EthNetworkState.Packet.Open)));
        assert(pool.exitStage(id) == EthNetworkState.Stage.Authorized);

        (uint256 fee, uint256 net) = pool.quoteFee(1 ether);
        pool.claimAcross(o);
        assert(address(uint160(0xe000)).balance == net);
        assert(pool.liquidityNative() == 4 ether);
        assert(staking.fundedWei() == fee);
        assert(pool.exitStage(id) == EthNetworkState.Stage.Paid);

        // Neither a second claim nor a cancel after payment is possible.
        reverted = false;
        try pool.claimAcross(o) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        reverted = false;
        try pool.cancelAcross(o, bytes32(uint256(2))) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);

        // Publishing the outcome is permissionless and repeatable.
        pool.publishOutcome{value: _budget()}(o, _gas());
        _bookBalanced();
    }

    function test_InboundCancelNeedsTheSecretAndBlocksPayment() public {
        pool.fundLiquidity{value: 5 ether}();
        ExitOrder memory o = _order(uint64(ARB_LANE), uint64(ETH_LANE), 1 ether, payable(address(0xe100)), bytes32(uint256(3)));
        bytes32 id = pool.exitId(o);
        _deliverArb(address(pool), abi.encodeCall(EthNetworkState.acceptPacket, (id, o, EthNetworkState.Packet.Open)));

        bool reverted;
        try pool.cancelAcross(o, bytes32(uint256(99))) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);

        pool.cancelAcross(o, bytes32(uint256(3)));
        assert(pool.exitStage(id) == EthNetworkState.Stage.Cancelled);
        reverted = false;
        try pool.claimAcross(o) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        assert(address(uint160(0xe100)).balance == 0);
        assert(pool.liquidityNative() == 5 ether);
        _bookBalanced();
    }

    function test_ShortLiquidityBlocksThenAllowsClaim() public {
        pool.fundLiquidity{value: 1 ether}();
        ExitOrder memory o = _order(uint64(ARB_LANE), uint64(ETH_LANE), 2 ether, payable(address(0xe200)), bytes32(uint256(4)));
        _deliverArb(address(pool), abi.encodeCall(EthNetworkState.acceptPacket, (pool.exitId(o), o, EthNetworkState.Packet.Open)));

        bool reverted;
        try pool.claimAcross(o) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        assert(pool.exitStage(pool.exitId(o)) == EthNetworkState.Stage.Authorized);

        pool.fundLiquidity{value: 1 ether}();
        pool.claimAcross(o);
        assert(pool.liquidityNative() == 0);
        assert(address(uint160(0xe200)).balance == 2 ether - 2 ether * 9 / 10_000);
    }

    function test_RetryAllowedAndForwardRejectedForDirectRoute() public {
        pool.fundLiquidity{value: 5 ether}();
        pool.deposit{value: 11 ether}(bytes32(uint256(1_103)));
        ExitOrder memory o = _lockOutbound(1 ether);
        pool.retryAcross{value: _budget()}(o, _gas());

        bool reverted;
        try pool.forwardPacket(o, EthNetworkState.Packet.Open, _gas()) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
        _bookBalanced();
    }

    function test_WrongLaneAndBadOrdersAreRejected() public {
        pool.fundLiquidity{value: 5 ether}();
        pool.deposit{value: 11 ether}(bytes32(uint256(1_104)));
        PoolSpend memory s = _spend();

        // Source must be this lane.
        ExitOrder memory wrongSource = _order(uint64(ARB_LANE), uint64(ETH_LANE), 1 ether, payable(address(0xd100)), bytes32(uint256(5)));
        bool reverted;
        try pool.withdrawAcross{value: _budget()}(_exitProof(wrongSource, 1 ether), s, wrongSource, _gas()) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);

        // An order that was never authorized can never pay out.
        ExitOrder memory toPeer = _order(uint64(ARB_LANE), uint64(ETH_LANE), 1 ether, payable(ARB_PEER), bytes32(uint256(6)));
        reverted = false;
        try pool.claimAcross(toPeer) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assert(reverted);
    }
}
