// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";

contract TokenActor {
    function sendToken(HcmtToken coin, address to, uint256 amount) external {
        assert(coin.transfer(to, amount));
    }
    function authorize(HcmtToken coin, address spender, uint256 amount) external {
        assert(coin.approve(spender, amount));
    }
    function delegated(HcmtToken coin, address from, address to, uint256 amount) external {
        assert(coin.transferFrom(from, to, amount));
    }
}

/// Test-only closed-universe accounting. Each step executes exactly 3 ERC-20
/// calls (transfer, approve, transferFrom), and compares against a separate ledger.
contract TokenCampaign {
    uint256 private constant SUPPLY = 100_000 ether;
    HcmtToken internal immutable coin;
    TokenActor[3] private actors;
    uint256[3] private expected;

    constructor() {
        coin = new HcmtToken(address(this));
        for (uint256 i; i < 3; ++i) {
            actors[i] = new TokenActor();
            expected[i] = i == 2 ? 40_000 ether : 30_000 ether;
            assert(coin.transfer(address(actors[i]), expected[i]));
        }
    }

    function step(uint256 seed) external {
        uint256 from = (seed >> 240) % 3;
        uint256 to = (seed >> 224) % 3;
        uint256 operator = (seed >> 208) % 3;
        uint256 amount = uint104(seed) % (expected[from] + 1);
        actors[from].sendToken(coin, address(actors[to]), amount);
        expected[from] -= amount;
        expected[to] += amount;

        uint256 delegated = uint104(seed >> 104) % (expected[to] + 1);
        uint256 limit = seed & 1 == 0 ? delegated : type(uint256).max;
        actors[to].authorize(coin, address(actors[operator]), limit);
        actors[operator].delegated(coin, address(actors[to]), address(actors[from]), delegated);
        expected[to] -= delegated;
        expected[from] += delegated;
        assert(coin.allowance(address(actors[to]), address(actors[operator])) == (limit == type(uint256).max ? limit : 0));
        assert(echidna_hcmt_matches_model());
    }

    function echidna_hcmt_matches_model() public view returns (bool) {
        if (coin.totalSupply() != SUPPLY || coin.balanceOf(address(0)) != 0 || coin.balanceOf(address(coin)) != 0) return false;
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            uint256 actual = coin.balanceOf(address(actors[i]));
            if (actual != expected[i]) return false;
            sum += actual;
        }
        return sum == SUPPLY;
    }
}
