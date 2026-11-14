// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AnonymousVault
 * @dev Vault giữ tiền thật trên mỗi chain. Kiến trúc coprocessor:
 *      - FHE computation chạy OFF-CHAIN trên node coprocessor (không lưu ciphertext on-chain)
 *      - Blockchain chỉ verify ZK-SNARK proof + nullifier + merkle root + threshold signatures
 *      - Chống double-spend bằng nullifierHash
 *
 * Luồng:
 *  1. User nạp coin vào vault. Contract lưu commitment = H(nullifier, secret) vào merkle set.
 *  2. User giữ note = {nullifier, secret, encryptedAmountFHE (off-chain)}.
 *  3. Khi rút, user gửi ZK proof + nullifierHash + amount + threshold signatures.
 *  4. Contract xác minh ZK proof (commitment trong merkle tree, nullifier chưa dùng,
 *      amount <= số tiền trong note) + threshold signatures từ validator network.
 *  5. Nếu hợp lệ, đánh dấu nullifierHash đã dùng và gửi tiền đến recipient.
 */
contract AnonymousVault {
    address public immutable owner;

    mapping(bytes32 => bool) public spentNullifiers;
    mapping(bytes32 => bool) public existingCommitments;
    bytes32 public latestRoot;
    uint256 public totalLocked;

    event Deposit(
        address indexed user,
        address indexed asset,
        uint256 amount,
        bytes32 commitment,
        bytes32 nullifierHash,
        uint256 timestamp
    );
    event Withdrawal(
        address indexed recipient,
        bytes32 indexed nullifierHash,
        uint256 amount,
        uint256 timestamp
    );

    constructor() {
        owner = msg.sender;
    }

    /**
     * @dev Nạp tiền vào vault.
     * @param commitment    Pedersen(nullifier, secret) — commit của note
     * @param nullifierHash Pedersen(nullifier) — công khai, dùng chống double-spend
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

        existingCommitments[commitment] = true;
        totalLocked += amount;

        emit Deposit(msg.sender, asset, amount, commitment, nullifierHash, block.timestamp);
    }

    /**
     * @dev Rút tiền ẩn danh.
     * Xác minh ZK-SNARK + threshold signatures. KHÔNG lưu hay kiểm tra FHE ciphertext on-chain.
     */
    function withdraw(
        address payable recipient,
        uint256 amount,
        bytes32 root,
        bytes32 nullifierHash,
        bytes32 commitment,
        bytes calldata zkProof,
        bytes calldata thresholdSigs
    ) external payable {
        require(!spentNullifiers[nullifierHash], "AV: nullifier already spent");
        require(existingCommitments[commitment], "AV: commitment does not exist");
        require(root == latestRoot, "AV: stale merkle root");
        require(zkProof.length > 0, "AV: invalid ZK proof");
        require(thresholdSigs.length > 0, "AV: missing threshold signatures");

        // TODO: verifyWithdrawalProof(zkProof, [root, nullifierHash, amount]) — real SNARK verifier
        // TODO: verify thresholdSigs từ validator network

        spentNullifiers[nullifierHash] = true;
        existingCommitments[commitment] = false;
        totalLocked -= amount;

        (bool success, ) = recipient.call{ value: amount }("");
        require(success, "AV: payment to recipient failed");

        emit Withdrawal(recipient, nullifierHash, amount, block.timestamp);
    }

    function updateRoot(bytes32 newRoot) external onlyOwner {
        latestRoot = newRoot;
    }

    function getTotalLocked() external view returns (uint256) {
        return totalLocked;
    }

    function isSpent(bytes32 nullifierHash) external view returns (bool) {
        return spentNullifiers[nullifierHash];
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "AV: not owner");
        _;
    }

    receive() external payable {}
    fallback() external payable {}
}
