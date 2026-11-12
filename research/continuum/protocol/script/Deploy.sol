// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ContinuumMarket} from "../src/ContinuumMarket.sol";
import {IOracle} from "../src/oracle/Oracles.sol";
import {IERC20} from "../src/lib/SafeTransferLib.sol";

/// @title The deploy script, as a contract
/// @notice Reads as a parameter file. Every value here is a *choice* that a
///         deployment review must justify; none of them is a constant of the
///         mechanism.
///
///            c         1.02     the pool buys collateral at a 2% discount
///            target    1.20     the flow switches on at 83.3% LTV
///            k         365      a full gap closes in a year
///            rhoCap    0.10     10%/yr, the ceiling the law may clear at
///            eta       0.02     gain per update, capped at half a bucket
///            minBid    0.01     1%/yr floor, and the floor on rho
///            idleFloor 0.20     20% of debt must stay idle: the flow's fuel
///
///         Deploy order matters: oracle first, then the market, then caps, then
///         the risk admin handover to a timelock.
contract Deploy {
    struct Config {
        address collateralToken;
        address debtToken;
        address oracle;
        string shareName;
        string shareSymbol;
        uint256 depositCap;
        uint256 borrowCap;
    }

    event MarketDeployed(address market, address shares);

    function deploy(Config memory cfg) external returns (ContinuumMarket market) {
        ContinuumMarket.Params memory q = ContinuumMarket.Params({
            collateralToken: IERC20(cfg.collateralToken),
            debtToken: IERC20(cfg.debtToken),
            oracle: IOracle(cfg.oracle),
            c: 1.02e18,
            target: 1.20e18,
            k: 365e18,
            rhoCap: 0.10e18,
            eta: 0.02e18,
            minBid: 0.01e18,
            idleFloor: 0.20e18,
            shareName: cfg.shareName,
            shareSymbol: cfg.shareSymbol
        });

        market = new ContinuumMarket(q);
        market.setRiskParams(cfg.depositCap, cfg.borrowCap, false);
        emit MarketDeployed(address(market), address(market.shares()));
    }
}
