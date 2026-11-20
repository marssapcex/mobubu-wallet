// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StrictRlp} from "./StrictRlp.sol";

library SettlementReceipt {
    bytes32 internal constant TOPIC = keccak256("SettlementMessage(uint8,bytes32,bytes32)");
    struct Claim { address emitter; uint8 kind; bytes32 order; bytes32 data; }
    error BadReceipt();

    function matches(bytes calldata record, uint16 localLogIndex, Claim memory claim) internal pure returns (bool) {
        if (record.length == 0) revert BadReceipt();
        uint8 first = uint8(record[0]);
        if (first < 0x80) {
            if (first == 0 || first > 4) revert BadReceipt(); // supported EIP-2718 receipt types
            record = record[1:];
        }
        (StrictRlp.Item[] memory fields, uint256 n) = StrictRlp.children(record, StrictRlp.root(record), 4);
        if (n != 4 || StrictRlp.integer64(record, fields[0]) != 1 || StrictRlp.integer64(record, fields[1]) == 0
            || StrictRlp.payload(record, fields[2]).length != 256 || !fields[3].list) revert BadReceipt();
        uint256 pos = fields[3].data;
        for (uint256 i; i < localLogIndex && pos < fields[3].end; ++i) {
            pos = StrictRlp.at(record, pos, fields[3].end).end;
        }
        if (pos == fields[3].end) return false;
        StrictRlp.Item memory logItem = StrictRlp.at(record, pos, fields[3].end);
        (StrictRlp.Item[] memory logFields, uint256 size) = StrictRlp.children(record, logItem, 3);
        if (size != 3 || StrictRlp.account(record, logFields[0]) != claim.emitter) return false;
        (StrictRlp.Item[] memory topics, uint256 numTopics) = StrictRlp.children(record, logFields[1], 4);
        return numTopics == 3 && StrictRlp.word(record, topics[0]) == TOPIC
            && StrictRlp.word(record, topics[1]) == bytes32(uint256(claim.kind))
            && StrictRlp.word(record, topics[2]) == claim.order
            && StrictRlp.payload(record, logFields[2]).length == 32
            && StrictRlp.word(record, logFields[2]) == claim.data;
    }
}
