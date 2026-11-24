// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Fixed-supply HCMT. The only issuance is the constructor Transfer from zero.
/// No owner, minter, burn, upgrade hooks, or calls to external contracts.
contract HcmtToken {
    string public constant name = "hcmtrail";
    string public constant symbol = "HCMT";
    uint8 public constant decimals = 18;
    uint256 public constant totalSupply = 100_000e18;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InvalidAccount();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address initialHolder) {
        if (initialHolder == address(0) || initialHolder == address(this)) revert InvalidAccount();
        balanceOf[initialHolder] = totalSupply;
        emit Transfer(address(0), initialHolder, totalSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert InvalidAccount();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (amount > allowed) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (from == address(0) || to == address(0) || to == address(this)) revert InvalidAccount();
        uint256 balance = balanceOf[from];
        if (amount > balance) revert InsufficientBalance();
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
