// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);

    function transfer(address, uint256) external returns (bool);

    function transferFrom(address, address, uint256) external returns (bool);

    function approve(address, uint256) external returns (bool);

    function decimals() external view returns (uint8);
}

/// @title SafeTransferLib — token movement that cannot silently fail
/// @notice Four rules, all of them enforced here rather than trusted:
///         1. a `false` return is a revert (USDT-style tokens return nothing;
///            we require either empty returndata or `true`);
///         2. the balance delta must equal the requested amount, so a
///            fee-on-transfer token cannot quietly under-fund the pool;
///         3. `safeApprove` sets 0 first, so a non-standard allowance that
///            requires zeroing cannot wedge a reserve;
///         4. no low-level `call` is exposed to callers — the library is
///            `internal`, so it is inlined into the market only.
library SafeTransferLib {
    error TransferFailed();
    error TransferFromFailed();
    error ApproveFailed();
    error FeeOnTransfer(uint256 requested, uint256 received);

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        if (!_call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)))) revert TransferFailed();
    }

    /// @dev verifies the recipient's balance grew by exactly `amount`
    function safeTransferIn(IERC20 token, address from, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        if (!_call(address(token), abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)))) {
            revert TransferFromFailed();
        }
        uint256 afterBal = token.balanceOf(address(this));
        if (afterBal != before + amount) revert FeeOnTransfer(amount, afterBal - before);
    }

    function safeApprove(IERC20 token, address spender, uint256 amount) internal {
        if (!_call(address(token), abi.encodeCall(IERC20.approve, (spender, 0)))) revert ApproveFailed();
        if (amount > 0 && !_call(address(token), abi.encodeCall(IERC20.approve, (spender, amount)))) {
            revert ApproveFailed();
        }
    }

    function _call(address target, bytes memory data) private returns (bool ok) {
        (bool success, bytes memory ret) = target.call(data);
        if (!success) return false;
        return ret.length == 0 || abi.decode(ret, (bool));
    }
}
