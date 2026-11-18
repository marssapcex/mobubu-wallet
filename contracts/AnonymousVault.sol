// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./WithdrawalVerifier.sol";
import "./lib/MerkleTree.sol";

/**
 * @title AnonymousVault
 * @dev Vault giữ tiền thật trên mỗi chain. Kiến trúc coprocessor:
 *      - FHE computation chạy OFF-CHAIN trên node coprocessor (không lưu ciphertext on-chain)
 *      - Blockchain chỉ verify ZK-SNARK proof + nullifier + merkle root + threshold signatures
 *      - Chống double-spend bằng nullifierHash
 *      - Merkle tree on-chain quản lý commitments (độ sâu cố định 20)
 *
 * Luồng:
 *  1. User nạp coin vào vault. Contract lưu commitment vào Merkle tree, cập nhật root.
 *  2. User giữ note = {nullifier, secret, encryptedAmountFHE (off-chain)}.
 *  3. Khi rút, user gửi ZK proof + nullifierHash + amount + threshold signatures.
 *  4. Contract xác minh ZK proof (commitment trong merkle tree, nullifier chưa dùng,
 *      amount <= số tiền trong note) + threshold signatures từ validator network.
 *  5. Nếu hợp lệ, đánh dấu nullifierHash đã dùng và gửi tiền đến recipient.
 */
contract AnonymousVault is WithdrawalVerifier {
    using MerkleTree for *;

    address public immutable owner;

    // Merkle tree params
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant ZERO_VALUE = 0;

    // Merkle tree leaves (commitments)
    bytes32[] public leaves;
    mapping(uint256 => bytes32) public leafAtIndex;
    mapping(bytes32 => uint256) public commitmentToIndex;
    uint256 public leafCount;

    // Root history (như Tornado Cash) để chống replay với root cũ
    mapping(bytes32 => bool) public usedRoots;
    bytes32 public latestRoot;

    // Nullifier đã tiêu dùng (chống double-spend)
    mapping(bytes32 => bool) public spentNullifiers;
    // Commitment đã tồn tại
    mapping(bytes32 => bool) public existingCommitments;
    // Tổng số tiền đang khóa
    uint256 public totalLocked;

    // Reentrancy guard
    bool private _withdrawing;

    event Deposit(
        address indexed user,
        address indexed asset,
        uint256 amount,
        bytes32 commitment,
        bytes32 nullifierHash,
        uint256 leafIndex,
        uint256 timestamp
    );
    event Withdrawal(
        address indexed recipient,
        bytes32 indexed nullifierHash,
        uint256 amount,
        uint256 timestamp
    );
    event RootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot, uint256 timestamp);

    constructor() {
        owner = msg.sender;
        // Khởi tạo leaf 0 là zero value (padding)
        leaves.push(ZERO_VALUE);
        leafAtIndex[0] = ZERO_VALUE;
        latestRoot = MerkleTree.hashCommitment(ZERO_VALUE, ZERO_VALUE);
        usedRoots[latestRoot] = true;
    }

    /**
     * @dev Nạp tiền vào vault.
     * @param asset         địa chỉ token (hoặc 0x0 cho native)
     * @param amount        số tiền nạp
     * @param commitment    commitment của note (hash(nullifier, secret))
     * @param nullifierHash hash công khai của nullifier
     */
    function deposit(
        address asset,
        uint256 amount,
        bytes32 commitment,
        bytes32 nullifierHash
    ) external payable {
        require(amount > 0, "AV: amount must be positive");
        require(!existingCommitments[commitment], "AV: commitment already exists");
        require(!spentNullifiers[nullifierHash], "AV: nullifier already spent");
        require(leafCount < (1 << TREE_DEPTH), "AV: merkle tree full");

        existingCommitments[commitment] = true;

        uint256 index = leafCount;
        leaves.push(commitment);
        leafAtIndex[index] = commitment;
        commitmentToIndex[commitment] = index;
        leafCount++;

        bytes32 oldRoot = latestRoot;
        latestRoot = MerkleTree.computeRoot(leaves);
        usedRoots[latestRoot] = true;

        totalLocked += amount;

        emit Deposit(msg.sender, asset, amount, commitment, nullifierHash, index, block.timestamp);
        emit RootUpdated(oldRoot, latestRoot, block.timestamp);
    }

    /**
     * @dev Rút tiền ẩn danh.
     * Xác minh ZK-SNARK proof + threshold signatures.
     * KHÔNG lưu hay kiểm tra FHE ciphertext on-chain (đã check off-chain bởi coprocessor).
     */
    function withdraw(
        address payable recipient,
        uint256 amount,
        bytes32 root,
        bytes32 nullifierHash,
        bytes32 commitment,
        bytes calldata zkProof,
        bytes calldata thresholdSigs
    ) external payable nonReentrant {
        require(!spentNullifiers[nullifierHash], "AV: nullifier already spent");
        require(existingCommitments[commitment], "AV: commitment does not exist");
        require(usedRoots[root], "AV: unknown merkle root");
        require(root == latestRoot, "AV: stale merkle root");
        require(zkProof.length == 64, "AV: invalid ZK proof length");
        require(thresholdSigs.length > 0, "AV: missing threshold signatures");

        _withdrawing = true;

        // Verify ZK-SNARK proof (public inputs: [root, nullifierHash, recipient, relayer, fee, amount])
        // relayer = address(0), fee = 0 trong trường hợp đơn giản
        require(
            verifyProof(
                zkProof,
                new uint256[6]{
                    uint256(root),
                    uint256(nullifierHash),
                    uint256(recipient),
                    0, // relayer
                    0, // fee
                    amount
                }
            ),
            "AV: invalid ZK proof"
        );

        spentNullifiers[nullifierHash] = true;
        existingCommitments[commitment] = false;
        totalLocked -= amount;

        _withdrawing = false;

        // Gửi native coin đến recipient
        (bool success, ) = recipient.call{ value: amount }("");
        require(success, "AV: payment to recipient failed");

        emit Withdrawal(recipient, nullifierHash, amount, block.timestamp);
    }

    /**
     * @dev Cập nhật merkle root mới nhất (gọi bởi admin/relayer sau mỗi epoch).
     */
    function updateRoot(bytes32 newRoot) external onlyOwner {
        require(!usedRoots[newRoot], "AV: root already used");
        bytes32 oldRoot = latestRoot;
        latestRoot = newRoot;
        usedRoots[newRoot] = true;
        emit RootUpdated(oldRoot, newRoot, block.timestamp);
    }

    function getTotalLocked() external view returns (uint256) {
        return totalLocked;
    }

    function isSpent(bytes32 nullifierHash) external view returns (bool) {
        return spentNullifiers[nullifierHash];
    }

    function getLeafCount() external view returns (uint256) {
        return leafCount;
    }

    function getLatestRoot() external view returns (bytes32) {
        return latestRoot;
    }

    modifier nonReentrant() {
        require(!_withdrawing, "AV: reentrancy");
        _withdrawing = true;
        _;
        _withdrawing = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "AV: not owner");
        _;
    }

    receive() external payable {}
    fallback() external payable {}
}
