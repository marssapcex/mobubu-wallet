// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library HcmtPolicy {
    uint256 internal constant PROJECT_SUPPLY = 1_000_000 * 1e18;
    uint256 internal constant LOCAL_SUPPLY = PROJECT_SUPPLY / 4;
    uint256 internal constant RELAY_BOND = 100 * 1e18;
    uint256 internal constant FEE_BPS = 25;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PERIOD = 30 days;

    function supported(uint256 chain) internal pure returns (bool) {
        return chain == 11155111 || chain == 97 || chain == 0xcd8690dc || chain == 998;
    }

    function fee(uint256 gross) internal pure returns (uint256) {
        // 25 / 10_000 exactly. No intermediate product/overflow and one floor in base units.
        return gross / (BPS / FEE_BPS);
    }
}
