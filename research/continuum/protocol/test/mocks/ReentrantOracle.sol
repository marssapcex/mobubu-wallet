// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracle} from "../../src/oracle/Oracles.sol";

/// @title ReentrantOracle — a feed that tries to execute market code mid-accrual
/// @notice The defence is in the ABI, not in a modifier: `IOracle.price()` is
///         declared `view`, so Solidity calls the oracle with STATICCALL. A
///         state-changing payload therefore reverts inside that static context
///         and `_materialise` continues with a failed inner call.
///
///         `armed` cannot be cleared here (a view cannot write), so the callback
///         is attempted on every price read. `lastAttemptOk` is a pure function
///         of the last attempt for off-chain observers; the real assertion is in
///         `verify/attack.cjs`: the market's state must be unchanged afterwards.
contract ReentrantOracle is IOracle {
    uint256 public priceValue = 2000e18;
    address public target;
    bytes public payload;
    bool public armed;

    function setPrice(uint256 p) external {
        priceValue = p;
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function price() external view returns (uint256) {
        if (armed) {
            // staticcall: any state change inside `payload` reverts, and the
            // failure is swallowed exactly as `_materialise` would see it
            target.staticcall(payload);
        }
        return priceValue;
    }
}
