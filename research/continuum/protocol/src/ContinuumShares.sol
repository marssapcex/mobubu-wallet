// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "./token/ERC20.sol";

/// @title ContinuumShares — the lenders' claim on one Continuum market
/// @notice A plain ERC20 whose supply is controlled by its market. Shares are
///         transferable, so a lender's position is composable, but only the
///         market can mint or burn: the price per share is `assets() / supply`,
///         and `assets()` lives in the market, not here. Keeping the two apart
///         means a share transfer can never move the pool's accounting.
contract ContinuumShares is ERC20 {
    address public immutable market;

    error OnlyMarket();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address market_)
        ERC20(name_, symbol_, decimals_)
    {
        market = market_;
    }

    modifier onlyMarket() {
        if (msg.sender != market) revert OnlyMarket();
        _;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMarket {
        _burn(from, amount);
    }
}
