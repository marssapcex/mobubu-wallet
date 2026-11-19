// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoseidonGoldilocks} from "../vendor/nonos/PoseidonGoldilocks.sol";
import {Goldilocks} from "../vendor/nonos/libraries/Goldilocks.sol";

/// Append-only depth-32 note tree. Leaf 0 commits to the deployment domain, not to money.
abstract contract NativeNoteTree {
    uint256 public constant TREE_DEPTH = 32;
    uint256 private constant MAX_LEAVES = 1 << TREE_DEPTH;

    // z[0] = 0; z[i+1] = Poseidon.hash2(z[i], z[i]). The integration tests rebuild
    // the tree independently from this recurrence. Baking the empty levels in
    // avoids a second 31-hash walk during creation (notably the EIP-7825 tx cap).
    bytes private constant EMPTY_SUBTREES =
        hex"00000000000000000000000000000000000000000000000000000000000000004bbbda1ac693e3d65a430037146e172f26df37317f569e223cda43bb24edcd9c"
        hex"86927e668f7edd28702fb401044a2dfc98373342979de9033d7f757c2cd311c13b999b0c5b286b0416a7ed349a809e3fefdc14bf9d55277b6b0ab6d9923e132d"
        hex"d37f897c27358eb90abfabe30fde5f880a48573200d5bb9555a072ead6631eb5c76971305761250075361dc1c5520ef3391d24e992f5992c6a68878ce6a4153b"
        hex"f0194962e76ca75dd909aebc2117c398cc1bfcdd7e397a5a9aa68aa47c5dff245619b15134f62658158d9943a2784efd3e324bc5f855c049af61dda557be02cc"
        hex"0947fd53c5d8c7d58356145e1f8e0de43559fc1c39587b43271a2bccfbf6e06678aa655ef661ac34c79cf4814acfdec220dd0e735b46597a48915dc2177b5cd0"
        hex"c6e7e94fc7b0b68c597c70228dbd9ea4b94833a0fa2c5d3f56c270a09688a27348db5749d2536eb3e86aef82e59031d167ab98e6aa1d1d3cd3d3f45d8f4f5705"
        hex"afc6af9fcab2fabb9c4f26eeb5ead85ec2734cdfd14b2309a50dcc8467c5b3e012f9b71aca5a625f38ea4a7028a6ebf35bfaba07219bd0b5363c4906666b4723"
        hex"ad4c3afed529029be48a71aaa9c2d376bcac86bcb6926e4e149ce6f5f772f82dfa344f8ff4df71e8aa1eecb5502c4727c4f1fc2eb7eb3bb9eeab4bd588944123"
        hex"bf0ffbbae458163672a1b6c5adafde721496c882914edc409724827f7d549101d4acc377b03d51d6bfef4fd4b853b3ee1735889ff0729c2681621110e620fd7f"
        hex"05925358772aed8f90b7c9a13a1e3582316f55f8e294d1dc83301ea8b0ffd0623bae28d7db673fddad499b12caaa785dd814b55966117734aaf3a64d7680177d"
        hex"1935e123a97490bcee5b803aa140ded225fcdb71272679b0d1801a166a2e6dfe8766a456101ddffc13d0c0aaff3480050bf322067caa5ec54389815090fa6b43"
        hex"50fbd198b1f28741d7fb2917bac9b369be2345ffa81659a6a3abfdbd5ae347b627c428e1ec9557f6a97771769e9baef3083dcf27e485189e542863dfa30620ba"
        hex"1859bdfddab9b3334b99bbce554726a35e080db752c66d0798481375269d80db6a8e23db8ad4c059de8e193a8276eac8f24e59319c90fd4f1ee4c11afc325f3e"
        hex"8a66c3d547a814a05aa2965b2136d4e7a9b1c4410e40735ac9b78b3ead9708f1041c11eca8df31bf9ef92b7c1898a40d327684341fbed0e6e495241b6f6a283b"
        hex"328b87550b9c46fb93cfc9642bddd54fa21199090135ec916abf487955606f615aa8604c284adedcbee721ec2a751e8e1b15b3e0a0693cabd729cfdf9c610a26"
        hex"2387930588f6d8794126ccc837b3fc30fd47c4c2ea7e5826c7a71641aac666621d15f2d82f2865d9f8e87cf462765245048b5c22cc073dfb27136b99e9a20e89";

    PoseidonGoldilocks public immutable poseidon;
    bytes32 public immutable domain;
    bytes32 public immutable domainLeaf;

    uint64 public leafCount;
    bytes32 public currentRoot;
    mapping(bytes32 root => bool) public knownRoot;
    bytes32[TREE_DEPTH] private frontier;

    event LeafAppended(uint64 indexed index, bytes32 indexed commitment);
    event RootPublished(bytes32 indexed root, uint64 count);
    error NoteTreeFull();

    constructor(bytes32 domain_) {
        poseidon = new PoseidonGoldilocks();
        domain = domain_;
        bytes32 leaf = domain_;
        // Canonically sample four Goldilocks limbs, rather than truncating the domain to one limb.
        while (leaf == bytes32(0) || !Goldilocks.isCanonicalDigest(leaf)) {
            leaf = keccak256(abi.encode(leaf));
        }
        domainLeaf = leaf;
        bytes32 node = leaf;
        bytes memory empty = EMPTY_SUBTREES;
        for (uint256 level; level < TREE_DEPTH; ++level) {
            frontier[level] = node;
            node = poseidon.hash2(node, _zeroAt(empty, level));
        }
        emit LeafAppended(0, leaf);
        _publish(node, 1);
    }

    function _append(bytes32 first, bytes32 second, bool pair) internal returns (uint64 index) {
        index = leafCount;
        uint256 k = uint256(index);
        if (k + (pair ? 2 : 1) > MAX_LEAVES) revert NoteTreeFull();
        bytes32 node = first;
        emit LeafAppended(index, first);
        if (pair) {
            // Insert the left leaf into the frontier, then walk the right leaf to the root.
            uint256 level;
            for (uint256 path = k; path & 1 != 0; path >>= 1) {
                node = poseidon.hash2(frontier[level], node);
                ++level;
            }
            frontier[level] = node;
            ++k;
            node = second;
            emit LeafAppended(uint64(k), second);
        }
        uint256 p = k;
        bytes memory empty = EMPTY_SUBTREES;
        for (uint256 level; level < TREE_DEPTH; ++level) {
            if (p & 1 == 0) {
                frontier[level] = node;
                node = poseidon.hash2(node, _zeroAt(empty, level));
            } else {
                node = poseidon.hash2(frontier[level], node);
            }
            p >>= 1;
        }
        _publish(node, uint64(k + 1));
    }

    function _zeroAt(bytes memory empty, uint256 level) private pure returns (bytes32 z) {
        assembly ("memory-safe") { z := mload(add(add(empty, 32), mul(level, 32))) }
    }

    function _publish(bytes32 root, uint64 count) private {
        currentRoot = root;
        leafCount = count;
        // Do not expire a root while a wallet is computing a proof. Nullifiers never expire either.
        knownRoot[root] = true;
        emit RootPublished(root, count);
    }
}
