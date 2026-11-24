// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Only for local EVM tests and the demo. Never included in a custody build.
contract LabStakeToken {
    string public constant symbol = "LAB";
    uint8 public constant decimals = 18;
    address private immutable minter = msg.sender;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter);
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) internal virtual {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract LabTaxedToken is LabStakeToken {
    function _move(address from, address to, uint256 amount) internal override {
        super._move(from, to, amount);
        if (amount != 0) balanceOf[to] -= 1;
    }
}
