// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GoldilocksFp8} from "./GoldilocksFp8.sol";
import {WideTranscript256} from "./WideTranscript256.sol";

/// HCFR v2 FRI research for the 256-bit target, not a 256-bit spend verifier.
/// Every opening is enforced across bounded transactions.
/// This proves proximity of a committed codeword, NOT any spend/AIR statement.
/// There is no custody, mock proof path, or consumer in the ETH pool.
contract WideFri256 {
    bytes8 public constant MAGIC = 0x4843465202081890; // HCFR v2, degree 8, domain log2=24, q=144
    uint256 public constant QUERIES = 144;
    uint256 public constant ROUNDS = 6;
    uint256 public constant DOMAIN_LOG = 24;
    uint256 private constant ELEMENT_BYTES = 64;
    uint256 private constant ROW_BYTES = 8 * ELEMENT_BYTES;
    uint256 public constant HEADER_BYTES = 8 + ROUNDS * 64 + ELEMENT_BYTES;
    uint256 public constant QUERY_BYTES = ROUNDS * ROW_BYTES + (21 + 18 + 15 + 12 + 9 + 6) * 64;
    uint256 public constant MAX_QUERIES_PER_TX = 3;
    uint256 private constant CONTEXT_LIMIT = 1024;

    struct Session {
        bytes32 first;
        bytes32 second;
        uint8 checked;
    }
    struct Prepared {
        bytes[6] roots;
        uint64[8][6] alphas;
        uint64[8] terminal;
        bytes querySeed;
    }
    struct Cursor {
        uint256 index;
        uint256 offset;
        uint64[8] previous;
    }

    error InvalidHeader();
    error InvalidSession();
    error WrongProof();
    error InvalidWindow();
    error InvalidOpening();
    error InvalidFold();

    uint256 public sessionCount;
    mapping(uint256 id => Session) private sessions;

    event Opened(uint256 indexed id, bytes32 first, bytes32 second);
    event VerifiedPrefix(uint256 indexed id, uint8 checked);

    function open(bytes calldata context, bytes calldata header) external returns (uint256 id) {
        _checkHeader(context, header);
        _readTerminal(header);
        (bytes32 first, bytes32 second) = _key(context, header);
        id = ++sessionCount;
        sessions[id] = Session(first, second, 0);
        emit Opened(id, first, second);
    }

    function progress(uint256 id) external view returns (uint8 checked, bool complete) {
        if (id == 0 || id > sessionCount) revert InvalidSession();
        checked = sessions[id].checked;
        complete = checked == QUERIES;
    }

    /// Verify the next contiguous positions only, in the pinned query order.
    /// Anyone can submit a window. Failed checks leave the cursor unchanged.
    function check(uint256 id, bytes calldata context, bytes calldata header, bytes calldata openings) external {
        if (id == 0 || id > sessionCount) revert InvalidSession();
        Session storage s = sessions[id];
        uint256 start = s.checked;
        uint256 count = openings.length / QUERY_BYTES;
        if (count == 0 || count > MAX_QUERIES_PER_TX || count * QUERY_BYTES != openings.length || start + count > QUERIES) {
            revert InvalidWindow();
        }
        _checkHeader(context, header);
        (bytes32 first, bytes32 second) = _key(context, header);
        if (s.first != first || s.second != second) revert WrongProof();
        Prepared memory p = _prepare(context, header);
        for (uint256 i; i < count; ++i) {
            _query(p, start + i, openings[i * QUERY_BYTES:(i + 1) * QUERY_BYTES]);
        }
        s.checked = uint8(start + count);
        emit VerifiedPrefix(id, s.checked);
    }

    function _checkHeader(bytes calldata context, bytes calldata header) private pure {
        if (context.length > CONTEXT_LIMIT || header.length != HEADER_BYTES || bytes8(header[:8]) != MAGIC) {
            revert InvalidHeader();
        }
    }

    function _key(bytes calldata context, bytes calldata header) private view returns (bytes32 first, bytes32 second) {
        bytes memory full = WideTranscript256.sessionKey(context, header);
        assembly ("memory-safe") {
            first := mload(add(full, 32))
            second := mload(add(full, 64))
        }
    }

    function _readTerminal(bytes calldata header) private pure returns (uint64[8] memory tail) {
        bytes memory encoded = header[HEADER_BYTES - ELEMENT_BYTES:];
        for (uint256 i; i < 8; ++i) {
            uint64 v = WideTranscript256.readWord(encoded, 8 * i);
            if (v >= GoldilocksFp8.P) revert InvalidHeader();
            tail[i] = v;
        }
    }

    function _prepare(bytes calldata context, bytes calldata header) private view returns (Prepared memory p) {
        bytes memory state = WideTranscript256.start(abi.encodePacked(MAGIC, context));
        for (uint8 i; i < ROUNDS; ++i) {
            bytes memory root = header[8 + uint256(i) * 64:8 + (uint256(i) + 1) * 64];
            state = WideTranscript256.absorb(state, i, root);
            (p.alphas[i], state) = WideTranscript256.challenge(state, i);
            p.roots[i] = root;
        }
        p.terminal = _readTerminal(header);
        p.querySeed = WideTranscript256.absorb(state, 0xff, header[HEADER_BYTES - ELEMENT_BYTES:]);
    }

    function _query(Prepared memory p, uint256 query, bytes calldata record) private view {
        bytes memory draws = WideTranscript256.queryBlock(p.querySeed, uint32(query / 8));
        Cursor memory c;
        c.index = WideTranscript256.readWord(draws, (query % 8) * 8) & ((1 << DOMAIN_LOG) - 1);
        for (uint8 r; r < ROUNDS; ++r) _layer(p, c, r, record);
        if (!_equal(c.previous, p.terminal)) revert InvalidFold();
    }

    function _layer(Prepared memory p, Cursor memory c, uint8 round, bytes calldata record) private view {
        uint256 logDomain = DOMAIN_LOG - uint256(round) * 3;
        uint256 height = logDomain - 3;
        uint256 group = c.index & ((1 << height) - 1);
        bytes memory row = record[c.offset:c.offset + ROW_BYTES];
        c.offset += ROW_BYTES;
        _merkle(p.roots[round], round, group, row, record[c.offset:c.offset + height * 64]);
        c.offset += height * 64;
        uint64[8][8] memory ys;
        for (uint256 j; j < 8; ++j) {
            for (uint256 k; k < 8; ++k) ys[j][k] = WideTranscript256.readWord(row, (8 * j + k) * 8);
        }
        if (round > 0 && !_equal(ys[c.index >> height], c.previous)) revert InvalidFold();
        uint256 g = GoldilocksFp8.powBase(7, (GoldilocksFp8.P - 1) >> logDomain);
        c.previous = GoldilocksFp8.fold8(ys, uint64(GoldilocksFp8.powBase(g, group)), p.alphas[round]);
        c.index = group;
    }

    function _merkle(bytes memory root, uint8 round, uint256 index, bytes memory row, bytes calldata path) private view {
        bytes memory node = WideTranscript256.leaf(round, row);
        for (uint256 at; at < path.length; at += 64) {
            bytes memory sibling = path[at:at + 64];
            node = index & 1 == 0 ? WideTranscript256.parent(round, node, sibling) : WideTranscript256.parent(round, sibling, node);
            index >>= 1;
        }
        // Compare all 512 bits; never compare their keccak256 digests instead.
        bool ok;
        assembly ("memory-safe") {
            ok := and(eq(mload(add(node, 32)), mload(add(root, 32))), eq(mload(add(node, 64)), mload(add(root, 64))))
        }
        if (!ok) revert InvalidOpening();
    }

    function _equal(uint64[8] memory a, uint64[8] memory b) private pure returns (bool) {
        for (uint256 i; i < 8; ++i) if (a[i] != b[i]) return false;
        return true;
    }
}
