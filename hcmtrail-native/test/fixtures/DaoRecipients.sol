// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ILocalDao {
    function stake(uint256 amount) external;
    function claim(uint64[] calldata periods) external returns (uint256);
}

interface ILocalToken {
    function approve(address who, uint256 amount) external returns (bool);
}

/// Local test fixture: observe atomic rollback when a contract refuses a native payment.
contract PayoutSwitch {
    bool private refusing = true;
    function allowPayment() external { refusing = false; }
    function stake(ILocalToken token, ILocalDao treasury, uint256 amount) external {
        require(token.approve(address(treasury), amount));
        treasury.stake(amount);
    }
    function claim(ILocalDao treasury, uint64[] calldata periods) external {
        treasury.claim(periods);
    }
    receive() external payable { require(!refusing); }
}
