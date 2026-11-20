// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Local fixture: observe rollback when a contract refuses a native payment.
contract PayoutSwitch {
    bool private refusing = true;
    function allowPayment() external { refusing = false; }
    receive() external payable { require(!refusing); }
}
