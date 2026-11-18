// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Aave v4 surface used by the Continuum buffer
/// @notice Declaration-only mirror of the parts of `aave/aave-v4` that the buffer
///         touches. Signatures and struct member order are taken verbatim from
///         `src/spoke/interfaces/ISpoke.sol` at commit `main` (audited 2026-11-11):
///           - `struct UserAccountData`      : ISpoke.sol:129-137
///           - `supply(uint256,uint256,address)` : ISpoke.sol:488
///           - `repay(uint256,uint256,address)`  : ISpoke.sol:535
///           - `liquidationCall(uint256,uint256,address,uint256,bool)` : ISpoke.sol:551
///           - `getUserAccountData(address)` : ISpoke.sol:745
///         No BUSL code is copied: Aave v4 is BUSL-1.1, so the buffer integrates
///         through this interface at arm's length rather than forking the Spoke.
interface ISpoke {
    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);

    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);

    function liquidationCall(
        uint256 collateralReserveId,
        uint256 debtReserveId,
        address user,
        uint256 debtToCover,
        bool receiveShares
    ) external;

    function getUserAccountData(address user) external view returns (UserAccountData memory);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);

    function transferFrom(address, address, uint256) external returns (bool);

    function transfer(address, uint256) external returns (bool);

    function approve(address, uint256) external returns (bool);
}
