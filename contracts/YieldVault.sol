// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/YieldMath.sol";
import "./EIP7702Auth.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title YieldVault
 * @dev Vault sinh lãi cho người gửi tiền giữ lâu trong pool.
 *
 * Kết hợp với EIP-7702: ví EOA bình thường có thể tạm thời "mượn" code của
 * YieldVault để thực hiện deposit/withdraw/claim trong một transaction duy nhất,
 * không cần đổi địa chỉ ví.
 *
 * Kết hợp với AnonymousVault: user có thể nạp tiền ẩn danh vào AnonymousVault,
 * sau đó stake yToken vào YieldVault qua ephemeral account (EIP-7702) để giữ privacy.
 *
 * Luồng:
 *  1. User nạp token vào YieldVault, nhận yToken (giúp tính lãi).
 *  2. Lãi tính theo APR (basis points) và thời gian giữ.
 *  3. User có thể withdraw gốc + lãi, hoặc claim chỉ lãi.
 *  4. Hỗ trợ EIP-7702: EOA authorize code của YieldVault, rồi gọi deposit/withdraw
 *     thông qua ephemeral account.
 */
contract YieldVault is YieldMath, EIP7702Auth, Ownable, ReentrancyGuard {
    using YieldMath for *;

    // Token được nhận vào vault (ví dụ: DAI, ETH wrapper, NYX)
    address public immutable vaultAsset;
    // yToken ERC20 đại diện cho quyền sở hữu trong vault
    ERC20 public immutable yToken;

    // Tổng số tiền gốc đã deposit (không tính lãi)
    uint256 public totalAssets;
    // Tổng supply yToken
    uint256 public totalYSupply;

    // mapping(user => amount gốc đã deposit)
    mapping(address => uint256) public userDeposits;
    // mapping(user => thời điểm deposit cuối cùng (để tính lãi))
    mapping(address => uint256) public userLastUpdate;

    // APR trong basis points (ví dụ 500 = 5%)
    uint256 public aprBps;

    event Deposit(address indexed user, uint256 amount, uint256 yTokensMinted, uint256 timestamp);
    event Withdraw(address indexed user, uint256 amount, uint256 yTokensBurned, uint256 timestamp);
    event YieldClaimed(address indexed user, uint256 interest, uint256 timestamp);
    event APRUpdated(uint256 oldApr, uint256 newApr, uint256 timestamp);

    constructor(address _vaultAsset, address _yToken) {
        vaultAsset = _vaultAsset;
        yToken = ERC20(_yToken);
        owner = msg.sender;
        aprBps = 500; // mặc định 5% / năm
    }

    /**
     * @dev Deposit token vào vault. Nhận yToken tương ứng.
     *      Chỉ hỗ trợ native ETH (msg.value) hoặc ERC20 (vía approve trước).
     */
    function deposit(uint256 amount) external payable nonReentrant returns (uint256) {
        if (vaultAsset == address(0)) {
            // Native ETH
            require(msg.value == amount, "YV: msg.value must equal amount");
        } else {
            // ERC20: user phải approve trước
            require(ERC20(vaultAsset).transferFrom(msg.sender, address(this), amount), "YV: transferFrom failed");
        }

        uint256 interest = calculatePendingInterest(msg.sender);
        uint256 totalDeposit = userDeposits[msg.sender] + amount;

        // Cập nhật lại số tiền gốc và thời gian
        userDeposits[msg.sender] = totalDeposit;
        userLastUpdate[msg.sender] = block.timestamp;
        totalAssets += amount;

        // Mint yToken theo tỷ lệ hiện tại
        uint256 yTokensMinted = amountToYTokens(amount, totalYSupply, totalAssets - amount);
        totalYSupply += yTokensMinted;
        yToken.mint(msg.sender, yTokensMinted);

        emit Deposit(msg.sender, amount, yTokensMinted, block.timestamp);
        return yTokensMinted;
    }

    /**
     * @dev Withdraw gốc + lãi. Đốt yToken tương ứng.
     */
    function withdraw(uint256 yTokens) external nonReentrant returns (uint256) {
        require(yToken.balanceOf(msg.sender) >= yTokens, "YV: insufficient yToken balance");

        uint256 interest = calculatePendingInterest(msg.sender);
        uint256 underlyingAmount = yTokensToAmount(yTokens, totalYSupply, totalAssets + interest);

        require(underlyingAmount > 0, "YV: amount must be positive");
        require(totalAssets >= underlyingAmount, "YV: vault insufficient funds");

        // Cập nhật state
        userDeposits[msg.sender] -= underlyingAmount;
        userLastUpdate[msg.sender] = block.timestamp;
        totalAssets -= underlyingAmount;
        totalYSupply -= yTokens;

        yToken.burn(msg.sender, yTokens);

        // Gửi tiền về user
        if (vaultAsset == address(0)) {
            (bool success, ) = msg.sender.call{ value: underlyingAmount }("");
            require(success, "YV: ETH transfer failed");
        } else {
            require(ERC20(vaultAsset).transfer(msg.sender, underlyingAmount), "YV: token transfer failed");
        }

        emit Withdraw(msg.sender, underlyingAmount, yTokens, block.timestamp);
        return underlyingAmount;
    }

    /**
     * @dev Claim chỉ lãi (không withdraw gốc).
     */
    function claimYield() external nonReentrant returns (uint256) {
        uint256 interest = calculatePendingInterest(msg.sender);
        require(interest > 0, "YV: no yield to claim");

        // Cập nhật thời điểm để không tính lại lãi cũ
        userLastUpdate[msg.sender] = block.timestamp;

        // Gửi lãi về user (nếu vaultAsset là ERC20)
        if (vaultAsset != address(0)) {
            require(ERC20(vaultAsset).transfer(msg.sender, interest), "YV: yield transfer failed");
        }

        emit YieldClaimed(msg.sender, interest, block.timestamp);
        return interest;
    }

    /**
     * @dev Tính lãi pending cho user (không thay đổi state).
     */
    function calculatePendingInterest(address user) public view returns (uint256) {
        uint256 amount = userDeposits[user];
        if (amount == 0) return 0;
        uint256 lastUpdate = userLastUpdate[user];
        uint256 elapsed = block.timestamp > lastUpdate ? block.timestamp - lastUpdate : 0;
        return calculateInterest(amount, aprBps, elapsed);
    }

    /**
     * @dev Tính tổng giá trị (gốc + lãi) của user.
     */
    function getUserTotalValue(address user) public view returns (uint256) {
        return userDeposits[user] + calculatePendingInterest(user);
    }

    /**
     * @dev Cập nhật APR (chỉ owner).
     */
    function updateAPR(uint256 newAprBps) external onlyOwner {
        require(newAprBps <= 10000, "YV: APR too high");
        uint256 oldApr = aprBps;
        aprBps = newAprBps;
        emit APRUpdated(oldApr, newAprBps, block.timestamp);
    }

    /**
     * @dev Deposit qua EIP-7702 (ephemeral account).
     *      Hàm này được gọi khi EOA đã authorize code của YieldVault qua
     *      EIP-7702 authorization list, và transaction được gửi từ EOA đó.
     *      Trong thực tế, client tạo EIP-7702 tx với contract address này,
     *      ký, và gửi lên Ethereum (Pectra+).
     */
    function depositViaEIP7702(uint256 amount) external payable nonReentrant returns (uint256) {
        // Kiểm tra EOA có được authorize chạy code này hay không
        bytes32 expectedCodeHash = keccak256(abi.encodePacked(address(this)));
        require(
            isAuthorized(msg.sender, expectedCodeHash),
            "YV: EOA not authorized via EIP-7702"
        );
        return deposit(amount);
    }

    /**
     * @dev Withdraw qua EIP-7702.
     */
    function withdrawViaEIP7702(uint256 yTokens) external nonReentrant returns (uint256) {
        bytes32 expectedCodeHash = keccak256(abi.encodePacked(address(this)));
        require(
            isAuthorized(msg.sender, expectedCodeHash),
            "YV: EOA not authorized via EIP-7702"
        );
        return withdraw(yTokens);
    }

    /**
     * @dev Set vault asset (ERC20) - chỉ owner.
     */
    function setVaultAsset(address _asset) external onlyOwner {
        // Trong production, cần xử lý migration cẩn thận
        // Ở đây chỉ cho phép set lần đầu nếu chưa có
        require(vaultAsset == address(0), "YV: asset already set");
        // Không gán trực tiếp vì immutable, giữ nguyên
    }

    receive() external payable {}
    fallback() external payable {}
}
