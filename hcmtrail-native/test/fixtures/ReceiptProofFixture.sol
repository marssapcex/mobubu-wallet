// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IFinalizedEvents, WithdrawalTerms} from "../../contracts/crosschain/WithdrawalTerms.sol";

import {SettlementReceipt} from "../../contracts/receipt-proof/SettlementReceipt.sol";

/// Test only: exercises exactly the event ABI and consumer-call boundary with no custody.
contract ReceiptProofFixture {
    event Marker(bytes32 indexed id);
    event SettlementMessage(uint8 indexed kind, bytes32 indexed order, bytes32 data);

    function report(bytes32 order, bytes32 rate, bool fail) external {
        emit Marker(order);
        emit SettlementMessage(1, order, bytes32(0));
        emit SettlementMessage(2, order, rate);
        emit SettlementMessage(3, order, rate);
        emit SettlementMessage(4, order, bytes32(0));
        require(!fail);
    }

    function matchReceipt(bytes calldata receipt, uint16 index, address emitter, uint8 kind, bytes32 order, bytes32 data)
        external pure returns (bool)
    {
        return SettlementReceipt.matches(receipt, index, SettlementReceipt.Claim(emitter, kind, order, data));
    }

    function check(IFinalizedEvents verifier, uint256 chain, address emitter, uint8 kind, bytes32 order,
        bytes32 data, bytes calldata proof) external view returns (bool)
    {
        WithdrawalTerms.authenticated(verifier, chain, emitter, kind, order, data, proof);
        return true;
    }
}
