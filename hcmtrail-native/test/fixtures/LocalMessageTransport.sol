// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Zero-value facsimile of messenger, Inbox and ArbSys. An EDR-only test driver
/// explicitly delivers messages between VMs. It never imports/funds principal.
contract LocalMessageTransport {
    address private immutable driver = msg.sender;
    address public immutable bridge;
    address private remote;
    bool public stopped;
    uint256 private nonce;

    event MessageQueued(address indexed from, address indexed to, bytes packet, uint256 callValue, uint256 gasBudget);
    error NotDriver();
    error TransportStopped();
    error BadMessageBudget();

    constructor(address bridge_) { bridge = bridge_; }
    function setStopped(bool value) external {
        if (msg.sender != driver) revert NotDriver();
        stopped = value;
    }
    function xDomainMessageSender() external view returns (address) { return remote; }

    function sendMessage(address to, bytes calldata data, uint32) external { _queue(to, data); }
    function sendTxToL1(address to, bytes calldata data) external returns (uint256) { return _queue(to, data); }
    function unsafeCreateRetryableTicket(address to, uint256 callValue, uint256 submission,
        address feeRefund, address valueRefund, uint256 gasLimit, uint256 price, bytes calldata data) external payable returns (uint256)
    {
        if (bridge == address(0) || callValue != 0 || feeRefund == address(0) || feeRefund != valueRefund
            || msg.value != submission + gasLimit * price) revert BadMessageBudget();
        return _queue(to, data);
    }
    function _queue(address to, bytes calldata data) private returns (uint256) {
        if (stopped) revert TransportStopped();
        emit MessageQueued(msg.sender, to, data, 0, msg.value);
        return nonce++;
    }
    function deliver(address from, address to, bytes calldata data) external {
        if (msg.sender != driver) revert NotDriver();
        remote = from;
        callTarget(to, data);
        remote = address(0);
    }
}

contract LocalArbMessageBridge {
    address private immutable outbox;
    address public activeOutbox;
    constructor(address outbox_) { outbox = outbox_; }
    function executeCall(address to, bytes calldata data) external {
        require(msg.sender == outbox && activeOutbox == address(0));
        activeOutbox = msg.sender;
        callTarget(to, data);
        activeOutbox = address(0);
    }
}

contract LocalArbMessageOutbox {
    address private immutable driver = msg.sender;
    address public l2ToL1Sender;
    function deliver(address from, LocalArbMessageBridge b, address to, bytes calldata data) external {
        require(msg.sender == driver);
        l2ToL1Sender = from;
        b.executeCall(to, data);
        l2ToL1Sender = address(0);
    }
}

function callTarget(address to, bytes calldata data) {
    (bool ok, bytes memory result) = to.call(data);
    if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
}
