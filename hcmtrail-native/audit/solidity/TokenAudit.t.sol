// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TokenCampaign, TokenActor} from "./TokenCampaign.sol";
import {HcmtToken} from "../../contracts/ethereum/HcmtToken.sol";

interface TokenAuditVm {
    function assume(bool) external;
}

contract TokenVolumeTest {
    TokenCampaign private model;
    function setUp() public { model = new TokenCampaign(); }

    function testFuzz_TransferApproveDelegated(uint256 seed) public {
        for (uint256 i; i < 16; ++i) {
            model.step(seed);
            seed = uint256(keccak256(abi.encode(seed, i)));
        }
    }
}

contract HcmtSymbolicTest {
    TokenAuditVm private constant vm = TokenAuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    HcmtToken private coin;
    TokenActor private actor;
    function setUp() public {
        coin = new HcmtToken(address(this));
        actor = new TokenActor();
    }

    function check_roundTrip(uint96 sent, uint96 returned) external {
        uint256 supply = coin.totalSupply();
        vm.assume(sent <= supply && returned <= sent);
        assert(coin.transfer(address(actor), sent));
        actor.sendToken(coin, address(this), returned);
        assert(coin.balanceOf(address(actor)) == uint256(sent) - returned);
        assert(coin.balanceOf(address(this)) == supply - sent + returned);
        assert(coin.totalSupply() == supply);
    }

    function check_selfTransferPreservesSupply(uint96 amount) external {
        uint256 supply = coin.totalSupply();
        vm.assume(amount <= supply);
        assert(coin.transfer(address(this), amount));
        assert(coin.balanceOf(address(this)) == supply);
    }

    function check_earnedAllowanceOnly(uint96 limit, uint96 amount) external {
        uint256 supply = coin.totalSupply();
        vm.assume(amount <= supply && amount <= limit);
        assert(coin.approve(address(actor), limit));
        actor.delegated(coin, address(this), address(actor), amount);
        assert(coin.balanceOf(address(actor)) == amount);
        assert(coin.balanceOf(address(this)) == supply - amount);
        assert(coin.allowance(address(this), address(actor)) == uint256(limit) - amount);
    }
}
