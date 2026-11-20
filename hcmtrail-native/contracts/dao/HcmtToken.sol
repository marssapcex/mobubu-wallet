// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HcmtPolicy} from "./HcmtPolicy.sol";

/// @notice Fixed local genesis shard for one of the four testnets. No mint/burn/owner/upgrade path.
/// The four canonical testnet shards sum to PROJECT_SUPPLY; there is no bridge or portable balance.
contract HcmtToken {
    string public constant name = "HCMTrail";
    string public constant symbol = "HCMT";
    uint8 public constant decimals = 18;
    uint256 public constant PROJECT_SUPPLY = HcmtPolicy.PROJECT_SUPPLY;
    uint256 public constant totalSupply = HcmtPolicy.LOCAL_SUPPLY;

    // Constructor-only storage keeps the deployed runtime hash independently pinnable.
    uint256 public homeChainId;
    address public genesisHolder;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    error WrongChain();
    error InvalidAccount();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address holder) {
        if (!HcmtPolicy.supported(block.chainid)) revert WrongChain();
        if (holder == address(0) || holder == address(this)) revert InvalidAccount();
        homeChainId = block.chainid;
        genesisHolder = holder;
        balanceOf[holder] = totalSupply;
        emit Transfer(address(0), holder, totalSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert InvalidAccount();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) {
            if (permitted < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = permitted - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        if (from == address(0) || to == address(0) || to == address(this)) revert InvalidAccount();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
