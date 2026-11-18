// SPDX-License-Identifier: ISC
pragma solidity 0.8.24;

import {SlhDsaSha2_128s} from "./lib/SlhDsaSha2_128s.sol";

/// @notice Native ETH / BNB leg of a liquidity-backed cross-chain swap.
/// @dev The treasury key enforces the local leg, not finality on another chain.
/// Deposits remain segregated from payout liquidity until collected or refunded.
contract NativeSwapRail {
    bytes32 public constant ORDER_DOMAIN = keccak256("mobubu:native-swap:order:v1");
    bytes32 public constant SETTLE_DOMAIN = keccak256("mobubu:native-swap:rail:settle:v1");
    uint8 public constant PAY = 1;
    uint8 public constant REFUND = 2;
    uint8 public constant COLLECT = 3;
    uint8 public constant REJECT = 4;
    uint256 private constant RECEIVE_GAS = 100_000;

    struct Order {
        bytes32 deployment;
        bytes32 key;
        bytes32 nonce;
        bytes32 source;
        bytes32 destination;
        bytes32 quote;
        address payer;
        bytes32 recipient;
        bytes32 refund;
        uint256 amountIn;
        uint256 amountOut;
        uint256 minOut;
        uint64 fundUntil;
        uint64 payUntil;
    }
    struct Credit { uint256 amount; address refund; uint8 state; }

    bytes32 public immutable treasuryKey;
    uint256 public liquidity;
    uint256 public escrowed;
    mapping(bytes32 => Credit) public credits;
    mapping(bytes32 => uint8) public payoutState; // 0=open, 1=paid, 2=irreversibly failed/rejected
    bool private locked;

    error InvalidOrder();
    error InvalidSettlement();
    error InvalidSignature();
    error AlreadyResolved();
    error TransferFailed();
    error ReentrantCall();

    event Funded(bytes32 indexed orderId, address indexed payer, uint256 amount);
    event LiquidityProvided(address indexed provider, uint256 amount);
    event Resolved(bytes32 indexed orderId, uint8 indexed action, address recipient, uint256 amount, bool delivered);

    constructor(bytes32 treasuryKey_) {
        if (treasuryKey_ == bytes32(0)) revert InvalidSignature();
        treasuryKey = treasuryKey_;
    }

    modifier guard() {
        if (locked) revert ReentrantCall();
        locked = true;
        _;
        locked = false;
    }

    function railId() public view returns (bytes32) {
        return keccak256(abi.encode("mobubu:native-swap:evm-rail:v1", block.chainid, address(this)));
    }

    function orderMessage(Order calldata order) public pure returns (bytes memory) {
        return abi.encode(ORDER_DOMAIN, order);
    }

    function settlementMessage(uint8 action, bytes32 orderId, address recipient, uint256 amount, address submitter)
        public view returns (bytes memory)
    {
        return abi.encode(SETTLE_DOMAIN, railId(), action, orderId, recipient, amount, submitter);
    }

    /// @notice Sponsor prefunded liquidity. Not a redeemable LP share.
    function provideLiquidity() external payable guard {
        if (msg.value == 0) revert InvalidSettlement();
        liquidity += msg.value;
        emit LiquidityProvided(msg.sender, msg.value);
    }

    /// @notice Clients must first register the signed order with the swap coordinator.
    function fund(Order calldata order, address refund, bytes calldata signature) external payable guard {
        if (
            order.source != railId() || order.destination == order.source || order.payer != msg.sender ||
            order.key == bytes32(0) || order.nonce == bytes32(0) || order.quote == bytes32(0) ||
            order.amountIn != msg.value || msg.value == 0 || order.minOut == 0 || order.amountOut < order.minOut ||
            block.timestamp > order.fundUntil || order.payUntil <= order.fundUntil ||
            refund == address(0) || refund == address(this) || sha256(abi.encodePacked(refund)) != order.refund
        ) revert InvalidOrder();
        bytes memory message = orderMessage(order);
        bytes32 orderId = sha256(message);
        if (credits[orderId].state != 0) revert AlreadyResolved();
        if (!SlhDsaSha2_128s.verify(order.key, message, signature)) revert InvalidSignature();
        credits[orderId] = Credit(msg.value, refund, 1);
        escrowed += msg.value;
        emit Funded(orderId, msg.sender, msg.value);
    }

    /// @notice Pay the native asset only to the destination authorized by the user and treasury.
    /// @dev The treasury checks foreign funding. Expiry, inadequate liquidity and a failed
    /// receiver call consume only this order's payout; they cannot be retried after a refund.
    function pay(Order calldata order, address recipient, bytes calldata userSignature, bytes calldata treasurySignature)
        external guard
    {
        if (
            order.destination != railId() || order.source == order.destination || order.key == bytes32(0) ||
            order.nonce == bytes32(0) || order.quote == bytes32(0) || order.amountIn == 0 || order.minOut == 0 ||
            order.amountOut < order.minOut || order.payUntil <= order.fundUntil || recipient == address(0) ||
            recipient == address(this) || sha256(abi.encodePacked(recipient)) != order.recipient
        ) revert InvalidOrder();
        bytes memory message = orderMessage(order);
        bytes32 orderId = sha256(message);
        if (payoutState[orderId] != 0) revert AlreadyResolved();
        _authorize(PAY, orderId, recipient, order.amountOut, treasurySignature);
        if (!SlhDsaSha2_128s.verify(order.key, message, userSignature)) revert InvalidSignature();
        bool delivered;
        payoutState[orderId] = 2;
        if (block.timestamp < order.payUntil && order.amountOut <= liquidity) {
            liquidity -= order.amountOut;
            // A gas-starved relayer must revert, not irreversibly reject a payment.
            delivered = _send(recipient, order.amountOut);
            if (delivered) payoutState[orderId] = 1;
            else liquidity += order.amountOut;
        }
        emit Resolved(orderId, PAY, recipient, order.amountOut, delivered);
    }

    /// @notice Treasury acknowledges a rejected destination payout or resolves source credit.
    function settle(uint8 action, bytes32 orderId, address recipient, uint256 amount, bytes calldata signature)
        external guard
    {
        if (orderId == bytes32(0) || action < REFUND || action > REJECT) revert InvalidSettlement();
        _authorize(action, orderId, recipient, amount, signature);
        if (action == REJECT) {
            if (payoutState[orderId] != 0) revert AlreadyResolved();
            if (recipient != address(0) || amount != 0) revert InvalidSettlement();
            payoutState[orderId] = 2;
            emit Resolved(orderId, action, recipient, amount, false);
            return;
        }
        Credit storage credit = credits[orderId];
        if (credit.state != 1 || credit.amount != amount) revert InvalidSettlement();
        escrowed -= amount;
        if (action == REFUND) {
            if (recipient != credit.refund) revert InvalidSettlement();
            credit.state = 2;
            if (!_send(recipient, amount)) revert TransferFailed();
        } else {
            if (recipient != address(0)) revert InvalidSettlement();
            credit.state = 3;
            liquidity += amount;
        }
        emit Resolved(orderId, action, recipient, amount, true);
    }

    function _authorize(uint8 action, bytes32 orderId, address recipient, uint256 amount, bytes calldata signature)
        private view
    {
        if (!SlhDsaSha2_128s.verify(treasuryKey, settlementMessage(action, orderId, recipient, amount, msg.sender), signature)) {
            revert InvalidSignature();
        }
    }

    function _send(address to, uint256 value) private returns (bool ok) {
        if (gasleft() < RECEIVE_GAS + 60_000) revert InvalidSettlement();
        // Do not copy arbitrarily large return data from a recipient.
        assembly ("memory-safe") { ok := call(RECEIVE_GAS, to, value, 0, 0, 0, 0) }
    }
}
