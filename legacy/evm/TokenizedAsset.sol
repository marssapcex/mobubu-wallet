// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title TokenizedAsset
 * @dev Token hóa cổ phiếu / tài sản thực thế (RWA).
 *
 * Ví dụ: SP500Token đại diện cho chỉ số S&P 500.
 * Mỗi token = 1 đơn vị chỉ số (hoặc tỉ lệ cố định, ví dụ: 1 token = 0.01 SP500).
 *
 * Liên kết với Oracle giá (giả sử Chainlink AggregatorV3Interface, ở đây là mock interface).
 * Cho phép:
 *  1. Mint tokenized asset khi người dùng gửi collateral
 *  2. Redeem token để nhận lại collateral
 *  3. Giá trị token được cập nhật theo oracle giá
 *
 * Kết hợp với AnonymousVault: user có thể nạp tiền ẩn danh, rồi stake vào
 * TokenizedAsset qua ephemeral account (EIP-7702) để giữ privacy.
 */
contract TokenizedAsset is ERC20, Ownable, ReentrancyGuard {
    // Oracle interface (giả lập: trong production dùng AggregatorV3Interface)
    address public immutable priceOracle;
    // Tỷ lệ: 1 token = ratio / 1e18 đơn vị cổ phiếu thực
    uint256 public immutable tokenToAssetRatio;
    // Giá hiện tại của 1 đơn vị cổ phiếu (USD, 18 decimals)
    uint256 public priceUSD;

    // mapping(user => amount collateral đã gửi)
    mapping(address => uint256) public userCollateral;
    // Tổng collateral đã khóa
    uint256 public totalCollateral;

    event TokenMinted(address indexed user, uint256 amount, uint256 priceUSD, uint256 timestamp);
    event TokenRedeemed(address indexed user, uint256 amount, uint256 collateralReturned, uint256 timestamp);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice, uint256 timestamp);

    constructor(
        string memory name,
        string memory symbol,
        address _priceOracle,
        uint256 _tokenToAssetRatio
    ) ERC20(name, symbol) {
        priceOracle = _priceOracle;
        tokenToAssetRatio = _tokenToAssetRatio;
        priceUSD = 5000 * 1e18; // mặc định SP500 ~5000 USD
        owner = msg.sender;
    }

    /**
     * @dev Cập nhật giá từ oracle (chỉ owner hoặc oracle contract gọi).
     */
    function updatePrice(uint256 newPriceUSD) external onlyOwner {
        require(newPriceUSD > 0, "TA: price must be positive");
        uint256 oldPrice = priceUSD;
        priceUSD = newPriceUSD;
        emit PriceUpdated(oldPrice, newPriceUSD, block.timestamp);
    }

    /**
     * @dev Mint tokenized asset khi người dùng gửi collateral.
     *      amountTokens = collateralUSD / priceUSD * tokenToAssetRatio
     */
    function mint(uint256 amountTokens) external payable nonReentrant returns (uint256) {
        // Tính collateral cần thiết (USD)
        uint256 collateralUSD = (amountTokens * priceUSD) / tokenToAssetRatio;
        // Giả sử 1 ETH = 3000 USD (mock), trong production đọc từ ETH/USD oracle
        uint256 ethPriceUSD = 3000 * 1e18;
        uint256 collateralNeeded = (collateralUSD * 1e18) / ethPriceUSD;

        if (msg.value < collateralNeeded) {
            revert("TA: insufficient ETH collateral");
        }

        userCollateral[msg.sender] += collateralNeeded;
        totalCollateral += collateralNeeded;

        _mint(msg.sender, amountTokens);

        emit TokenMinted(msg.sender, amountTokens, priceUSD, block.timestamp);
        return amountTokens;
    }

    /**
     * @dev Redeem token để nhận lại collateral (ETH).
     *      collateralReturned = amountTokens * priceUSD / tokenToAssetRatio (đổi sang ETH)
     */
    function redeem(uint256 amountTokens) external nonReentrant returns (uint256) {
        require(amountTokens > 0, "TA: amount must be positive");
        require(_balances[msg.sender] >= amountTokens, "TA: insufficient token balance");

        uint256 collateralUSD = (amountTokens * priceUSD) / tokenToAssetRatio;
        uint256 ethPriceUSD = 3000 * 1e18;
        uint256 collateralReturned = (collateralUSD * 1e18) / ethPriceUSD;

        require(userCollateral[msg.sender] >= collateralReturned, "TA: insufficient collateral");
        userCollateral[msg.sender] -= collateralReturned;
        totalCollateral -= collateralReturned;

        _burn(msg.sender, amountTokens);

        (bool success, ) = msg.sender.call{ value: collateralReturned }("");
        require(success, "TA: ETH transfer failed");

        emit TokenRedeemed(msg.sender, amountTokens, collateralReturned, block.timestamp);
        return collateralReturned;
    }

    /**
     * @dev Tính giá trị USD của một lượng token.
     */
    function tokenValueUSD(uint256 amountTokens) public view returns (uint256) {
        return (amountTokens * priceUSD) / tokenToAssetRatio;
    }

    /**
     * @dev Tính số token có thể mint với một lượng collateral.
     */
    function tokensForCollateral(uint256 collateralWei) public view returns (uint256) {
        uint256 ethPriceUSD = 3000 * 1e18;
        uint256 collateralUSD = (collateralWei * ethPriceUSD) / 1e18;
        return (collateralUSD * tokenToAssetRatio) / priceUSD;
    }
}
