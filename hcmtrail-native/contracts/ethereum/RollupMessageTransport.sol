// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IBaseMessenger {
    function xDomainMessageSender() external view returns (address);
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external;
}

interface IArbitrumInbox {
    function bridge() external view returns (address);
    function unsafeCreateRetryableTicket(address to, uint256 callValue, uint256 submission,
        address excessFeeRefund, address callValueRefund, uint256 gasLimit, uint256 maxFeePerGas,
        bytes calldata data) external payable returns (uint256);
}

interface IArbitrumBridge {
    function activeOutbox() external view returns (address);
}

interface IArbitrumOutbox {
    function l2ToL1Sender() external view returns (address);
}

interface IArbSys {
    function sendTxToL1(address to, bytes calldata data) external returns (uint256);
}

struct PacketGas {
    uint64 gasLimit;
    uint128 maxFeePerGas;
    uint128 maxSubmissionCost;
    address refundL2;
}

struct MessageConfig {
    address baseMessenger;
    address arbInbox;
    address arbBridge;
    address arbSys;
}

/// Messages are zero-principal. Only a separate L1->Arbitrum retryable gas
/// budget can be paid. Local deployments use fixtures, not real system contracts.
library RollupMessageTransport {
    uint64 internal constant ETHEREUM = 1;
    uint64 internal constant ARBITRUM = 42161;
    uint64 internal constant BASE = 8453;
    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    uint32 internal constant RECEIVE_GAS = 250_000;

    error InvalidTransport();
    error InvalidMessageSender();
    error InvalidPacketGas();

    function check(uint64 lane, MessageConfig memory c) internal view {
        if (lane == ETHEREUM) {
            if (c.baseMessenger.code.length == 0 || c.arbInbox.code.length == 0 || c.arbBridge.code.length == 0
                || c.arbSys != address(0) || c.baseMessenger == c.arbInbox || c.baseMessenger == c.arbBridge
                || c.arbInbox == c.arbBridge || IArbitrumInbox(c.arbInbox).bridge() != c.arbBridge) revert InvalidTransport();
        } else if (lane == BASE) {
            if (c.baseMessenger.code.length == 0 || c.arbInbox != address(0) || c.arbBridge != address(0) || c.arbSys != address(0)) revert InvalidTransport();
        } else if (lane != ARBITRUM || c.arbSys.code.length == 0 || c.baseMessenger != address(0)
            || c.arbInbox != address(0) || c.arbBridge != address(0)) revert InvalidTransport();
    }

    function authenticate(MessageConfig memory c, uint64 here, uint64 previous, address pool) internal view {
        if (here == BASE || (here == ETHEREUM && previous == BASE)) {
            if (msg.sender != c.baseMessenger || IBaseMessenger(c.baseMessenger).xDomainMessageSender() != pool) revert InvalidMessageSender();
        } else if (here == ETHEREUM && previous == ARBITRUM) {
            if (msg.sender != c.arbBridge) revert InvalidMessageSender();
            address outbox = IArbitrumBridge(c.arbBridge).activeOutbox();
            if (outbox.code.length == 0 || IArbitrumOutbox(outbox).l2ToL1Sender() != pool) revert InvalidMessageSender();
        } else if (here == ARBITRUM && previous == ETHEREUM) {
            unchecked { if (msg.sender != address(uint160(pool) + ALIAS_OFFSET)) revert InvalidMessageSender(); }
        } else revert InvalidMessageSender();
    }

    function send(MessageConfig memory c, uint64 here, uint64 next, address to, bytes memory data, PacketGas calldata bid) internal {
        if (here == ETHEREUM && next == ARBITRUM) {
            if (bid.gasLimit < RECEIVE_GAS || bid.gasLimit > 2_000_000 || bid.maxFeePerGas <= 1 || bid.refundL2 == address(0)
                || msg.value != uint256(bid.gasLimit) * bid.maxFeePerGas + uint256(bid.maxSubmissionCost)) revert InvalidPacketGas();
            // No call-value. Passing the full budget explicitly avoids any need to
            // rewrite refund addresses. An expired message can be published again.
            IArbitrumInbox(c.arbInbox).unsafeCreateRetryableTicket{value: msg.value}(
                to, 0, bid.maxSubmissionCost, bid.refundL2, bid.refundL2, bid.gasLimit, bid.maxFeePerGas, data
            );
        } else {
            if (msg.value != 0 || bid.gasLimit != 0 || bid.maxFeePerGas != 0 || bid.maxSubmissionCost != 0
                || bid.refundL2 != address(0)) revert InvalidPacketGas();
            if ((here == ETHEREUM && next == BASE) || (here == BASE && next == ETHEREUM)) {
                IBaseMessenger(c.baseMessenger).sendMessage(to, data, RECEIVE_GAS);
            } else if (here == ARBITRUM && next == ETHEREUM) {
                IArbSys(c.arbSys).sendTxToL1(to, data);
            } else revert InvalidTransport();
        }
    }
}
