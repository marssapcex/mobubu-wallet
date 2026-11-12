// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AaveV4Math} from "../AaveV4Math.sol";
import {IERC20Min} from "../AaveV4.sol";

/// @title MockERC20 — minimal token with mint, for the buffer fixtures
contract MockERC20 is IERC20Min {
    string public name;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, uint8 d) {
        name = n;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal");
        if (f != msg.sender) {
            uint256 al = allowance[f][msg.sender];
            require(al >= a, "allow");
            allowance[f][msg.sender] = al - a;
        }
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @title MockAaveV4Spoke — a Spoke stub that keeps Aave v4's *decisions*
/// @notice Implements the four `ISpoke` entry points the buffer touches, with
///         the health-factor gate, the bonus ramp and the target-HF sizing taken
///         from `aave/aave-v4` `LiquidationLogic.sol`. It exists so the buffer
///         can be measured against the real liquidation cost without deploying
///         BUSL source; it is *not* a re-implementation of the Spoke's
///         accounting (no indexes, no reserve state, no isolation modes).
contract MockAaveV4Spoke {
    using AaveV4Math for uint256;

    struct Reserve {
        MockERC20 asset;
        uint256 priceWad;
        uint256 unit;
        uint256 collateralFactor; // bps
        bool enabledAsCollateral;
    }

    struct Position {
        uint256 collUnits; // units of the collateral reserve
        uint256 debtUnits; // units of the debt reserve
    }

    address public immutable oracleAdmin;
    mapping(uint256 => Reserve) public reserves;
    mapping(address => Position) public positions;

    // Aave v4 dynamic-liquidation config, same field set as
    // `struct LiquidationConfig { targetHealthFactor; healthFactorForMaxBonus;
    //  liquidationBonusFactor; }` plus the reserve's max bonus.
    uint256 public targetHealthFactor = 1.5e18;
    uint256 public healthFactorForMaxBonus = 0.95e18;
    uint256 public liquidationBonusFactor = 5_000; // bps of (max-1e18)
    uint256 public maxLiquidationBonus = 11_500; // 15% at the cap (bps)

    uint256 public liquidatedDebt; // for the A/B report
    uint256 public liquidatedCollValue;

    event Liquidated(address indexed user, address liquidator, uint256 debtCovered, uint256 collSeized, uint256 bonusBps);

    constructor(address admin_) {
        oracleAdmin = admin_;
    }

    function setReserve(uint256 id, MockERC20 asset, uint256 priceWad, uint256 unit, uint256 cfBps) external {
        require(msg.sender == oracleAdmin, "admin");
        reserves[id] = Reserve(asset, priceWad, unit, cfBps, true);
    }

    function setPrice(uint256 id, uint256 priceWad) external {
        require(msg.sender == oracleAdmin, "admin");
        reserves[id].priceWad = priceWad;
    }

    function setLiquidationConfig(uint256 target, uint256 hfMax, uint256 factor, uint256 maxBonus) external {
        require(msg.sender == oracleAdmin, "admin");
        require(target >= 1e18 && maxBonus > 10_000, "cfg");
        targetHealthFactor = target;
        healthFactorForMaxBonus = hfMax;
        liquidationBonusFactor = factor;
        maxLiquidationBonus = maxBonus;
    }

    // ------------------------------------------------------------------ views
    function _collValue(uint256 id, uint256 units) internal view returns (uint256) {
        Reserve memory r = reserves[id];
        return (units * r.priceWad) / r.unit;
    }

    function getUserAccountData(address user) external view returns (ISpokeData memory d) {
        Position memory p = positions[user];
        uint256 cv = _collValue(1, p.collUnits);
        uint256 dv = _collValue(2, p.debtUnits); // WAD
        d.totalCollateralValue = cv;
        d.totalDebtValueRay = dv * 1e9;
        d.avgCollateralFactor = reserves[1].collateralFactor * 1e14; // bps -> WAD
        d.healthFactor = dv == 0 ? type(uint256).max : (cv * reserves[1].collateralFactor * 1e18) / (10_000 * dv);
        d.activeCollateralCount = p.collUnits > 0 ? 1 : 0;
        d.borrowCount = p.debtUnits > 0 ? 1 : 0;
    }

    struct ISpokeData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    // ------------------------------------------------------------------ verbs
    function supplyCollateral(uint256 units) external {
        require(msg.sender == oracleAdmin, "admin"); // fixture only
    }

    function setPosition(address user, uint256 collUnits, uint256 debtUnits) external {
        require(msg.sender == oracleAdmin, "admin");
        positions[user] = Position(collUnits, debtUnits);
    }

    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256) {
        require(reserveId == 2, "reserve");
        Reserve memory r = reserves[2];
        uint256 owed = positions[onBehalfOf].debtUnits;
        uint256 units = amount > owed ? owed : amount;
        require(r.asset.transferFrom(msg.sender, address(this), units), "pull");
        positions[onBehalfOf].debtUnits = owed - units;
        return (units, units);
    }

    function liquidate(address user, uint256 debtToCoverUnits) external returns (uint256 covered, uint256 seizedValue) {
        Position storage p = positions[user];
        (uint256 hf,,,,,,) = _acct(user);
        require(hf < 1e18, "HF not below 1: no event");
        require(p.debtUnits > 0 && p.collUnits > 0, "empty");
        if (debtToCoverUnits == 0 || debtToCoverUnits > p.debtUnits) debtToCoverUnits = p.debtUnits;

        uint256 bonusBps = AaveV4Math.calculateLiquidationBonus(
            healthFactorForMaxBonus, liquidationBonusFactor, hf, maxLiquidationBonus
        );
        uint256 debtValue = _collValue(2, debtToCoverUnits);
        uint256 seizeValue = (debtValue * bonusBps) / 10_000;
        uint256 seizeUnits = (seizeValue * reserves[1].unit) / reserves[1].priceWad;
        if (seizeUnits > p.collUnits) {
            seizeUnits = p.collUnits;
            seizeValue = _collValue(1, seizeUnits);
        }
        require(reserves[2].asset.transferFrom(msg.sender, address(this), debtToCoverUnits), "pull debt");
        reserves[1].asset.transfer(msg.sender, seizeUnits);
        p.debtUnits -= debtToCoverUnits;
        p.collUnits -= seizeUnits;
        liquidatedDebt += debtToCoverUnits;
        liquidatedCollValue += seizeValue;
        emit Liquidated(user, msg.sender, debtToCoverUnits, seizeUnits, bonusBps);
        return (debtToCoverUnits, seizeValue);
    }

    function _acct(address user)
        internal
        view
        returns (uint256 hf, uint256 cv, uint256 dv, uint256 cfBps, uint256 cu, uint256 du, uint256 pad)
    {
        Position memory p = positions[user];
        cv = _collValue(1, p.collUnits);
        dv = _collValue(2, p.debtUnits);
        cfBps = reserves[1].collateralFactor;
        cu = p.collUnits;
        du = p.debtUnits;
        pad = 0;
        hf = dv == 0 ? type(uint256).max : (cv * cfBps * 1e18) / (10_000 * dv);
    }

    /// @notice What Aave would charge, for the same deleverage target.
    function quoteLiquidation(uint256 debtToCoverUnits, uint256 hf) external view returns (uint256 seizeValue) {
        uint256 bonusBps =
            AaveV4Math.calculateLiquidationBonus(healthFactorForMaxBonus, liquidationBonusFactor, hf, maxLiquidationBonus);
        return (_collValue(2, debtToCoverUnits) * bonusBps) / 10_000;
    }
}

/// @title MockPriceWad — a debt-asset price of 1.0 by default
contract MockPriceWad {
    uint256 public priceWad = 1e18;

    function set(uint256 p) external {
        priceWad = p;
    }
}
