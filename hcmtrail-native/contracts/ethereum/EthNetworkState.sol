// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EthPoolState, PoolSpend} from "./EthPoolState.sol";
import {RollupMessageTransport as Transport, PacketGas, MessageConfig} from "./RollupMessageTransport.sol";

struct ExitOrder {
    uint64 source;
    uint64 destination;
    uint64 gross;
    address payable recipient;
    bytes32 refundOwner;
    bytes32 cancelHash;
    bytes32 salt;
}

struct NetworkConfig {
    bytes32 realm;
    address[3] pools; // Ethereum, Arbitrum One, Base
    MessageConfig messages;
}

/// Native-ETH clearing out of explicitly earmarked destination liquidity. No ETH
/// principal goes in a packet; existing note and batch liabilities are separate.
abstract contract EthNetworkState is EthPoolState {
    enum Packet { Open, Paid, Cancelled }
    enum Stage { Unseen, Locked, Authorized, Paid, Cancelled, Settled, Refundable, Refunded }

    uint64 public immutable lane;
    bytes32 public immutable networkDomain;
    address private immutable ethereumPool;
    address private immutable arbitrumPool;
    address private immutable basePool;
    MessageConfig private messages;
    uint64 private constant EXIT_TAG = (1 << 63) + 1; // outside direct and batch ranges

    uint256 public liquidityNative;
    uint256 public outboundNative;
    mapping(bytes32 id => Stage) public exitStage;
    mapping(bytes32 id => bytes32 leaf) private refundLeaves;
    mapping(bytes32 id => uint8 kinds) public transitPackets;

    event LiquidityFunded(address indexed from, uint256 amount);
    event ExitLocked(bytes32 indexed id, ExitOrder order);
    event ExitAuthorized(bytes32 indexed id);
    event ExitPaid(bytes32 indexed id, address indexed recipient, uint256 net, uint256 fee);
    event ExitCancelled(bytes32 indexed id);
    event ExitSettled(bytes32 indexed id, uint64 gross);
    event ExitRefunded(bytes32 indexed id, bytes32 indexed leaf, uint64 index, uint64 gross);
    event PacketSent(bytes32 indexed id, Packet indexed kind, uint64 indexed next);
    event PacketTransit(bytes32 indexed id, Packet indexed kind);

    error InvalidNetwork();
    error InvalidExit();
    error InvalidExitStage();
    error InsufficientLiquidity();
    error InvalidCancellation();

    constructor(NetworkConfig memory c) {
        uint256 id = block.chainid;
        // Concrete pool rejects all public chain IDs before it accepts user funds.
        if (id == 31337) lane = Transport.ETHEREUM;
        else if (id == 31338) lane = Transport.ARBITRUM;
        else if (id == 31339) lane = Transport.BASE;
        else revert InvalidNetwork();
        ethereumPool = c.pools[0];
        arbitrumPool = c.pools[1];
        basePool = c.pools[2];
        if (c.realm == bytes32(0) || peerPool(lane) != address(this) || c.pools[0] == address(0)
            || c.pools[1] == address(0) || c.pools[2] == address(0)) revert InvalidNetwork();
        networkDomain = keccak256(abi.encode("hcmtrail.eth-credit.v1", c.realm, c.pools, FEE_BPS));
        Transport.check(lane, c.messages);
        messages = c.messages;
    }

    function exitId(ExitOrder calldata o) public view returns (bytes32) {
        return keccak256(abi.encode(networkDomain, o));
    }

    /// @notice Protocol liquidity, not a deposit note or a redeemable LP share.
    /// Lab prefunding is explicit; forced ETH and other people's notes do not count.
    function fundLiquidity() external payable transition {
        if (msg.value == 0) revert InvalidAmount();
        liquidityNative += msg.value;
        emit LiquidityFunded(msg.sender, msg.value);
    }

    function withdrawAcross(bytes calldata proof, PoolSpend calldata spend, ExitOrder calldata o, PacketGas calldata bid)
        external payable transition
    {
        _checkOrder(o);
        if (lane != o.source) revert InvalidExit();
        bytes32 id = exitId(o);
        _requireStage(id, Stage.Unseen);
        // Reserve tree space for the refund even if unrelated deposits later fill the tree.
        refundLeaves[id] = commitment(o.gross, o.refundOwner);
        ++reservedRefundLeaves;
        _consumeExit(proof, spend, o.gross, id);
        outboundNative += o.gross;
        exitStage[id] = Stage.Locked;
        emit ExitLocked(id, o);
        _send(id, o, Packet.Open, bid);
    }

    /// Gas/retryable failure after enqueue cannot steal a note: anyone can
    /// republish the same immutable packet without a new proof or debit.
    function retryAcross(ExitOrder calldata o, PacketGas calldata bid) external payable transition {
        bytes32 id = exitId(o);
        _requireStage(id, Stage.Locked);
        _send(id, o, Packet.Open, bid);
    }

    function acceptPacket(bytes32 id, ExitOrder calldata o, Packet kind) external transition {
        _checkOrder(o);
        if (id != exitId(o)) revert InvalidExit();
        (uint64 from, uint64 to) = _endpoints(o, kind);
        if (lane == from || (lane != to && lane != Transport.ETHEREUM)) revert InvalidExit();
        Transport.authenticate(messages, lane, lane == Transport.ETHEREUM ? from : Transport.ETHEREUM,
            peerPool(lane == Transport.ETHEREUM ? from : Transport.ETHEREUM));
        if (lane != to) {
            transitPackets[id] |= uint8(1 << uint8(kind));
            emit PacketTransit(id, kind);
        } else if (kind == Packet.Open) {
            if (exitStage[id] == Stage.Unseen) {
                exitStage[id] = Stage.Authorized;
                emit ExitAuthorized(id);
            } // authenticated and idempotent, even after payment or cancellation
        } else {
            _complete(id, o.gross, kind);
        }
    }

    function forwardPacket(ExitOrder calldata o, Packet kind, PacketGas calldata bid) external payable transition {
        bytes32 id = exitId(o);
        if (transitPackets[id] & uint8(1 << uint8(kind)) == 0) revert InvalidExitStage();
        _send(id, o, kind, bid);
    }

    /// Anyone can trigger the payout to the proof-bound recipient. A short pot
    /// or a failing payment does not mark the route as paid or take any fees.
    function claimAcross(ExitOrder calldata o) external transition {
        bytes32 id = exitId(o);
        _requireStage(id, Stage.Authorized);
        if (liquidityNative < o.gross) revert InsufficientLiquidity();
        _recipient(o.recipient);
        exitStage[id] = Stage.Paid;
        liquidityNative -= o.gross;
        (uint256 fee, uint256 net) = quoteFee(o.gross);
        _fundFee(fee);
        (bool ok,) = o.recipient.call{value: net}("");
        if (!ok) revert PayoutFailed(0);
        emit ExitPaid(id, o.recipient, net, fee);
    }

    /// The cancellation secret is separate from every note secret. Any resulting
    /// refund goes to the note fixed in the proof, not the transaction caller.
    function cancelAcross(ExitOrder calldata o, bytes32 secret) external transition {
        bytes32 id = exitId(o);
        _requireStage(id, Stage.Authorized);
        if (keccak256(abi.encodePacked(secret)) != o.cancelHash) revert InvalidCancellation();
        exitStage[id] = Stage.Cancelled;
        emit ExitCancelled(id);
    }

    function publishOutcome(ExitOrder calldata o, PacketGas calldata bid) external payable transition {
        bytes32 id = exitId(o);
        Stage status = exitStage[id];
        if (status != Stage.Paid && status != Stage.Cancelled) revert InvalidExitStage();
        _send(id, o, status == Stage.Paid ? Packet.Paid : Packet.Cancelled, bid);
    }

    /// @notice No time-based source refund. Only a finalized destination
    /// cancellation can authorize restoring the escrowed gross to a new note.
    function refundAcross(ExitOrder calldata o) external transition {
        bytes32 id = exitId(o);
        _requireStage(id, Stage.Refundable);
        bytes32 leaf = _release(id, o.gross, Stage.Refunded);
        shieldedNative += o.gross;
        uint64 at = _append(leaf, bytes32(0), false);
        emit ExitRefunded(id, leaf, at, o.gross);
    }

    function _complete(bytes32 id, uint64 gross, Packet kind) private {
        Stage status = exitStage[id];
        if (kind == Packet.Paid) {
            if (status == Stage.Settled) return;
            _requireStage(id, Stage.Locked);
            _release(id, gross, Stage.Settled);
            liquidityNative += gross;
            emit ExitSettled(id, gross);
        } else {
            if (status == Stage.Refundable || status == Stage.Refunded) return;
            _requireStage(id, Stage.Locked);
            exitStage[id] = Stage.Refundable; // append locally, not in the message gas budget
        }
    }

    function _release(bytes32 id, uint64 gross, Stage terminal) private returns (bytes32 leaf) {
        leaf = refundLeaves[id];
        delete refundLeaves[id];
        --reservedRefundLeaves;
        outboundNative -= gross;
        exitStage[id] = terminal;
    }

    // Route IDs fix source and destination. The reachable stages already enforce
    // the local role (e.g. Authorized is only ever written at the final destination).
    function _requireStage(bytes32 id, Stage required) private view {
        if (exitStage[id] != required) revert InvalidExitStage();
    }

    function _endpoints(ExitOrder calldata o, Packet kind) private pure returns (uint64 from, uint64 to) {
        return kind == Packet.Open ? (o.source, o.destination) : (o.destination, o.source);
    }

    function _send(bytes32 id, ExitOrder calldata o, Packet kind, PacketGas calldata bid) private {
        (, uint64 to) = _endpoints(o, kind);
        uint64 next = lane == Transport.ETHEREUM ? to : Transport.ETHEREUM;
        Transport.send(messages, lane, next, peerPool(next), abi.encodeCall(this.acceptPacket, (id, o, kind)), bid);
        emit PacketSent(id, kind, next);
    }

    function _checkOrder(ExitOrder calldata o) private view {
        if (o.source == o.destination || o.recipient == address(0) || o.recipient == peerPool(o.destination)
            || peerPool(o.source) == address(0) || o.gross == 0 || o.gross > maxNoteValue()
            || o.refundOwner == bytes32(0) || o.cancelHash == bytes32(0) || o.salt == bytes32(0)) revert InvalidExit();
    }

    function peerPool(uint64 id) public view returns (address) {
        if (id == Transport.ETHEREUM) return ethereumPool;
        if (id == Transport.ARBITRUM) return arbitrumPool;
        if (id == Transport.BASE) return basePool;
        revert InvalidExit();
    }

    function _consumeExit(bytes calldata proof, PoolSpend calldata spend, uint64 gross, bytes32 id) private {
        uint256 h = uint256(keccak256(abi.encode(domain, id)));
        if (gross == 1) {
            uint64 tag = EXIT_TAG + uint64((h >> 160) & ((uint256(1) << 62) - 1));
            _consume(proof, spend, 1, 0, tag, address(uint160(h)), address(0));
        } else {
            // These legs encode the route, not actual recipients or a one-wei fee.
            _consume(proof, spend, gross - 1, 1, EXIT_TAG,
                address(uint160((1 << 128) | (h >> 128))), address(uint160((1 << 128) | uint128(h))));
        }
    }
}
